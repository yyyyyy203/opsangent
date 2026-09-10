import { describe, expect, it } from 'vitest';
import type { ModelCallOptions, ModelResponse, ModelStreamEvent } from '../src/contracts/index.js';
import { OpenAICompatibleChatModel } from '../src/model/openai-compatible/model.js';
import type { OpenAICompatibleClient, OpenAICompatibleClientRequestOptions } from '../src/model/openai-compatible/client.js';
import type { OpenAICompatibleRequest, OpenAICompatibleStreamChunk } from '../src/model/openai-compatible/types.js';

describe('OpenAI-compatible ChatModel', () => {
  it('returns raw tool calls, usage and finish reason while exposing only text deltas', async () => {
    const client = new FakeClient([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tc-1', type: 'function', function: { name: 'metrics.query', arguments: '{"window":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"5m"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 12 } } },
    ]);
    const model = new OpenAICompatibleChatModel(client, { model: 'test-model' });

    const result = await drainModel(model.stream([], [], callOptions()));

    expect(result.events).toEqual([]);
    expect(result.returnValue).toEqual({
      toolCalls: [],
      rawToolCalls: [{ id: 'tc-1', name: 'metrics.query', arguments: '{"window":"5m"}' }],
      usage: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 12 },
      finishReason: 'tool_calls',
    });
    expect(client.requests[0]).toMatchObject({ model: 'test-model', stream: true });
  });

  it('streams text and maps usage through the same assembler', async () => {
    const client = new FakeClient([
      { choices: [{ index: 0, delta: { content: '诊断' } }] },
      { choices: [{ index: 0, delta: { content: '完成' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]);
    const model = new OpenAICompatibleChatModel(client, { model: 'test-model', clock: () => 1_000 });

    const result = await drainModel(model.stream([], [], callOptions({ deadline: 2_000 })));

    expect(result.events).toEqual([
      { type: 'text_delta', delta: '诊断' },
      { type: 'text_delta', delta: '完成' },
    ]);
    expect(result.returnValue).toMatchObject({ text: '诊断完成', usage: { inputTokens: 10, outputTokens: 2 }, finishReason: 'stop' });
  });

  it('does not call the client when the absolute deadline is already expired', async () => {
    const client = new FakeClient([]);
    const model = new OpenAICompatibleChatModel(client, { model: 'test-model', clock: () => 1_000 });
    const stream = model.stream([], [], callOptions({ deadline: 999 }));

    await expect(stream.next()).rejects.toMatchObject({ disposition: 'aborted', details: { category: 'aborted', phase: 'run_deadline' } });
    expect(client.calls).toBe(0);
  });

  it('propagates parent cancellation and closes the upstream iterator', async () => {
    const controller = new AbortController();
    const client = new AbortWaitingClient();
    const model = new OpenAICompatibleChatModel(client, { model: 'test-model' });
    const stream = model.stream([], [], { ...callOptions(), signal: controller.signal });
    const pending = stream.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ disposition: 'aborted' });
    expect(client.signal?.aborted).toBe(true);
    expect(client.returned).toBe(true);
  });

  it('forwards consumer return to the upstream iterator', async () => {
    const client = new FakeClient([{ choices: [{ index: 0, delta: { content: 'partial' } }] }]);
    const model = new OpenAICompatibleChatModel(client, { model: 'test-model' });
    const stream = model.stream([], [], callOptions());

    await expect(stream.next()).resolves.toMatchObject({ done: false, value: { type: 'text_delta', delta: 'partial' } });
    await stream.return({ toolCalls: [] });
    expect(client.returned).toBe(true);
  });

  it('classifies a pre-output network error and does not turn a visible stream failure into a replay', async () => {
    const preOutput = new ErrorThrowingClient(new TypeError('network disconnected'));
    const model = new OpenAICompatibleChatModel(preOutput, { model: 'test-model' });
    await expect(drainModel(model.stream([], [], callOptions()))).rejects.toMatchObject({ disposition: 'retryable', details: { category: 'network' } });

    const partial = new PartialThenErrorClient();
    const partialModel = new OpenAICompatibleChatModel(partial, { model: 'test-model' });
    const stream = partialModel.stream([], [], callOptions());
    await expect(stream.next()).resolves.toMatchObject({ value: { type: 'text_delta', delta: 'partial' }, done: false });
    await expect(stream.next()).rejects.toMatchObject({ details: { category: 'network' } });
    expect(partial.returned).toBe(true);
  });

  it('uses the model clock when classifying HTTP-date retry-after values', async () => {
    const providerError = Object.assign(new Error('provider response'), {
      status: 429,
      headers: { 'retry-after': 'Thu, 01 Jan 1970 00:00:02 GMT' },
    });
    const model = new OpenAICompatibleChatModel(new ErrorThrowingClient(providerError), {
      model: 'test-model',
      clock: () => 1_000,
    });

    await expect(drainModel(model.stream([], [], callOptions()))).rejects.toMatchObject({
      details: { category: 'rate_limit', retryAfterMs: 1_000 },
    });
  });
});

