import { isDeepStrictEqual } from 'node:util';
import type {
  AgentEventEnvelopeV2,
  AgentMessageV2,
  EventStore,
  MessageStore,
  PendingAgentEventV2,
  StoredAgentMessageV2,
} from '../../contracts/index.js';
import {
  EventIdConflictError,
  MessageVersionConflictError,
  SequenceConflictError,
  StoredDataCorruptionError,
} from '../../contracts/event-store.js';
import { parseAgentEventV2 } from '../../contracts/event-v2/schema.js';
import { parseAgentMessageV2 } from '../../contracts/message-v2/schema.js';
import type { SqliteDatabase } from './database.js';

interface SequenceRow { current_sequence: number }
interface EventRow { event_id: string; event_json: string }
interface MessageRow { message_id: string; version: number; message_json: string }

export class SqliteEventMessageStore implements EventStore, MessageStore {
  public constructor(private readonly database: SqliteDatabase) {}

  public async append(runId: string, expectedSequence: number, events: readonly PendingAgentEventV2[]): Promise<AgentEventEnvelopeV2[]> {
    this.assertSequence(expectedSequence);
    return this.database.raw.transaction(() => {
      if (events.length === 0) {
        this.assertExpected(runId, expectedSequence);
        return [];
      }
      const ids = new Set<string>();
      for (const event of events) {
        if (event.runId !== runId) throw new Error(`event runId mismatch: expected ${runId}, received ${event.runId}`);
        if (event.durability !== 'durable') throw new Error('transient events must reserve a sequence instead of being appended');
        if (ids.has(event.eventId)) throw new EventIdConflictError(event.eventId);
        ids.add(event.eventId);
      }

      const existing = events.map((event) => this.findEventRow(event.eventId));
      if (existing.every((row) => row !== undefined)) {
        const parsed = existing.map((row) => this.parseEventRow(row!));
        if (parsed.every((saved, index) => this.matchesPending(saved, events[index]!))) return parsed;
      }
      this.assertExpected(runId, expectedSequence);
      const duplicate = existing.find((row) => row !== undefined);
      if (duplicate !== undefined) throw new EventIdConflictError(duplicate.event_id);

      const saved = events.map((event, index) => parseAgentEventV2({
        ...structuredClone(event), sequence: expectedSequence + index + 1,
      }));
      const insert = this.database.raw.prepare(`
        INSERT INTO agent_events(event_id, run_id, sequence, type, timestamp, event_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const event of saved) {
        insert.run(event.eventId, event.runId, event.sequence, event.type, event.timestamp, JSON.stringify(event));
      }
      this.writeSequence(runId, expectedSequence + saved.length);
      return structuredClone(saved);
    })();
  }

  public async reserveSequence(runId: string, expectedSequence: number, count: number): Promise<number[]> {
    this.assertSequence(expectedSequence);
    if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError('sequence reservation count must be a positive safe integer');
    return this.database.raw.transaction(() => {
      this.assertExpected(runId, expectedSequence);
      this.writeSequence(runId, expectedSequence + count);
      return Array.from({ length: count }, (_, index) => expectedSequence + index + 1);
    })();
  }

  public async readRun(runId: string, afterSequence: number, limit: number): Promise<AgentEventEnvelopeV2[]> {
    this.assertSequence(afterSequence);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('event read limit must be a positive safe integer');
    const rows = this.database.raw.prepare(`
      SELECT event_id, event_json FROM agent_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
    `).all(runId, afterSequence, limit) as EventRow[];
    return rows.map((row) => this.parseEventRow(row));
  }

  public async findById(eventId: string): Promise<AgentEventEnvelopeV2 | null> {
    const row = this.findEventRow(eventId);
    return row === undefined ? null : this.parseEventRow(row);
  }

  public async currentSequence(runId: string): Promise<number> {
    return this.readSequence(runId);
  }

  public async saveMessage(message: AgentMessageV2, expectedVersion: number | null): Promise<StoredAgentMessageV2> {
    const parsed = parseAgentMessageV2(structuredClone(message));
    return this.database.raw.transaction(() => {
      const row = this.database.raw.prepare('SELECT message_id, version, message_json FROM agent_messages WHERE message_id = ?')
        .get(parsed.id) as MessageRow | undefined;
      const actual = row?.version ?? null;
      if ((row === undefined && expectedVersion !== null) || (row !== undefined && expectedVersion !== row.version)) {
        throw new MessageVersionConflictError(parsed.id, expectedVersion, actual);
      }
      const version = (row?.version ?? 0) + 1;
      this.database.raw.prepare(`
        INSERT INTO agent_messages(message_id, run_id, version, message_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET run_id=excluded.run_id, version=excluded.version, message_json=excluded.message_json
      `).run(parsed.id, parsed.runId, version, JSON.stringify(parsed));
      return { message: structuredClone(parsed), version };
    })();
  }

  public async getMessage(id: string): Promise<StoredAgentMessageV2 | null> {
    const row = this.database.raw.prepare('SELECT message_id, version, message_json FROM agent_messages WHERE message_id = ?')
      .get(id) as MessageRow | undefined;
    return row === undefined ? null : this.parseMessageRow(row);
  }

  public async listMessagesByRun(runId: string): Promise<StoredAgentMessageV2[]> {
    const rows = this.database.raw.prepare(`
      SELECT message_id, version, message_json FROM agent_messages WHERE run_id = ? ORDER BY message_id
    `).all(runId) as MessageRow[];
    return rows.map((row) => this.parseMessageRow(row));
  }

  private readSequence(runId: string): number {
    const row = this.database.raw.prepare('SELECT current_sequence FROM agent_run_sequences WHERE run_id = ?')
      .get(runId) as SequenceRow | undefined;
    return row?.current_sequence ?? 0;
  }

  private assertExpected(runId: string, expected: number): void {
    const actual = this.readSequence(runId);
    if (actual !== expected) throw new SequenceConflictError(runId, expected, actual);
  }

  private writeSequence(runId: string, sequence: number): void {
    this.database.raw.prepare(`
      INSERT INTO agent_run_sequences(run_id, current_sequence) VALUES (?, ?)
      ON CONFLICT(run_id) DO UPDATE SET current_sequence=excluded.current_sequence
    `).run(runId, sequence);
  }

  private findEventRow(eventId: string): EventRow | undefined {
    return this.database.raw.prepare('SELECT event_id, event_json FROM agent_events WHERE event_id = ?')
      .get(eventId) as EventRow | undefined;
  }

  private parseEventRow(row: EventRow): AgentEventEnvelopeV2 {
    try { return parseAgentEventV2(JSON.parse(row.event_json)); }
    catch { throw new StoredDataCorruptionError('event', row.event_id); }
  }

  private parseMessageRow(row: MessageRow): StoredAgentMessageV2 {
    try { return { message: parseAgentMessageV2(JSON.parse(row.message_json)), version: row.version }; }
    catch { throw new StoredDataCorruptionError('message', row.message_id); }
  }

  private matchesPending(saved: AgentEventEnvelopeV2, pending: PendingAgentEventV2): boolean {
    const { sequence: _sequence, ...unsequenced } = saved;
    return isDeepStrictEqual(unsequenced, pending);
  }

  private assertSequence(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('sequence must be a non-negative safe integer');
  }
}
