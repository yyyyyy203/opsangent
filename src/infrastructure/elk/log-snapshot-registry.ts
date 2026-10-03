import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../../contracts/index.js';
import type { LogsPageWireResult } from '../../mcp/logs-protocol.js';
import { SourceFailure } from '../../mcp/resilience.js';
import { logsLabQueryPolicy } from '../../profiles/logs.js';

const DEFAULT_MAX_SESSIONS = 16;
const MAX_RETAINED_SESSIONS_PER_ACTIVE = 2;
const DEFAULT_MAX_REQUEST_HISTORY = 1_024;
const DEFAULT_TTL_MS = 2 * 60_000;
const MAX_CURSOR_BYTES = 4 * 1_024;
const REQUEST_RETENTION_MS = (logsLabQueryPolicy.maxFutureSkewSeconds + logsLabQueryPolicy.maxWindowSkewSeconds) * 1_000;

type SearchAfter = readonly [string, number];

interface RequestReference {
  queryDigest: string;
  snapshotId: string;
  retainUntil: number;
}

export interface LogSnapshotSession {
  snapshotId: string;
  requestId: string;
  queryDigest: string;
  pitId: string;
  expiresAt: number;
  closed: boolean;
  closing: boolean;
  firstPage?: LogsPageWireResult;
  recentPage?: { inputCursor: string; result: LogsPageWireResult };
}

export class LogSnapshotRegistry {
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly maxSessions: number;
  private readonly maxRetainedSessions: number;
  private readonly maxRequestHistory: number;
  private readonly ttlMs: number;
  private readonly sessions = new Map<string, LogSnapshotSession>();
  private readonly requests = new Map<string, RequestReference>();
  private readonly opening = new Set<string>();

