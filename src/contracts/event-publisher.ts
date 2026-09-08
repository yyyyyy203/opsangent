import type { AgentEventEnvelopeV2, AgentEventPayloadMap, AgentEventTypeV2 } from './event-v2/index.js';
import type { PendingAgentEventV2 } from './event-store.js';
import type { EventDurabilityV2, EventVisibilityV2 } from './event-v2/common.js';

export interface EventCreationContextV2 {
  runId: string;
  correlationId: string;
  visibility: EventVisibilityV2;
  durability: EventDurabilityV2;
  sessionId?: string;
  replyId?: string;
  streamId?: string;
  stepId?: string;
  attemptId?: string;
  toolCallId?: string;
  parentRunId?: string;
  causationId?: string;
}

export interface EventFactoryV2Like {
  create<T extends AgentEventTypeV2>(type: T, context: EventCreationContextV2, payload: AgentEventPayloadMap[T]): PendingAgentEventV2<T>;
}

export interface EventPublisherV2Like {
  publish(event: PendingAgentEventV2): Promise<AgentEventEnvelopeV2>;
}
