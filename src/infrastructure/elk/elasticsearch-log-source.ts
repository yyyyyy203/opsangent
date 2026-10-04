import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type AgentErrorCode,
  type NormalizedLogRecord,
} from '../../contracts/index.js';
import { SourceFailure } from '../../mcp/resilience.js';
import {
  logsPageWireResultSchema,
  logsSearchPageInput,
  type LogsPageBackend,
  type LogsPageWireResult,
  type LogsSearchPageInput,
} from '../../mcp/logs-protocol.js';
import { validateLogsScope, logsLabQueryPolicy } from '../../profiles/logs.js';
import { redactLogRecord } from '../../contracts/log-redaction.js';
import { ElasticsearchHttp } from './elasticsearch-http.js';
import { LogSnapshotRegistry, type LogSnapshotSession } from './log-snapshot-registry.js';

const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_PAGE_SIZE = 32;
const PIT_KEEP_ALIVE = '2m';
const CLEANUP_TIMEOUT_MS = 1_000;
const ALLOWED_SOURCE_FIELDS = new Set(['timestamp', 'service', 'level', 'message', 'exception', 'traceId', 'fields']);

export interface ElasticsearchLogSourceOptions {
  url: string;
  index: string;
  cursorSecret: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  id?: () => string;
  maxSessions?: number;
  pageSize?: number;
  onCleanupFailure: (failure: { code: AgentErrorCode; sourceSnapshotId?: string }) => void;
}

export function createElasticsearchLogSource(_options: ElasticsearchLogSourceOptions): LogsPageBackend {
  return new ElasticsearchLogSource(_options);
}

class ElasticsearchLogSource implements LogsPageBackend {
  private readonly http: ElasticsearchHttp;
  private readonly registry: LogSnapshotRegistry;
  private readonly now: () => number;
  private readonly index: string;
  private readonly pageSize: number;
  private readonly onCleanupFailure: ElasticsearchLogSourceOptions['onCleanupFailure'];
  private readonly locks = new Map<string, Promise<void>>();
  private stopped = false;

