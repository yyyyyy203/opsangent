import OpenAI from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from 'openai/resources/chat/completions/completions.js';
import { ModelFailure } from '../model-failure.js';
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleRequest,
  OpenAICompatibleStreamChunk,
  OpenAICompatibleTool,
} from './types.js';

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface OpenAICompatibleClient {
  stream(
    request: OpenAICompatibleRequest,
    options: OpenAICompatibleClientRequestOptions,
  ): AsyncIterable<OpenAICompatibleStreamChunk>;
}

export interface OpenAICompatibleClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  requestHeaders?: (input: { runId?: string; stepId?: string }) => HeadersInit;
}

export interface OpenAICompatibleClientRequestOptions {
  signal: AbortSignal;
  requestContext?: { runId?: string; stepId?: string };
}

export function createOpenAICompatibleClient(options: OpenAICompatibleClientOptions): OpenAICompatibleClient {
  return new OpenAICompatibleSdkClient(options);
}

class OpenAICompatibleSdkClient implements OpenAICompatibleClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly requestHeaders: OpenAICompatibleClientOptions['requestHeaders'];

  public constructor(options: OpenAICompatibleClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (options.apiKey.trim().length === 0) throw new ModelFailure('auth', 'Model API key is required.', false);
    this.apiKey = options.apiKey;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImplementation !== 'function') throw new ModelFailure('protocol', 'No fetch implementation is available.', false);
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) throw new RangeError('maxResponseBytes must be a positive safe integer');
    this.requestHeaders = options.requestHeaders;
  }

  public async *stream(
    request: OpenAICompatibleRequest,
    options: OpenAICompatibleClientRequestOptions,
  ): AsyncIterable<OpenAICompatibleStreamChunk> {
    const tracker: ResponseTracker = { doneMarkerSeen: false, decoder: new TextDecoder(), tail: '' };
    const sdkClient = new OpenAI({
      baseURL: this.baseUrl,
      apiKey: this.apiKey,
      fetch: this.createFetch(tracker),
      maxRetries: 0,
    });
    let upstream: AsyncIterator<ChatCompletionChunk> | undefined;
    let upstreamCompleted = false;
    try {
      const sdkStream = await sdkClient.chat.completions.create(toSdkRequest(request), {
        signal: options.signal,
        ...(this.requestHeaders === undefined ? {} : { headers: new Headers(this.requestHeaders(options.requestContext ?? {})) }),
      });
      upstream = sdkStream[Symbol.asyncIterator]();
      while (true) {
        const item = await upstream.next();
        if (item.done) {
          upstreamCompleted = true;
          break;
        }
        yield normalizeChunk(item.value);
      }
      if (!tracker.doneMarkerSeen) throw new ModelFailure('protocol', 'Model stream ended without a done marker.', false);
    } catch (error) {
      const boundaryFailure = findBoundaryFailure(error);
      if (boundaryFailure !== undefined) throw boundaryFailure;
      throw error;
    } finally {
      if (!upstreamCompleted) await upstream?.return?.();
    }
  }

  private createFetch(tracker: ResponseTracker): typeof fetch {
    return async (input, init) => {
      const response = await this.fetchImplementation(input, init);
      if (!response.ok) return response;
      const contentType = response.headers.get('content-type');
      if (contentType === null || !contentType.toLowerCase().startsWith('text/event-stream')) {
        await cancelBody(response.body);
        throw new ModelFailure('protocol', 'Model response was not an event stream.', false);
      }
      if (response.body === null) throw new ModelFailure('protocol', 'Model response did not contain a stream body.', false);
      const body = limitAndTrackBody(response.body, tracker, this.maxResponseBytes);
      const responseInit: ResponseInit = { status: response.status, headers: response.headers };
      if (response.statusText.length > 0) responseInit.statusText = response.statusText;
      return new Response(body, responseInit);
    };
  }
}

interface ResponseTracker {
  doneMarkerSeen: boolean;
  decoder: TextDecoder;
  tail: string;
}