  public constructor(options: {
    cursorSecret: string;
    now?: () => number;
    id?: () => string;
    maxSessions?: number;
    maxRequestHistory?: number;
    ttlMs?: number;
  }) {
    this.secret = Buffer.from(options.cursorSecret, 'utf8');
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxRetainedSessions = this.maxSessions * MAX_RETAINED_SESSIONS_PER_ACTIVE;
    this.maxRequestHistory = options.maxRequestHistory ?? DEFAULT_MAX_REQUEST_HISTORY;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (this.secret.byteLength < 32) throw new RangeError('cursorSecret must be at least 32 UTF-8 bytes');
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > DEFAULT_MAX_SESSIONS) {
      throw new RangeError('maxSessions must be between 1 and 16');
    }
    if (!Number.isSafeInteger(this.maxRequestHistory) || this.maxRequestHistory < this.maxSessions
      || !Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError('Invalid log snapshot registry limits');
    }
  }

  public reserveOpening(input: { requestId: string; queryDigest: string; retainUntil?: number }): void {
    const requestId = nonEmpty(input.requestId);
    const queryDigest = nonEmpty(input.queryDigest);
    if (requestId === undefined || queryDigest === undefined) {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    if (this.requests.has(requestId)) throw new SourceFailure('UNAVAILABLE');
    const retainUntil = input.retainUntil ?? this.now() + REQUEST_RETENTION_MS;
    if (!Number.isFinite(retainUntil) || retainUntil < this.now()) throw new SourceFailure('UNAVAILABLE');
    const activeSessions = [...this.sessions.values()].filter((session) => !session.closed).length;
    if (activeSessions + this.opening.size >= this.maxSessions) throw new SourceFailure('MCP_RATE_LIMITED');
    this.trimClosedSessions();
    this.trimRequestHistory();

    const snapshotId = nonEmpty(this.id());
    if (snapshotId === undefined || [...this.requests.values()].some((reference) => reference.snapshotId === snapshotId)) {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    this.requests.set(requestId, { queryDigest, snapshotId, retainUntil });
    this.opening.add(requestId);
  }

  public failOpening(requestId: string): void {
    // The server may have opened a PIT even when its response was lost.
    // Release capacity, but retain the ID so a retry cannot open a replacement.
    this.opening.delete(requestId);
  }

  public createSession(input: { requestId: string; queryDigest: string; pitId: string }): LogSnapshotSession {
    if (nonEmpty(input.pitId) === undefined) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    let reference = this.requests.get(input.requestId);
    if (reference === undefined) {
      this.reserveOpening(input);
      reference = this.requests.get(input.requestId)!;
    }
    if (reference.queryDigest !== input.queryDigest) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    if (!this.opening.has(input.requestId)) {
      const existing = this.sessions.get(reference.snapshotId);
      if (existing === undefined) throw new SourceFailure('UNAVAILABLE');
      return existing;
    }
    this.trimClosedSessions();
    const session: LogSnapshotSession = {
      snapshotId: reference.snapshotId,
      requestId: input.requestId,
      queryDigest: input.queryDigest,
      pitId: input.pitId,
      expiresAt: this.now() + this.ttlMs,
      closed: false,
      closing: false,
    };
    this.sessions.set(session.snapshotId, session);
    this.opening.delete(input.requestId);
    return session;
  }

  public findByRequest(requestId: string, queryDigest: string): LogSnapshotSession | undefined {
    const reference = this.requests.get(requestId);
    if (reference === undefined) return undefined;
    if (reference.queryDigest !== queryDigest) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    const session = this.sessions.get(reference.snapshotId);
    if (session === undefined || session.closing) throw new SourceFailure('UNAVAILABLE');
    return session;
  }

  public findBySnapshot(snapshotId: string): LogSnapshotSession | undefined {
    return this.sessions.get(snapshotId);
  }

  public updatePitId(session: LogSnapshotSession, pitId: string): void {
    this.assertActiveSession(session);
    if (nonEmpty(pitId) === undefined) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    session.pitId = pitId;
    session.expiresAt = this.now() + this.ttlMs;
  }

  public createCursor(session: LogSnapshotSession, sort: SearchAfter): string {
    this.assertActiveSession(session);
    if (!isSearchAfter(sort)) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    const payload = Buffer.from(canonicalJson({
      version: 1,
      snapshotId: session.snapshotId,
      queryDigest: session.queryDigest,
      searchAfter: sort,
    }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload, 'utf8').digest('base64url');
    const cursor = `${payload}.${signature}`;
    if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) throw new SourceFailure('BUDGET_EXCEEDED');
    return cursor;
  }

  public resolveCursor(snapshotId: string, queryDigest: string, cursor: string): SearchAfter {
    if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    const parts = cursor.split('.');
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    const [payload, signature] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    const expected = createHmac('sha256', this.secret).update(payload, 'utf8').digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, 'base64url');
    } catch {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }

    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    } catch {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    if (!isRecord(value) || value.version !== 1 || value.snapshotId !== snapshotId
      || value.queryDigest !== queryDigest || !isSearchAfter(value.searchAfter)) {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    const session = this.sessions.get(snapshotId);
    if (session === undefined || session.queryDigest !== queryDigest) throw new SourceFailure('UNAVAILABLE');
    return value.searchAfter;
  }

  public cachePage(session: LogSnapshotSession, inputCursor: string | undefined, result: LogsPageWireResult): void {
    this.assertActiveSession(session);
    const copy = structuredClone(result);
    if (inputCursor === undefined) session.firstPage = copy;
    else session.recentPage = { inputCursor, result: copy };
    session.expiresAt = this.now() + this.ttlMs;
  }

  public getCachedPage(session: LogSnapshotSession, inputCursor: string | undefined): LogsPageWireResult | undefined {
    this.assertActiveSession(session);
    const result = inputCursor === undefined
      ? session.firstPage
      : session.recentPage?.inputCursor === inputCursor ? session.recentPage.result : undefined;
    return result === undefined ? undefined : structuredClone(result);
  }

  public markClosed(session: LogSnapshotSession): void {
    session.closed = true;
  }

  public remove(session: LogSnapshotSession): void {
    if (this.sessions.get(session.snapshotId) !== session) return;
    this.sessions.delete(session.snapshotId);
  }

  public activeSessions(): LogSnapshotSession[] {
    return [...this.sessions.values()].filter((session) => !session.closed);
  }

  public expire(): LogSnapshotSession[] {
    const now = this.now();
    const expired: LogSnapshotSession[] = [];
    for (const [snapshotId, session] of this.sessions) {
      if (session.expiresAt > now) continue;
      if (session.closed) {
        this.sessions.delete(snapshotId);
      } else if (session.closing) {
        continue;
      } else {
        // Keep the object registered until the search lock drains, so an
        // in-flight response can publish its latest PIT before cleanup.
        session.closing = true;
      }
      expired.push(session);
    }
    return expired;
  }

  private assertActiveSession(session: LogSnapshotSession): void {
    if (this.sessions.get(session.snapshotId) !== session) throw new SourceFailure('UNAVAILABLE');
  }

  private trimRequestHistory(): void {
    // Scope accepts end up to 30s ahead and retries through end + 120s,
    // including the boundary. Never evict an ID while that query is valid.
    const now = this.now();
    for (const [requestId, reference] of this.requests) {
      if (reference.retainUntil < now && !this.sessions.has(reference.snapshotId) && !this.opening.has(requestId)) {
        this.requests.delete(requestId);
      }
    }
    if (this.requests.size >= this.maxRequestHistory) throw new SourceFailure('MCP_RATE_LIMITED');
  }

  private trimClosedSessions(): void {
    while (this.sessions.size >= this.maxRetainedSessions) {
      const oldestClosed = [...this.sessions.values()].find((session) => session.closed);
      if (oldestClosed === undefined) throw new SourceFailure('MCP_RATE_LIMITED');
      // Keep the request reference as a bounded tombstone so an evicted capture
      // cannot silently open a different PIT when the same requestId is replayed.
      this.sessions.delete(oldestClosed.snapshotId);
    }
  }
}

function nonEmpty(value: string): string | undefined {
  return value.trim().length > 0 ? value : undefined;
}

function isSearchAfter(value: unknown): value is SearchAfter {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'string' && typeof value[1] === 'number' && Number.isFinite(value[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
