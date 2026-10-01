import type { AgentEventEnvelopeV2 } from '../contracts/event-v2/index.js';
import type { EventPublisherV2Dependencies, EventPublisherV2Like } from '../contracts/event-publisher.js';
import type { EventStore, MessageStore } from '../contracts/event-store.js';
import type { ReplayBufferV2 } from '../event/v2/replay-buffer.js';

export interface SharedRuntimeEventSource extends EventPublisherV2Like {
  subscribe(projector: {
    name: string;
    project(event: AgentEventEnvelopeV2, options?: { allowSequenceGaps?: boolean }): Promise<void> | void;
  }): () => void;
  replayRun(runId: string, afterSequence?: number, limit?: number): Promise<number>;
}

export interface RuntimeEventPublisher extends EventPublisherV2Like, SharedRuntimeEventSource {}

export interface SharedRuntimeEventPorts {
  store: EventStore & MessageStore;
  events: EventPublisherV2Dependencies;
  /** Parent-owned live source used by child runtime read/stream helpers. */
  source?: SharedRuntimeEventSource;
  /** Parent-owned transient replay buffer used by child stream helpers. */
  replay?: ReplayBufferV2;
}

export interface RuntimeShutdownRegistry {
  register(callback: () => void | Promise<void>): void;
}
