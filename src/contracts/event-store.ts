import type { AgentEventEnvelopeV2, AgentEventTypeV2 } from './event-v2/index.js';
import type { AgentMessageV2 } from './message-v2/index.js';

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
