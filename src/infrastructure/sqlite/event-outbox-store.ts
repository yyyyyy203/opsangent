import {
  EventIdConflictError,
  StoredDataCorruptionError,
  type PendingAgentEventV2,
} from '../../contracts/event-store.js';
import { parseAgentEventV2 } from '../../contracts/event-v2/schema.js';
import type { DurableEventOutbox, DurableOutboxRecord } from '../../contracts/storage.js';
import { canonicalJson } from '../../contracts/stable-json.js';
import type { SqliteDatabase } from './database.js';

interface OutboxRow {
  event_id: string;
  run_id: string;
  event_json: string;
  state: 'pending' | 'published';
  created_at: string;
  published_at: string | null;
}

interface EnqueueOptions {
  expectedRunId?: string;
}

/** SQLite reader/marker for durable event facts staged by a state transition. */
export class SqliteEventOutboxStore implements DurableEventOutbox {
  public constructor(private readonly database: SqliteDatabase) {}

  public enqueue(input: { events: readonly PendingAgentEventV2[]; createdAt: string }): Promise<readonly DurableOutboxRecord[]> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => (
      enqueueOutboxEvents(this.database, input)
    )).immediate());
  }

  public listPending(input: { runId?: string; limit: number }): Promise<readonly DurableOutboxRecord[]> {
    return Promise.resolve().then(() => {
      assertOutboxLimit(input.limit);
      const rows = input.runId === undefined
        ? this.database.raw.prepare(`
          SELECT event_id, run_id, event_json, state, created_at, published_at
          FROM durable_event_outbox
          WHERE state = 'pending'
          ORDER BY rowid ASC
          LIMIT ?
        `).all(input.limit) as OutboxRow[]
        : this.database.raw.prepare(`
          SELECT event_id, run_id, event_json, state, created_at, published_at
          FROM durable_event_outbox
          WHERE state = 'pending' AND run_id = ?
          ORDER BY rowid ASC
          LIMIT ?
        `).all(input.runId, input.limit) as OutboxRow[];
      return rows.map((row) => parseOutboxRow(row));
    });
  }

  public markPublished(input: { eventId: string; publishedAt: string }): Promise<void> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      assertTimestamp(input.publishedAt, 'publishedAt');
      const row = findOutboxRow(this.database, input.eventId);
      if (row === undefined) throw new Error(`Outbox event not found: ${input.eventId}`);
      const existing = parseOutboxRow(row);
      if (existing.publishedAt !== undefined) return;
      const update = this.database.raw.prepare(`
        UPDATE durable_event_outbox
        SET state = 'published', published_at = ?
        WHERE event_id = ? AND state = 'pending'
      `).run(input.publishedAt, input.eventId);
      if (update.changes !== 1) throw new Error(`Outbox event publication update failed: ${input.eventId}`);
    }).immediate());
  }
}

/**
 * Stages validated events inside the caller's SQLite transaction. It intentionally owns no transaction
 * so a checkpoint, execution journal, and corresponding event facts can commit together.
 */
export function enqueueOutboxEvents(
  database: SqliteDatabase,
  input: { events: readonly PendingAgentEventV2[]; createdAt: string },
  options: EnqueueOptions = {},
): DurableOutboxRecord[] {
  assertTimestamp(input.createdAt, 'createdAt');
  const normalized = normalizeBatch(input.events, options.expectedRunId);
  const records = normalized.map((event) => {
    const existing = findOutboxRow(database, event.eventId);
    if (existing !== undefined) {
      const stored = parseOutboxRow(existing);
      if (!samePendingEvent(stored.event, event)) throw new EventIdConflictError(event.eventId);
      return { record: stored, isNew: false };
    }
    return { record: { event, enqueuedAt: input.createdAt }, isNew: true };
  });
  const insert = database.raw.prepare(`
    INSERT INTO durable_event_outbox(event_id, run_id, event_json, state, created_at, published_at)
    VALUES (?, ?, ?, 'pending', ?, NULL)
  `);
  for (const { record, isNew } of records) {
    if (isNew) insert.run(record.event.eventId, record.event.runId, JSON.stringify(record.event), record.enqueuedAt);
  }
  return records.map(({ record }) => structuredClone(record));
}

function normalizeBatch(events: readonly PendingAgentEventV2[], expectedRunId: string | undefined): PendingAgentEventV2[] {
  const eventIds = new Set<string>();
  return events.map((event) => {
    const normalized = parsePendingEvent(event);
    if (normalized.durability !== 'durable') throw new Error('Outbox accepts durable events only');
    if (expectedRunId !== undefined && normalized.runId !== expectedRunId) {
      throw new Error(`Outbox event runId mismatch: expected ${expectedRunId}, received ${normalized.runId}`);
    }
    if (eventIds.has(normalized.eventId)) throw new EventIdConflictError(normalized.eventId);
    eventIds.add(normalized.eventId);
    return normalized;
  });
}

function findOutboxRow(database: SqliteDatabase, eventId: string): OutboxRow | undefined {
  return database.raw.prepare(`
    SELECT event_id, run_id, event_json, state, created_at, published_at
    FROM durable_event_outbox
    WHERE event_id = ?
  `).get(eventId) as OutboxRow | undefined;
}

function parseOutboxRow(row: OutboxRow): DurableOutboxRecord {
  try {
    if (row.state !== 'pending' && row.state !== 'published') throw new Error('invalid state');
    assertTimestamp(row.created_at, 'createdAt');
    if (row.published_at !== null) assertTimestamp(row.published_at, 'publishedAt');
    if ((row.state === 'pending') !== (row.published_at === null)) throw new Error('state and publication time disagree');
    const event = parsePendingEvent(JSON.parse(row.event_json) as PendingAgentEventV2);
    if (event.eventId !== row.event_id || event.runId !== row.run_id || event.durability !== 'durable') {
      throw new Error('row identity mismatch');
    }
    return {
      event,
      enqueuedAt: row.created_at,
      ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
    };
  } catch {
    throw new StoredDataCorruptionError('event', row.event_id);
  }
}

function parsePendingEvent(event: PendingAgentEventV2): PendingAgentEventV2 {
  const parsed = parseAgentEventV2({ ...structuredClone(event), sequence: 1 });
  const { sequence, ...pending } = parsed;
  void sequence;
  return pending;
}

function samePendingEvent(left: PendingAgentEventV2, right: PendingAgentEventV2): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertOutboxLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('Outbox limit must be a positive safe integer');
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}
