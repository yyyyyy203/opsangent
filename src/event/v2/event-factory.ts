import type { Clock, IdGenerator } from '../../contracts/common.js';
import type {
  AgentEventPayloadMap,
  AgentEventTypeV2,
  EventDurabilityV2,
  EventVisibilityV2,
  PendingAgentEventV2,
} from '../../contracts/index.js';
import { parseAgentEventV2Payload } from '../../contracts/event-v2/catalog.js';

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

export class EventFactoryV2 {
  public constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  public create<T extends AgentEventTypeV2>(
    type: T,
    context: EventCreationContextV2,
    payload: AgentEventPayloadMap[T],
  ): PendingAgentEventV2<T> {
    const parsedPayload = parseAgentEventV2Payload(type, payload);
    return {
      schemaVersion: 2,
      eventId: this.ids.next('event'),
      type,
      payload: parsedPayload,
      runId: context.runId,
      correlationId: context.correlationId,
      timestamp: this.clock.now().toISOString(),
      visibility: context.visibility,
      durability: context.durability,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.replyId === undefined ? {} : { replyId: context.replyId }),
      ...(context.streamId === undefined ? {} : { streamId: context.streamId }),
      ...(context.stepId === undefined ? {} : { stepId: context.stepId }),
      ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
      ...(context.toolCallId === undefined ? {} : { toolCallId: context.toolCallId }),
      ...(context.parentRunId === undefined ? {} : { parentRunId: context.parentRunId }),
      ...(context.causationId === undefined ? {} : { causationId: context.causationId }),
    } as PendingAgentEventV2<T>;
  }
}
