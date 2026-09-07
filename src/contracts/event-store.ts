import type { AgentEventEnvelopeV2, AgentEventTypeV2 } from './event-v2/index.js';
import type { AgentMessageV2 } from './message-v2/index.js';

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

export class StoredDataCorruptionError extends Error {
  public constructor(public readonly recordType: 'event' | 'message', public readonly recordId: string) {
    super(`stored ${recordType} is corrupt: ${recordId}`);
    this.name = 'StoredDataCorruptionError';
  }
}

export type PendingAgentEventV2<T extends AgentEventTypeV2 = AgentEventTypeV2> =
  T extends AgentEventTypeV2 ? Omit<AgentEventEnvelopeV2<T>, 'sequence'> : never;

export interface EventStore {
  append(
    runId: string,
    expectedSequence: number,
    events: readonly PendingAgentEventV2[],
  ): Promise<AgentEventEnvelopeV2[]>;
  reserveSequence(runId: string, expectedSequence: number, count: number): Promise<number[]>;
  readRun(runId: string, afterSequence: number, limit: number): Promise<AgentEventEnvelopeV2[]>;
  findById(eventId: string): Promise<AgentEventEnvelopeV2 | null>;
  currentSequence(runId: string): Promise<number>;
}

export interface StoredAgentMessageV2 {
  message: AgentMessageV2;
  version: number;
}

export interface MessageStore {
  saveMessage(message: AgentMessageV2, expectedVersion: number | null): Promise<StoredAgentMessageV2>;
  getMessage(id: string): Promise<StoredAgentMessageV2 | null>;
  listMessagesByRun(runId: string): Promise<StoredAgentMessageV2[]>;
}
