import type { McpConnection } from '../../mcp/types.js';
import { SourceFailure, type ResilientExecutor, type RetryEvent } from '../../mcp/resilience.js';
import {
  canonicalJson,
  type EvidenceSourcePage,
  type JsonValue,
  type NormalizedLogRecord,
  type ToolResponse,
} from '../../contracts/index.js';

const DEFAULT_MAX_PAGE_BYTES = 512 * 1024;
const DEFAULT_MAX_PAGES = 10_000;

/** Structured query accepted by the ELK adapter; raw DSL is deliberately not part of this port. */
export interface ElkEvidenceQuery {
  service: string;
  start: string;
  end: string;
  level?: string;
  traceId?: string;
  contains?: string;
}

export interface ElkPageClientResponse {
  records: readonly NormalizedLogRecord[];
  nextCursor?: string;
  sourceSnapshotId?: string;
}

/** The page client is independent of the MCP SDK and can be backed by MCP, HTTP or a fixture. */
export interface ElkPageClient {
  fetchPage(input: {
    query: ElkEvidenceQuery;
    cursor?: string;
    sourceSnapshotId?: string;
    signal: AbortSignal;
  }): Promise<ElkPageClientResponse>;
}

export interface PagedEvidenceSourceOptions {
  maxPageBytes?: number;
  maxPages?: number;
}

/**
 * Bounded, cursor-driven source adapter used by the streaming evidence recorder.
 * It yields only validated pages and never exposes an ELK query or storage detail.
 */
export class PagedEvidenceSource {
  private readonly maxPageBytes: number;
  private readonly maxPages: number;

  public constructor(
    private readonly client: ElkPageClient,
    options: PagedEvidenceSourceOptions = {},
  ) {
    this.maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isSafeInteger(this.maxPageBytes) || this.maxPageBytes <= 0) {
      throw new RangeError('maxPageBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages <= 0) {
      throw new RangeError('maxPages must be a positive safe integer');
    }
  }

  public pages(
    query: ElkEvidenceQuery,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<EvidenceSourcePage, void> {
    const validatedQuery = validateQuery(query);
    const signal = options.signal ?? new AbortController().signal;
    return this.iterate(validatedQuery, signal);
  }

  private async *iterate(query: ElkEvidenceQuery, signal: AbortSignal): AsyncGenerator<EvidenceSourcePage, void> {
    let cursor: string | undefined;
    let expectedSnapshot: string | undefined;
    const seenCursors = new Set<string>();

    for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
      throwIfAborted(signal);
      let response: ElkPageClientResponse;
      try {
        response = await this.client.fetchPage({
          query,
          signal,
          ...(cursor === undefined ? {} : { cursor }),
          ...(expectedSnapshot === undefined ? {} : { sourceSnapshotId: expectedSnapshot }),
        });
      } catch (error) {
        throw normalizeSourceError(error);
      }
      throwIfAborted(signal);

      const page = validatePageResponse(response, this.maxPageBytes);
      if (expectedSnapshot === undefined && page.sourceSnapshotId !== undefined) {
        expectedSnapshot = page.sourceSnapshotId;
      } else if (
        expectedSnapshot !== undefined
        && page.sourceSnapshotId !== undefined
        && page.sourceSnapshotId !== expectedSnapshot
      ) {
        throw protocolError();
      }

      const nextCursor = page.nextCursor;
      if (nextCursor !== undefined) {
        if (nextCursor === cursor || seenCursors.has(nextCursor)) throw protocolError();
        seenCursors.add(nextCursor);
      }

      yield page;
      if (nextCursor === undefined) return;
      cursor = nextCursor;
    }

    throw protocolError();
  }
}

export interface McpElkPageClientOptions {
  remoteName?: string;
}

export interface ResilientElkPageClientOptions {
  executor: ResilientExecutor;
  deadlineMs?: number;
  now?: () => number;
  attemptBudget?: { remaining: number };
  onEvent?: (event: RetryEvent) => void;
}

/** MCP boundary adapter. No MCP SDK types cross into the evidence source contract. */
export class McpElkPageClient implements ElkPageClient {
  private readonly remoteName: string;

  public constructor(
    private readonly connection: McpConnection,
    options: McpElkPageClientOptions = {},
  ) {
    this.remoteName = options.remoteName ?? 'logs.search_page';
    if (this.remoteName.trim().length === 0) throw new Error('remoteName must not be empty');
  }

  public async fetchPage(input: {
    query: ElkEvidenceQuery;
    cursor?: string;
    sourceSnapshotId?: string;
    signal: AbortSignal;
  }): Promise<ElkPageClientResponse> {
    throwIfAborted(input.signal);
    const query = validateQuery(input.query);
    let response: ToolResponse;
    try {
      response = await this.connection.call(this.remoteName, {
        service: query.service,
        start: query.start,
        end: query.end,
        ...(query.level === undefined ? {} : { level: query.level }),
        ...(query.traceId === undefined ? {} : { traceId: query.traceId }),
        ...(query.contains === undefined ? {} : { contains: query.contains }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: input.sourceSnapshotId }),
      }, input.signal);
    } catch (error) {
      throw normalizeSourceError(error);
    }
    throwIfAborted(input.signal);
    if (response.isError) throw new SourceFailure('MCP_SERVER_ERROR');
    const blocks = response.blocks.filter((block) => block.type === 'json');
    if (blocks.length !== 1 || blocks[0]?.type !== 'json') throw protocolError();
    return decodePage(blocks[0].value);
  }
}

