import type { AgentEventPayloadMap, EventFactoryV2Like, EventPublisherV2Like, IdGenerator } from '../contracts/index.js';
import type { EventCreationContextV2 } from '../contracts/event-publisher.js';
import type { ModelAttemptEvent, ModelAttemptObserver } from './model-attempt-observer.js';
import type { ModelFailureCategory } from './model-failure.js';

export interface V2ModelAttemptObserverOptions {
  factory: EventFactoryV2Like;
  publisher: EventPublisherV2Like;
  provider: string;
  model: string;
  correlationId: string | ((runId: string) => string);
  ids?: IdGenerator;
  now?: () => number;
}

/** Projects retry attempts into the common V2 event stream without owning model control flow. */
export class V2ModelAttemptObserver implements ModelAttemptObserver {
  private readonly startedAt = new Map<string, number>();
  private readonly attemptIds = new Map<string, string>();
  private readonly now: () => number;
  private readonly ids: IdGenerator;

  public constructor(private readonly options: V2ModelAttemptObserverOptions) {
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? { next: (prefix) => `${prefix}-${crypto.randomUUID()}` };
  }

  public async record(event: ModelAttemptEvent): Promise<void> {
    const key = this.key(event);
    if (event.type === 'started') {
      this.startedAt.set(key, this.now());
      this.attemptIds.set(key, this.ids.next('attempt'));
      return;
    }
    if (event.type === 'retry_scheduled') {
      await this.publish('MODEL_RETRY_SCHEDULED', event, {
        attempt: event.attempt, reasonCode: event.category, delayMs: event.delayMs,
      });
      return;
    }
    if (event.type === 'failed') {
      const durationMs = Math.max(0, this.now() - (this.startedAt.get(key) ?? this.now()));
      await this.publish('MODEL_CALL_FAILED', event, {
        error: { code: 'MODEL_ERROR', message: `Model attempt failed: ${event.category}.`, retryable: event.retryable, details: { category: event.category } },
        attempt: event.attempt, retryable: event.retryable, durationMs,
      });
    }
    this.startedAt.delete(key);
    this.attemptIds.delete(key);
  }

  private async publish<T extends keyof AgentEventPayloadMap>(type: T, event: ModelAttemptEvent, payload: AgentEventPayloadMap[T]): Promise<void> {
    const attemptId = this.attemptIds.get(this.key(event));
    const context: EventCreationContextV2 = {
      runId: event.runId,
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      ...(event.replyId === undefined ? {} : { replyId: event.replyId }),
      ...(event.streamId === undefined ? {} : { streamId: event.streamId }),
      correlationId: typeof this.options.correlationId === 'function' ? this.options.correlationId(event.runId) : this.options.correlationId,
      visibility: 'audit',
      durability: 'durable',
      stepId: event.stepId,
      ...(attemptId === undefined ? {} : { attemptId }),
    };
    await this.options.publisher.publish(this.options.factory.create(type, context, payload)).then(() => undefined);
  }

  private key(event: Pick<ModelAttemptEvent, 'runId' | 'stepId' | 'attempt'>): string {
    return `${event.runId}:${event.stepId}:${event.attempt}`;
  }
}

export function modelFailureCategory(value: unknown): ModelFailureCategory {
  const allowed = new Set<ModelFailureCategory>(['auth', 'rate_limit', 'server', 'network', 'timeout', 'protocol', 'aborted', 'context_length', 'output_truncated']);
  return typeof value === 'string' && allowed.has(value as ModelFailureCategory) ? value as ModelFailureCategory : 'protocol';
}