function toSdkRequest(request: OpenAICompatibleRequest): ChatCompletionCreateParamsStreaming {
  return {
    model: request.model,
    messages: request.messages.map(toSdkMessage),
    stream: true,
    ...(request.stream_options === undefined ? {} : { stream_options: { include_usage: request.stream_options.include_usage } }),
    ...(request.tools === undefined ? {} : { tools: request.tools.map(toSdkTool) }),
  };
}

function toSdkMessage(message: OpenAICompatibleMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user': {
      const userMessage: ChatCompletionUserMessageParam = { role: 'user', content: message.content };
      return userMessage;
    }
    case 'assistant': {
      const assistantMessage: ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: message.content,
        ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls.map((call) => ({
          id: call.id,
          type: call.type,
          function: { name: call.function.name, arguments: call.function.arguments },
        })) }),
      };
      return assistantMessage;
    }
    case 'tool': {
      const toolMessage: ChatCompletionToolMessageParam = {
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content: message.content,
      };
      return toolMessage;
    }
    default:
      return assertNever(message);
  }
}

function toSdkTool(tool: OpenAICompatibleTool): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}

function normalizeChunk(chunk: ChatCompletionChunk): OpenAICompatibleStreamChunk {
  return {
    choices: chunk.choices.map((choice) => ({
      index: choice.index,
      delta: {
        ...(choice.delta.content === undefined ? {} : { content: choice.delta.content }),
        ...(choice.delta.tool_calls === undefined ? {} : { tool_calls: choice.delta.tool_calls.map((toolCall) => ({
          index: toolCall.index,
          ...(toolCall.id === undefined ? {} : { id: toolCall.id }),
          ...(toolCall.type === undefined ? {} : { type: toolCall.type }),
          ...(toolCall.function === undefined ? {} : { function: {
            ...(toolCall.function.name === undefined ? {} : { name: toolCall.function.name }),
            ...(toolCall.function.arguments === undefined ? {} : { arguments: toolCall.function.arguments }),
          } }),
        })) }),
      },
      finish_reason: choice.finish_reason,
    })),
    ...(chunk.usage === null || chunk.usage === undefined ? {} : {
      usage: {
        prompt_tokens: chunk.usage.prompt_tokens,
        completion_tokens: chunk.usage.completion_tokens,
        ...(chunk.usage.prompt_tokens_details === null || chunk.usage.prompt_tokens_details === undefined ? {} : {
          prompt_tokens_details: { cached_tokens: chunk.usage.prompt_tokens_details.cached_tokens },
        }),
      },
    }),
  };
}

function limitAndTrackBody(
  body: ReadableStream<Uint8Array>,
  tracker: ResponseTracker,
  maxResponseBytes: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          trackText(tracker, tracker.decoder.decode());
          controller.close();
          return;
        }
        bytes += item.value.byteLength;
        if (bytes > maxResponseBytes) {
          await reader.cancel();
          controller.error(new ModelFailure('protocol', 'Model response exceeded the configured size limit.', false));
          return;
        }
        trackText(tracker, tracker.decoder.decode(item.value, { stream: true }));
        controller.enqueue(item.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function trackText(tracker: ResponseTracker, text: string): void {
  tracker.tail = `${tracker.tail}${text}`.slice(-64);
  if (tracker.tail.includes('[DONE]')) tracker.doneMarkerSeen = true;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body !== null) await body.cancel().catch(() => undefined);
}

function findBoundaryFailure(error: unknown): ModelFailure | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof ModelFailure) return current;
    const cause = asRecord(current).cause;
    if (cause === undefined || cause === current) return undefined;
    current = cause;
  }
  return undefined;
}

function normalizeBaseUrl(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ModelFailure('protocol', 'Model base URL is required.', false);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ModelFailure('protocol', 'Model base URL is invalid.', false);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new ModelFailure('protocol', 'Model base URL is not allowed.', false);
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function assertNever(value: never): never {
  throw new ModelFailure('protocol', `Unsupported model message role: ${String(value)}.`, false);
}
