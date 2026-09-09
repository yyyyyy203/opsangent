import type { AgentMessage, ChatModel, ModelCallOptions, ModelResponse, ModelStreamEvent, Tool } from '../contracts/index.js';
import { ModelFailure, type ModelFailureCategory } from './model-failure.js';
import { NOOP_MODEL_ATTEMPT_OBSERVER, type ModelAttemptObserver } from './model-attempt-observer.js';

export interface RetryingChatModelOptions {
  maxAttempts: number;
  retryDelayMs?: number | ((attempt: number, error: ModelFailure) => number);
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  observer?: ModelAttemptObserver;
  fallback?: ChatModel;
  fallbackProvider?: string;
  fallbackModel?: string;
  onFallback?: (info: { runId: string; stepId: string; sessionId?: string; replyId?: string; streamId?: string; reason: ModelFailure; fromAttempt: number }) => void | Promise<void>;
}

/** Retries only failures that happen before any stream item is exposed to the caller. */
export class RetryingChatModel implements ChatModel {
  private readonly options: Required<Pick<RetryingChatModelOptions, 'maxAttempts'>> & Omit<RetryingChatModelOptions, 'maxAttempts'>;

  public constructor(
    private readonly primary: ChatModel,
    options: RetryingChatModelOptions,
  ) {
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0) throw new RangeError('maxAttempts must be a positive safe integer');
    this.options = { ...options, observer: options.observer ?? NOOP_MODEL_ATTEMPT_OBSERVER, sleep: options.sleep ?? defaultSleep };
  }

  public async *stream(
    messages: AgentMessage[], tools: Tool[], callOptions: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    let lastError: ModelFailure | undefined;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        return yield* this.runAttempt(this.primary, messages, tools, callOptions, attempt);
      } catch (error) {
        if (error instanceof ExposedStreamFailure) throw error.originalError;
        const failure = asModelFailure(error);
        lastError = failure;
        await this.options.observer!.record({ type: 'failed', runId: callOptions.runId, stepId: callOptions.stepId, ...identityFields(callOptions), attempt, category: categoryOf(failure), retryable: failure.retryable });
        if (failure.disposition !== 'retryable' || !failure.retryable || attempt >= this.options.maxAttempts) break;
        const delayMs = this.delay(attempt, failure);
        if (delayMs === undefined) break;
        await this.options.observer!.record({ type: 'retry_scheduled', runId: callOptions.runId, stepId: callOptions.stepId, ...identityFields(callOptions), attempt, category: categoryOf(failure), delayMs });
        await this.options.sleep!(delayMs, callOptions.signal);
      }
    }
    if (this.options.fallback !== undefined && (lastError === undefined || lastError.fallbackAllowed)) {
      if (lastError !== undefined) await this.options.onFallback?.({ runId: callOptions.runId, stepId: callOptions.stepId, ...identityFields(callOptions), reason: lastError, fromAttempt: this.options.maxAttempts });
      return yield* this.runAttempt(this.options.fallback, messages, tools, callOptions, 1);
    }
    throw lastError ?? new ModelFailure('protocol', 'Model call failed without an error.', false);
  }

  private async *runAttempt(
    model: ChatModel, messages: AgentMessage[], tools: Tool[], options: ModelCallOptions, attempt: number,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    await this.options.observer!.record({ type: 'started', runId: options.runId, stepId: options.stepId, ...identityFields(options), attempt });
    const upstream = model.stream(messages, tools, options);
    let exposed = false;
    try {
      while (true) {
        const item = await upstream.next();
        if (item.done) {
          await this.options.observer!.record({ type: 'succeeded', runId: options.runId, stepId: options.stepId, ...identityFields(options), attempt, ...(item.value.usage === undefined ? {} : { usage: item.value.usage }) });
          return item.value;
        }
        exposed = true;
        yield item.value;
      }
    } catch (error) {
      if (exposed) throw new ExposedStreamFailure(error);
      throw error;
    }
  }

  private delay(attempt: number, error: ModelFailure): number | undefined {
    const value = typeof this.options.retryDelayMs === 'function' ? this.options.retryDelayMs(attempt, error) : this.options.retryDelayMs ?? 0;
    if (!Number.isFinite(value) || value < 0) throw new RangeError('retry delay must be finite and non-negative');
    const retryAfterMs = error.details.retryAfterMs;
    if (typeof retryAfterMs === 'number' && retryAfterMs > 2_000) return undefined;
    const requestedDelay = typeof retryAfterMs === 'number' ? Math.max(value, retryAfterMs) : value;
    return Math.min(2_000, Math.floor(requestedDelay));
  }
}

function identityFields(options: Pick<ModelCallOptions, 'sessionId' | 'replyId' | 'streamId'>): { sessionId?: string; replyId?: string; streamId?: string } {
  return {
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.replyId === undefined ? {} : { replyId: options.replyId }),
    ...(options.streamId === undefined ? {} : { streamId: options.streamId }),
  };
}

class ExposedStreamFailure extends Error {
  public readonly originalError: unknown;

  public constructor(originalError: unknown) {
    super('Model stream failed after output was exposed.');
    this.name = 'ExposedStreamFailure';
    this.originalError = originalError;
  }
}

function asModelFailure(error: unknown): ModelFailure {
  if (error instanceof ModelFailure) return error;
  return new ModelFailure('protocol', error instanceof Error ? error.message : 'Model call failed.', false);
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(asError(signal.reason)); return; }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(asError(signal.reason)); }, { once: true });
  });
}

const MODEL_CATEGORIES: ReadonlySet<string> = new Set([
  'auth', 'rate_limit', 'server', 'network', 'timeout', 'protocol', 'aborted', 'context_length', 'output_truncated',
]);

function categoryOf(failure: ModelFailure): ModelFailureCategory {
  return typeof failure.details.category === 'string' && MODEL_CATEGORIES.has(failure.details.category)
    ? failure.details.category as ModelFailureCategory
    : 'protocol';
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'Operation aborted.');
}