async function drainModel(stream: AsyncGenerator<ModelStreamEvent, ModelResponse>) {
  const events: ModelStreamEvent[] = [];
  while (true) {
    const item = await stream.next();
    if (item.done) return { events, returnValue: item.value };
    events.push(item.value);
  }
}

function callOptions(overrides: Partial<ModelCallOptions> = {}): ModelCallOptions {
  return { runId: 'run-1', stepId: 'step-1', signal: new AbortController().signal, ...overrides };
}

class FakeClient implements OpenAICompatibleClient {
  public calls = 0;
  public returned = false;
  public requests: OpenAICompatibleRequest[] = [];

  public constructor(private readonly chunks: readonly OpenAICompatibleStreamChunk[]) {}

  public stream(request: OpenAICompatibleRequest, options: OpenAICompatibleClientRequestOptions): AsyncIterable<OpenAICompatibleStreamChunk> {
    void request;
    void options;
    this.calls += 1;
    this.requests.push(request);
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<OpenAICompatibleStreamChunk> {
    await Promise.resolve();
    try {
      for (const chunk of this.chunks) yield chunk;
    } finally {
      this.returned = true;
    }
  }
}

class AbortWaitingClient implements OpenAICompatibleClient {
  public signal: AbortSignal | undefined;
  public returned = false;

  public stream(_request: OpenAICompatibleRequest, options: OpenAICompatibleClientRequestOptions): AsyncIterable<OpenAICompatibleStreamChunk> {
    void _request;
    this.signal = options.signal;
    return this.iterate(options.signal);
  }

  private async *iterate(signal: AbortSignal): AsyncGenerator<OpenAICompatibleStreamChunk> {
    try {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      for (const item of [] as OpenAICompatibleStreamChunk[]) yield item;
      throw new Error('upstream aborted');
    } finally {
      this.returned = true;
    }
  }
}

class ErrorThrowingClient implements OpenAICompatibleClient {
  public constructor(private readonly error: Error) {}

  public stream(_request: OpenAICompatibleRequest, _options: OpenAICompatibleClientRequestOptions): AsyncIterable<OpenAICompatibleStreamChunk> {
    void _request;
    void _options;
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<OpenAICompatibleStreamChunk> {
    await Promise.resolve();
    for (const item of [] as OpenAICompatibleStreamChunk[]) yield item;
    throw this.error;
  }
}

class PartialThenErrorClient implements OpenAICompatibleClient {
  public returned = false;

  public stream(_request: OpenAICompatibleRequest, _options: OpenAICompatibleClientRequestOptions): AsyncIterable<OpenAICompatibleStreamChunk> {
    void _request;
    void _options;
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<OpenAICompatibleStreamChunk> {
    try {
      await Promise.resolve();
      yield { choices: [{ index: 0, delta: { content: 'partial' } }] };
      throw new TypeError('network disconnected');
    } finally {
      this.returned = true;
    }
  }
}
