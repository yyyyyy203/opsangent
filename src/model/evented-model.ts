import type { AgentEventPayloadMap, AgentEventTypeV2, AgentMessage, ChatModel, Clock, IdGenerator, ModelCallOptions, ModelResponse, ModelStreamEvent, Tool } from '../contracts/index.js';
import { toAgentError } from '../contracts/errors.js';
import type { EventCreationContextV2 } from '../contracts/event-publisher.js';
import type { EventFactoryV2 as EventFactoryImplementation } from '../event/v2/event-factory.js';
import type { EventPublisherV2Like } from '../contracts/event-publisher.js';

export interface EventedChatModelOptions {
  provider: string;
  model: string;
  purpose: string;
  correlationId: string | ((runId: string) => string);
  messageId?: string;
  clock?: Clock;
  ids?: IdGenerator;
}

export class EventedChatModel implements ChatModel {
  public constructor(
    private readonly delegate: ChatModel,
    private readonly publisher: EventPublisherV2Like,
    private readonly factory: EventFactoryImplementation,
    private readonly config: EventedChatModelOptions,
  ) {}

  public async *stream(
    messages: AgentMessage[], tools: Tool[], options: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    const clock = this.config.clock ?? { now: () => new Date() };
    const ids = this.config.ids ?? { next: (prefix: string) => `${prefix}-${crypto.randomUUID()}` };
    const attemptId = ids.next('attempt');
    const messageId = this.config.messageId ?? ids.next('message');
    const blockId = ids.next('block');
    const startedAt = clock.now().getTime();
    const base = { runId: options.runId, correlationId: typeof this.config.correlationId === 'function' ? this.config.correlationId(options.runId) : this.config.correlationId, stepId: options.stepId, attemptId };
    await this.publish('MODEL_CALL_STARTED', base, {
      provider: this.config.provider, model: this.config.model, purpose: this.config.purpose, attempt: 1, inputSummary: 'model input available to internal audit only',
    });
    let text = '';
    let textStarted = false;
    const upstream = this.delegate.stream(messages, tools, options);
    try {
      while (true) {
        const item = await upstream.next();
        if (item.done) {
          if (textStarted) {
            await this.publish('CONTENT_BLOCK_COMPLETED', base, { messageId, blockId, blockSummary: 'text output', index: 0, block: { type: 'text', blockId, text } });
            await this.publish('MESSAGE_COMPLETED', base, { messageId, completedAt: clock.now().toISOString(), ...(item.value.usage === undefined ? {} : { usage: item.value.usage }) });
          }
          await this.publish('MODEL_CALL_COMPLETED', base, {
            provider: this.config.provider, model: this.config.model, attempt: 1,
            ...(item.value.usage === undefined ? {} : { usage: item.value.usage }), durationMs: Math.max(0, clock.now().getTime() - startedAt),
          });
          return item.value;
        }
        if (item.value.type === 'text_delta') {
          if (!textStarted) {
            textStarted = true;
            await this.publish('MESSAGE_STARTED', base, { messageId, role: 'assistant', status: 'streaming' });
            await this.publish('CONTENT_BLOCK_STARTED', base, { messageId, blockId, blockType: 'text', index: 0 });
          }
          text += item.value.delta;
          await this.publish('CONTENT_BLOCK_DELTA', base, { messageId, blockId, delta: item.value.delta, index: 0, blockType: 'text' });
        }
        yield item.value;
      }
    } catch (error) {
      const failure = toAgentError(error, 'MODEL_ERROR');
      if (textStarted) {
        await this.publish('CONTENT_BLOCK_COMPLETED', base, { messageId, blockId, blockSummary: 'partial text output' , index: 0, block: { type: 'text', blockId, text } });
        await this.publish('MESSAGE_FAILED', base, { messageId, error: { code: failure.code, message: failure.message, retryable: failure.retryable } });
      }
      await this.publish('MODEL_CALL_FAILED', base, { error: { code: failure.code, message: failure.message, retryable: failure.retryable }, attempt: 1, retryable: failure.retryable, durationMs: Math.max(0, clock.now().getTime() - startedAt) });
      throw error;
    }
  }

  private publish<T extends AgentEventTypeV2>(
    type: T,
    ids: { runId: string; correlationId: string; stepId?: string; attemptId?: string; toolCallId?: string },
    payload: AgentEventPayloadMap[T],
  ): Promise<unknown> {
    const context: EventCreationContextV2 = {
      runId: ids.runId, correlationId: ids.correlationId, visibility: type.startsWith('CONTENT_') || type.startsWith('MESSAGE_') ? 'public' : 'audit', durability: type === 'CONTENT_BLOCK_DELTA' ? 'transient' : 'durable',
      ...(ids.stepId === undefined ? {} : { stepId: ids.stepId }), ...(ids.attemptId === undefined ? {} : { attemptId: ids.attemptId }), ...(ids.toolCallId === undefined ? {} : { toolCallId: ids.toolCallId }),
    };
    const event = this.factory.create(type, context, payload);
    return this.publisher.publish(event);
  }
}