  public constructor(options: ElasticsearchLogSourceOptions) {
    if (!isValidIndex(options.index)) throw new TypeError('Invalid Elasticsearch index');
    this.now = options.now ?? Date.now;
    this.index = options.index;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (typeof options.onCleanupFailure !== 'function') {
      throw new TypeError('Elasticsearch log source requires a cleanup failure reporter');
    }
    this.onCleanupFailure = options.onCleanupFailure;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > DEFAULT_PAGE_SIZE) {
      throw new RangeError('pageSize must be between 1 and 32');
    }
    this.http = new ElasticsearchHttp({ url: options.url, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    this.registry = new LogSnapshotRegistry({
      cursorSecret: options.cursorSecret,
      now: this.now,
      ...(options.id === undefined ? {} : { id: options.id }),
      maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
    });
  }

  public async searchPage(input: LogsSearchPageInput, signal: AbortSignal): Promise<LogsPageWireResult> {
    if (this.stopped) return sourceError('UNAVAILABLE', 'source_unavailable');
    const parsed = logsSearchPageInput.safeParse(input);
    if (!parsed.success) return sourceError('INVALID_INPUT');
    try {
      validateLogsScope(parsed.data, logsLabQueryPolicy, this.now());
    } catch {
      return sourceError('POLICY_DENIED', 'scope_denied');
    }

    const queryDigest = digestQuery(parsed.data);
    const lockKey = parsed.data.cursor === undefined
      ? `request:${parsed.data.requestId}`
      : `snapshot:${parsed.data.sourceSnapshotId}`;
    await this.closeExpiredSessions();
    return this.withLock(lockKey, async () => {
      try {
        if (signal.aborted) throw new SourceFailure('ABORTED');
        if (this.stopped) throw new SourceFailure('UNAVAILABLE');
        return await this.searchValidated(parsed.data, queryDigest, signal);
      } catch (error) {
        return toSourceError(error, parsed.data.cursor === undefined ? undefined : 'snapshot_expired');
      }
    });
  }

  public async closeSnapshot(input: { sourceSnapshotId: string }, signal: AbortSignal): Promise<void> {
    void signal;
    const session = this.registry.findBySnapshot(input.sourceSnapshotId);
    if (session !== undefined) await this.scheduleClose(session);
  }

  public async close(): Promise<void> {
    this.stopped = true;
    const expired = this.registry.expire();
    const active = this.registry.activeSessions();
    const cleanup = [...new Set([...expired, ...active])].map((session) => this.scheduleClose(session));
    // Request locks include in-flight opens; those close their newly known PIT
    // before completing instead of starting a search after shutdown.
    await Promise.allSettled([...this.locks.values(), ...cleanup]);
  }

  private async searchValidated(
    input: LogsSearchPageInput,
    queryDigest: string,
    signal: AbortSignal,
  ): Promise<LogsPageWireResult> {
    if (input.cursor !== undefined && input.sourceSnapshotId !== undefined) {
      const session = this.registry.findBySnapshot(input.sourceSnapshotId);
      if (session === undefined || session.closing) return sourceError('UNAVAILABLE', 'snapshot_expired');
      let searchAfter: readonly [string, number];
      try {
        searchAfter = this.registry.resolveCursor(input.sourceSnapshotId, queryDigest, input.cursor);
      } catch (error) {
        if (error instanceof SourceFailure && error.code === 'MCP_PROTOCOL_ERROR') {
          return sourceError('MCP_PROTOCOL_ERROR', 'cursor_invalid');
        }
        throw error;
      }
      const cached = this.registry.getCachedPage(session, input.cursor);
      if (cached !== undefined) return cached;
      if (session.closed) return sourceError('UNAVAILABLE', 'snapshot_expired');
      return this.fetchAndCachePage(session, input, input.cursor, searchAfter, signal);
    }

    if (input.requestId === undefined) return sourceError('INVALID_INPUT');
    let session = this.registry.findByRequest(input.requestId, queryDigest);
    if (session === undefined) {
      this.registry.reserveOpening({
        requestId: input.requestId, queryDigest,
        retainUntil: Date.parse(input.end) + logsLabQueryPolicy.maxWindowSkewSeconds * 1_000,
      });
      let pitId: string | undefined;
      try {
        const opened = await this.http.request(`/${this.index}/_pit?keep_alive=${PIT_KEEP_ALIVE}`, undefined, {
          method: 'POST', signal,
        });
        pitId = readPitId(opened, 'id');
        session = this.registry.createSession({ requestId: input.requestId, queryDigest, pitId });
      } catch (error) {
        if (pitId !== undefined) await this.closePitId(pitId);
        this.registry.failOpening(input.requestId);
        throw error;
      }
    }
    const current = session;
    return this.withLock(`snapshot:${current.snapshotId}`, async () => {
      if (this.stopped) {
        await this.closePit(current);
        return sourceError('UNAVAILABLE', 'source_unavailable');
      }
      if (current.closing) return sourceError('UNAVAILABLE', 'snapshot_expired');
      const cached = this.registry.getCachedPage(current, undefined);
      if (cached !== undefined) return cached;
      if (current.closed) return sourceError('UNAVAILABLE', 'snapshot_expired');
      return this.fetchAndCachePage(current, input, undefined, undefined, signal);
    });
  }

  private async fetchAndCachePage(
    session: LogSnapshotSession,
    input: LogsSearchPageInput,
    inputCursor: string | undefined,
    searchAfter: readonly [string, number] | undefined,
    signal: AbortSignal,
  ): Promise<LogsPageWireResult> {
    try {
      const response = await this.http.request('/_search', buildSearchBody(input, session.pitId, this.pageSize, searchAfter), {
        method: 'POST', signal,
      });
      if (!isRecord(response)) throw new SourceFailure('MCP_PROTOCOL_ERROR');
      if (response.pit_id !== undefined) this.registry.updatePitId(session, requireString(response.pit_id));
      if (response.timed_out === true) throw new SourceFailure('MCP_TIMEOUT');
      if (isRecord(response._shards) && typeof response._shards.failed === 'number' && response._shards.failed > 0) {
        throw new SourceFailure('MCP_SERVER_ERROR');
      }
      if (!isRecord(response.hits) || !Array.isArray(response.hits.hits)
        || response.hits.hits.length > this.pageSize) throw new SourceFailure('MCP_PROTOCOL_ERROR');

      const hits = response.hits.hits.map((value) => parseHit(value, input));
      const records = hits.map(({ record }) => record);
      const lastSort = hits.at(-1)?.sort;
      const nextCursor = hits.length === this.pageSize && lastSort !== undefined
        ? this.registry.createCursor(session, lastSort)
        : undefined;
      const candidate = {
        status: 'available',
        records,
        sourceSnapshotId: session.snapshotId,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      } as const;
      if (!logsPageWireResultSchema.safeParse(candidate).success) throw new SourceFailure('MCP_PROTOCOL_ERROR');
      const result: Extract<LogsPageWireResult, { status: 'available' }> = candidate;
      this.registry.cachePage(session, inputCursor, result);
      if (nextCursor === undefined) await this.closePit(session);
      return result;
    } catch (error) {
      const shouldClose = signal.aborted
        || !(error instanceof SourceFailure) || !error.retryable;
      if (shouldClose) {
        await this.closePit(session);
      }
      throw error;
    }
  }

  private async closeExpiredSessions(): Promise<void> {
    const expired = this.registry.expire();
    await Promise.allSettled(expired.map((session) => this.scheduleClose(session, true)));
  }

  private async scheduleClose(session: LogSnapshotSession, remove = false): Promise<void> {
    session.closing = true;
    await this.withLock(`snapshot:${session.snapshotId}`, async () => {
      await this.closePit(session);
      if (remove) this.registry.remove(session);
    });
  }

  private async closePit(session: LogSnapshotSession): Promise<void> {
    if (session.closed) return;
    await this.closePitId(session.pitId, session.snapshotId);
    this.registry.markClosed(session);
  }

  private async closePitId(pitId: string, sourceSnapshotId?: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLEANUP_TIMEOUT_MS);
    try {
      await this.http.request('/_pit', { id: pitId }, { method: 'DELETE', signal: controller.signal });
    } catch (error) {
      const code = error instanceof SourceFailure ? error.code : 'MCP_PROTOCOL_ERROR';
      try {
        this.onCleanupFailure({ code, ...(sourceSnapshotId === undefined ? {} : { sourceSnapshotId }) });
      } catch {
        // Cleanup reporting must not mask the primary query result.
      }
      // Elasticsearch expires abandoned PITs after keep_alive.
    } finally {
      clearTimeout(timeout);
    }
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

function buildSearchBody(
  input: LogsSearchPageInput,
  pitId: string,
  pageSize: number,
  searchAfter: readonly [string, number] | undefined,
): Record<string, unknown> {
  const filters: Record<string, unknown>[] = [
    { term: { service: input.service } },
    { range: { timestamp: { gte: input.start, lt: input.end } } },
  ];
  if (input.level !== undefined) filters.push({ term: { level: input.level } });
  if (input.traceId !== undefined) filters.push({ term: { traceId: input.traceId } });
  if (input.contains !== undefined) filters.push({ match_phrase: { message: input.contains } });
  return {
    size: pageSize,
    pit: { id: pitId, keep_alive: PIT_KEEP_ALIVE },
    sort: [{ timestamp: { order: 'asc', format: 'strict_date_optional_time' } }, { _shard_doc: 'asc' }],
    query: { bool: { filter: filters } },
    track_total_hits: false,
    ...(searchAfter === undefined ? {} : { search_after: searchAfter }),
  };
}

function parseHit(value: unknown, input: LogsSearchPageInput): { record: NormalizedLogRecord; sort: readonly [string, number] } {
  if (!isRecord(value) || !isRecord(value._source) || !isSearchAfter(value.sort)) {
    throw new SourceFailure('MCP_PROTOCOL_ERROR');
  }
  const source = value._source;
  if (Object.keys(source).some((key) => !ALLOWED_SOURCE_FIELDS.has(key))
    || typeof source.timestamp !== 'string' || Number.isNaN(Date.parse(source.timestamp))
    || Date.parse(source.timestamp) < Date.parse(input.start)
    || Date.parse(source.timestamp) >= Date.parse(input.end)) {
    throw new SourceFailure('MCP_PROTOCOL_ERROR');
  }
  if (source.service !== undefined && source.service !== input.service) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  for (const key of ['service', 'level', 'message', 'exception', 'traceId'] as const) {
    if (source[key] !== undefined && typeof source[key] !== 'string') throw new SourceFailure('MCP_PROTOCOL_ERROR');
  }
  if (source.fields !== undefined && !isRecord(source.fields)) throw new SourceFailure('MCP_PROTOCOL_ERROR');

  const rawRecord: NormalizedLogRecord = {
    timestamp: source.timestamp,
    service: input.service,
    ...(source.level === undefined ? {} : { level: source.level as string }),
    ...(source.message === undefined ? {} : { message: source.message as string }),
    ...(source.exception === undefined ? {} : { exception: source.exception as string }),
    ...(source.traceId === undefined ? {} : { traceId: source.traceId as string }),
    ...(source.fields === undefined ? {} : { fields: source.fields as NonNullable<NormalizedLogRecord['fields']> }),
  };
  const record = redactLogRecord(rawRecord);
  const validated = logsPageWireResultSchema.safeParse({
    status: 'available', records: [record], sourceSnapshotId: 'validation-only',
  });
  if (!validated.success || validated.data.status !== 'available') throw new SourceFailure('MCP_PROTOCOL_ERROR');
  return { record, sort: value.sort };
}

function digestQuery(input: LogsSearchPageInput): string {
  return createHash('sha256').update(canonicalJson({
    service: input.service,
    start: input.start,
    end: input.end,
    ...(input.level === undefined ? {} : { level: input.level }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    ...(input.contains === undefined ? {} : { contains: input.contains }),
  }), 'utf8').digest('hex');
}

function readPitId(value: unknown, key: 'id' | 'pit_id'): string {
  if (!isRecord(value) || typeof value[key] !== 'string' || value[key].trim().length === 0) {
    throw new SourceFailure('MCP_PROTOCOL_ERROR');
  }
  return value[key];
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  return value;
}

function isSearchAfter(value: unknown): value is readonly [string, number] {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'string' && typeof value[1] === 'number' && Number.isFinite(value[1]);
}

function isValidIndex(value: string): boolean {
  return value.length > 0 && value.length <= 255
    && /^[a-z0-9][a-z0-9._-]*$/.test(value) && value !== '.' && value !== '..';
}

function sourceError(
  code: 'INVALID_INPUT' | 'POLICY_DENIED' | 'UNAVAILABLE' | 'MCP_AUTH_ERROR' | 'MCP_NETWORK_ERROR' | 'MCP_TIMEOUT' | 'MCP_RATE_LIMITED' | 'MCP_SERVER_ERROR' | 'MCP_PROTOCOL_ERROR' | 'ABORTED' | 'BUDGET_EXCEEDED',
  reason?: 'snapshot_expired' | 'cursor_invalid' | 'scope_denied' | 'response_too_large' | 'source_unavailable',
): LogsPageWireResult {
  return { status: 'source_error', code, ...(reason === undefined ? {} : { reason }) };
}

function toSourceError(error: unknown, defaultReason: 'snapshot_expired' | undefined): LogsPageWireResult {
  if (!(error instanceof SourceFailure)) return sourceError('MCP_PROTOCOL_ERROR');
  const reason = error.code === 'UNAVAILABLE'
    ? defaultReason ?? 'source_unavailable'
    : error.code === 'BUDGET_EXCEEDED' ? 'response_too_large' : undefined;
  const allowed = new Set([
    'INVALID_INPUT', 'POLICY_DENIED', 'UNAVAILABLE', 'MCP_AUTH_ERROR', 'MCP_NETWORK_ERROR', 'MCP_TIMEOUT',
    'MCP_RATE_LIMITED', 'MCP_SERVER_ERROR', 'MCP_PROTOCOL_ERROR', 'ABORTED', 'BUDGET_EXCEEDED',
  ]);
  const code = allowed.has(error.code)
    ? error.code as Exclude<LogsPageWireResult, { status: 'available' }>['code']
    : 'UNAVAILABLE';
  return sourceError(code, reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
