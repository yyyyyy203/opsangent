import { describe, expect, it } from 'vitest';
import type { AgentMessage, ChatModel, ModelCallOptions, ModelResponse, ModelStreamEvent, Tool } from '../src/contracts/index.js';
import { ModelFailure } from '../src/model/model-failure.js';
import { RetryingChatModel } from '../src/model/retrying-model.js';
import type { ModelAttemptEvent } from '../src/model/model-attempt-observer.js';

class FlakyModel implements ChatModel {
  public calls = 0;
  public async *stream(messages: AgentMessage[], tools: Tool[], options: ModelCallOptions): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    void messages; void tools; void options;
    await Promise.resolve();
    this.calls += 1;
    if (this.calls === 1) throw new ModelFailure('server', 'temporary', true);
    yield { type: 'text_delta', delta: 'ok' };
    return { text: 'ok', toolCalls: [] };
  }
}

describe('RetryingChatModel', () => {
  it('retries pre-output failures without duplicating stream output', async () => {
    const model = new FlakyModel();
    const events: ModelAttemptEvent[] = [];
    const retrying = new RetryingChatModel(model, {
      maxAttempts: 2,
      retryDelayMs: 10,
      sleep: () => Promise.resolve(),
      observer: { record: (event) => { events.push(event); } },
    });
    const output: string[] = [];
    const stream = retrying.stream([], [], { runId: 'run-1', stepId: 'step-1', signal: new AbortController().signal });
    while (true) {
      const item = await stream.next();
      if (item.done) break;
      if (item.value.type === 'text_delta') output.push(item.value.delta);
    }
    expect(model.calls).toBe(2);
    expect(output).toEqual(['ok']);
    expect(events.map((event) => event.type)).toEqual(['started', 'failed', 'retry_scheduled', 'started', 'succeeded']);
  });

  it('does not retry after partial output has been exposed', async () => {
    const model: ChatModel = {
      async *stream() {
        await Promise.resolve();
        yield { type: 'text_delta', delta: 'partial' } as const;
        throw new ModelFailure('network', 'lost', true);
      },
    };
    const retrying = new RetryingChatModel(model, { maxAttempts: 3, sleep: () => Promise.resolve() });
    const stream = retrying.stream([], [], { runId: 'run-1', stepId: 'step-1', signal: new AbortController().signal });
    await expect(async () => {
      await stream.next();
      await stream.next();
    }).rejects.toThrow('lost');
  });
});
