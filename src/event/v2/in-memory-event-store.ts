import { isDeepStrictEqual } from 'node:util';
import type {
  AgentEventEnvelopeV2,
  AgentMessageV2,
  EventStore,
  MessageStore,
  PendingAgentEventV2,
  StoredAgentMessageV2,
} from '../../contracts/index.js';
import { parseAgentEventV2 } from '../../contracts/event-v2/schema.js';
import { parseAgentMessageV2 } from '../../contracts/message-v2/schema.js';

export class SequenceConflictError extends Error {
  public constructor(
    public readonly runId: string,
    public readonly expectedSequence: number,
    public readonly actualSequence: number,
  ) {
    super(`event sequence conflict for ${runId}: expected ${expectedSequence}, actual ${actualSequence}`);
    this.name = 'SequenceConflictError';
  }
}

export class EventIdConflictError extends Error {
  public constructor(public readonly eventId: string) {
    super(`event id conflict: ${eventId}`);
    this.name = 'EventIdConflictError';
  }
}

export class MessageVersionConflictError extends Error {
  public constructor(
    public readonly messageId: string,
    public readonly expectedVersion: number | null,
    public readonly actualVersion: number | null,
  ) {
    super(`message version conflict for ${messageId}: expected ${String(expectedVersion)}, actual ${String(actualVersion)}`);
    this.name = 'MessageVersionConflictError';
  }
}

export class InMemoryEventMessageStore implements EventStore, MessageStore {
  private readonly eventsByRun = new Map<string, AgentEventEnvelopeV2[]>();
  private readonly eventsById = new Map<string, AgentEventEnvelopeV2>();
  private readonly sequences = new Map<string, number>();
  private readonly messages = new Map<string, StoredAgentMessageV2>();

  public async append(
    runId: string,
    expectedSequence: number,
    events: readonly PendingAgentEventV2[],
  ): Promise<AgentEventEnvelopeV2[]> {
    this.assertSequenceInput(expectedSequence);
    if (events.length === 0) {
      this.assertExpectedSequence(runId, expectedSequence);
      return [];
    }
    for (const event of events) {
      if (event.runId !== runId) throw new Error(`event runId mismatch: expected ${runId}, received ${event.runId}`);
      if (event.durability !== 'durable') throw new Error('transient events must reserve a sequence instead of being appended');
    }

    const existing = events.map((event) => this.eventsById.get(event.eventId));
    if (existing.every((event) => event !== undefined)) {
      const exact = existing.every((saved, index) => saved !== undefined && this.matchesPending(saved, events[index]!));
      if (exact) return structuredClone(existing as AgentEventEnvelopeV2[]);
    }
    this.assertExpectedSequence(runId, expectedSequence);
    const duplicateIndex = existing.findIndex((event) => event !== undefined);
    if (duplicateIndex >= 0) throw new EventIdConflictError(events[duplicateIndex]!.eventId);

    const saved = events.map((event, index) => parseAgentEventV2({
      ...structuredClone(event),
      sequence: expectedSequence + index + 1,
    }));
    const runEvents = this.eventsByRun.get(runId) ?? [];
    runEvents.push(...saved);
    this.eventsByRun.set(runId, runEvents);
    for (const event of saved) this.eventsById.set(event.eventId, event);
    this.sequences.set(runId, expectedSequence + saved.length);
    return structuredClone(saved);
  }

  public async reserveSequence(runId: string, expectedSequence: number, count: number): Promise<number[]> {
    this.assertSequenceInput(expectedSequence);
    if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError('sequence reservation count must be a positive safe integer');
    this.assertExpectedSequence(runId, expectedSequence);
    const reserved = Array.from({ length: count }, (_, index) => expectedSequence + index + 1);
    this.sequences.set(runId, expectedSequence + count);
    return reserved;
  }

  public async readRun(runId: string, afterSequence: number, limit: number): Promise<AgentEventEnvelopeV2[]> {
    this.assertSequenceInput(afterSequence);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('event read limit must be a positive safe integer');
    return structuredClone((this.eventsByRun.get(runId) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit));
  }

  public async findById(eventId: string): Promise<AgentEventEnvelopeV2 | null> {
    const event = this.eventsById.get(eventId);
    return event === undefined ? null : structuredClone(event);
  }

  public async currentSequence(runId: string): Promise<number> {
    return this.sequences.get(runId) ?? 0;
  }

  public async saveMessage(message: AgentMessageV2, expectedVersion: number | null): Promise<StoredAgentMessageV2> {
    const parsed = parseAgentMessageV2(structuredClone(message));
    const current = this.messages.get(parsed.id);
    const actualVersion = current?.version ?? null;
    if ((current === undefined && expectedVersion !== null)
      || (current !== undefined && expectedVersion !== current.version)) {
      throw new MessageVersionConflictError(parsed.id, expectedVersion, actualVersion);
    }
    const stored = { message: parsed, version: (current?.version ?? 0) + 1 };
    this.messages.set(parsed.id, stored);
    return structuredClone(stored);
  }

  public async getMessage(id: string): Promise<StoredAgentMessageV2 | null> {
    const stored = this.messages.get(id);
    return stored === undefined ? null : structuredClone(stored);
  }

  public async listMessagesByRun(runId: string): Promise<StoredAgentMessageV2[]> {
    return structuredClone([...this.messages.values()].filter(({ message }) => message.runId === runId));
  }

  private assertExpectedSequence(runId: string, expectedSequence: number): void {
    const actual = this.sequences.get(runId) ?? 0;
    if (actual !== expectedSequence) throw new SequenceConflictError(runId, expectedSequence, actual);
  }

  private assertSequenceInput(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('sequence must be a non-negative safe integer');
  }

  private matchesPending(saved: AgentEventEnvelopeV2, pending: PendingAgentEventV2): boolean {
    const { sequence: _sequence, ...unsequenced } = saved;
    return isDeepStrictEqual(unsequenced, pending);
  }
}
