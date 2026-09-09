import type { AgentMessage, ChatModel, ModelCallOptions, ModelResponse, ModelStreamEvent, Tool } from '../../contracts/index.js';
import { ModelFailure } from '../model-failure.js';
import { OpenAIStreamAssembler } from './assembler.js';
import { classifyOpenAICompatibleError } from './error-classifier.js';
import type { OpenAICompatibleClient, OpenAICompatibleClientRequestOptions } from './client.js';
import { formatChatRequest } from './formatter.js';
import type { OpenAICompatibleStreamChunk } from './types.js';

export interface OpenAICompatibleChatModelOptions {
  model: string;
  includeUsage?: boolean;
  clock?: () => number;
}

export class OpenAICompatibleChatModel implements ChatModel {
  public constructor(
    private readonly client: OpenAICompatibleClient,
    private readonly config: OpenAICompatibleChatModelOptions,
  ) {}

  public async *stream(
    messages: AgentMessage[], tools: Tool[], callOptions: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    const clock = this.config.clock ?? Date.now;
    const combined = createCallSignal(callOptions.signal, callOptions.deadline, clock);
    const request = formatChatRequest(messages, tools, {
      model: this.config.model,
      includeUsage: this.config.includeUsage ?? true,
    });
    const upstreamOptions: OpenAICompatibleClientRequestOptions = {
      signal: combined.signal,
      requestContext: { runId: callOptions.runId, stepId: callOptions.stepId },
    };
    let upstream: AsyncIterator<OpenAICompatibleStreamChunk> | undefined;
    let upstreamCompleted = false;
    try {
      const iterable = this.client.stream(request, upstreamOptions);
      upstream = iterable[Symbol.asyncIterator]();
      const assembler = new OpenAIStreamAssembler();
      while (true) {
        const item = await upstream.next();
        if (item.done) {
          upstreamCompleted = true;
          if (combined.deadlineTriggered()) throw deadlineFailure();
          return assembler.finish();
        }
        for (const event of assembler.accept(item.value)) yield event;
      }
    } catch (error) {
      if (combined.deadlineTriggered()) throw deadlineFailure();
      if (callOptions.signal.aborted) throw abortedFailure();
      if (error instanceof ModelFailure) throw error;
      throw classifyOpenAICompatibleError(error, { signal: combined.signal });
    } finally {
      if (!upstreamCompleted) await upstream?.return?.();
      combined.dispose();
    }
  }
}

interface CombinedCallSignal {
  signal: AbortSignal;
  deadlineTriggered: () => boolean;
  dispose: () => void;
}

function createCallSignal(parent: AbortSignal, deadline: number | undefined, clock: () => number): CombinedCallSignal {
  if (parent.aborted) throw abortedFailure();
  if (deadline === undefined) return { signal: parent, deadlineTriggered: () => false, dispose: () => undefined };
  if (!Number.isFinite(deadline)) throw new ModelFailure('protocol', 'Model deadline must be finite.', false);
  const remainingMs = deadline - clock();
  if (remainingMs <= 0) throw deadlineFailure();

  const controller = new AbortController();
  let triggered = false;
  const abortParent = () => controller.abort();
  parent.addEventListener('abort', abortParent, { once: true });
  const timer = setTimeout(() => {
    triggered = true;
    controller.abort();
  }, remainingMs);
  return {
    signal: controller.signal,
    deadlineTriggered: () => triggered,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', abortParent);
    },
  };
}

function deadlineFailure(): ModelFailure {
  return new ModelFailure('aborted', 'Model call exceeded the run deadline.', false, { phase: 'run_deadline' }, { disposition: 'aborted' });
}

function abortedFailure(): ModelFailure {
  return new ModelFailure('aborted', 'Model call was aborted.', false, {}, { disposition: 'aborted' });
}