/** Adds per-page retry and circuit semantics without changing the source or MCP contracts. */
export class ResilientElkPageClient implements ElkPageClient {
  private readonly deadlineMs: number;
  private readonly now: () => number;

  public constructor(
    private readonly delegate: ElkPageClient,
    private readonly options: ResilientElkPageClientOptions,
  ) {
    this.deadlineMs = options.deadlineMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.deadlineMs) || this.deadlineMs <= 0) throw new RangeError('deadlineMs must be positive');
  }

  public fetchPage(input: {
    query: ElkEvidenceQuery;
    cursor?: string;
    sourceSnapshotId?: string;
    signal: AbortSignal;
  }): Promise<ElkPageClientResponse> {
    return this.options.executor.execute(
      (signal) => this.delegate.fetchPage({ ...input, signal }),
      {
        signal: input.signal,
        deadline: this.now() + this.deadlineMs,
        ...(this.options.attemptBudget === undefined ? {} : { attemptBudget: this.options.attemptBudget }),
        ...(this.options.onEvent === undefined ? {} : { onEvent: this.options.onEvent }),
      },
    );
  }
}

function validateQuery(input: ElkEvidenceQuery): ElkEvidenceQuery {
  if (!isRecord(input)) throw protocolError();
  const service = nonEmptyString(input.service);
  const start = nonEmptyString(input.start);
  const end = nonEmptyString(input.end);
  if (service === undefined || start === undefined || end === undefined) throw protocolError();
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw protocolError();
  const level = optionalQueryString(input.level);
  const traceId = optionalQueryString(input.traceId);
  const contains = optionalQueryString(input.contains);
  return {
    service,
    start,
    end,
    ...(level === undefined ? {} : { level }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(contains === undefined ? {} : { contains }),
  };
}

function validatePageResponse(response: ElkPageClientResponse, maxPageBytes: number): EvidenceSourcePage {
  if (!isRecord(response) || !Array.isArray(response.records)) throw protocolError();
  const records = response.records.map(validateRecord);
  const encodedBytes = records.reduce(
    (total, record) => total + Buffer.byteLength(canonicalJson(record) + '\n', 'utf8'),
    0,
  );
  if (encodedBytes > maxPageBytes) throw protocolError();
  const nextCursor = response.nextCursor;
  if (nextCursor !== undefined && (typeof nextCursor !== 'string' || nextCursor.trim().length === 0)) {
    throw protocolError();
  }
  const sourceSnapshotId = response.sourceSnapshotId;
  if (sourceSnapshotId !== undefined && (typeof sourceSnapshotId !== 'string' || sourceSnapshotId.trim().length === 0)) {
    throw protocolError();
  }
  return {
    records: Object.freeze(records),
    encodedBytes,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(sourceSnapshotId === undefined ? {} : { sourceSnapshotId }),
  };
}

function decodePage(value: unknown): ElkPageClientResponse {
  if (!isRecord(value) || !Array.isArray(value.records)) throw protocolError();
  const records = value.records.map(validateRecord);
  if (value.nextCursor !== undefined && (typeof value.nextCursor !== 'string' || value.nextCursor.trim().length === 0)) {
    throw protocolError();
  }
  if (value.sourceSnapshotId !== undefined
    && (typeof value.sourceSnapshotId !== 'string' || value.sourceSnapshotId.trim().length === 0)) {
    throw protocolError();
  }
  return {
    records,
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
    ...(value.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: value.sourceSnapshotId }),
  };
}

function validateRecord(value: unknown): NormalizedLogRecord {
  if (!isRecord(value) || typeof value.timestamp !== 'string' || Number.isNaN(Date.parse(value.timestamp))) {
    throw protocolError();
  }
  const service = optionalString(value.service);
  const level = optionalString(value.level);
  const message = optionalString(value.message);
  const exception = optionalString(value.exception);
  const traceId = optionalString(value.traceId);
  for (const [raw, parsed] of [[value.service, service], [value.level, level], [value.message, message], [value.exception, exception], [value.traceId, traceId]]) {
    if (raw !== undefined && parsed === undefined) throw protocolError();
  }
  if (value.fields !== undefined && !isJsonObject(value.fields)) throw protocolError();
  const record: NormalizedLogRecord = {
    timestamp: value.timestamp,
    ...(service === undefined ? {} : { service }),
    ...(level === undefined ? {} : { level }),
    ...(message === undefined ? {} : { message }),
    ...(exception === undefined ? {} : { exception }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(value.fields === undefined ? {} : { fields: value.fields }),
  };
  try {
    canonicalJson(record);
  } catch {
    throw protocolError();
  }
  return record;
}

function normalizeSourceError(error: unknown): SourceFailure {
  if (error instanceof SourceFailure) return error;
  return protocolError();
}

function protocolError(): SourceFailure {
  return new SourceFailure('MCP_PROTOCOL_ERROR');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SourceFailure('ABORTED');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (!isRecord(value)) return false;
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value);
}

function optionalQueryString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = nonEmptyString(value);
  if (parsed === undefined) throw protocolError();
  return parsed;
}
