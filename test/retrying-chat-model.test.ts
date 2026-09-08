import { describe, expect, it } from 'vitest';
import type { AgentMessage, ChatModel, ModelCallOptions, ModelResponse, ModelStreamEvent, Tool } from '../src/contracts/index.js';
import { ModelFailure } from '../src/model/model-failure.js';
import { RetryingChatModel } from '../src/model/retrying-model.js';
import type { ModelAttemptEvent } from '../src/model/model-attempt-observer.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { EventPublisherV2, InMemoryProjectionFailureSink } from '../src/event/v2/event-publisher.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import { ReplayBufferV2 } from '../src/event/v2/replay-buffer.js';
import { V2ModelAttemptObserver } from '../src/model/v2-attempt-observer.js';

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

  it('projects retry attempts into the V2 event stream', async () => {
    let nextId = 0;
    const store = new InMemoryEventMessageStore();
    const publisher = new EventPublisherV2(store, new ReplayBufferV2({ maxEvents: 10, maxBytes: 10_000 }), new InMemoryProjectionFailureSink());
    const observer = new V2ModelAttemptObserver({
      factory: new EventFactoryV2({ now: () => new Date('2026-09-08T00:00:00.000Z') }, { next: (prefix) => `${prefix}-${++nextId}` }),
      publisher, provider: 'configured', model: 'configured', correlationId: 'corr-1', ids: { next: (prefix) => `${prefix}-1` }, now: () => 100,
    });
    await observer.record({ type: 'started', runId: 'run-1', stepId: 'step-1', attempt: 1 });
    await observer.record({ type: 'retry_scheduled', runId: 'run-1', stepId: 'step-1', attempt: 1, category: 'server', delayMs: 20 });
    const events = await store.readRun('run-1', 0, 10);
    expect(events.map((event) => event.type)).toEqual(['MODEL_RETRY_SCHEDULED']);
    expect(events[0]).toMatchObject({ attemptId: 'attempt-1', stepId: 'step-1', payload: { attempt: 1, reasonCode: 'server', delayMs: 20 } });
  });

  it('invokes the fallback hook only when the primary is exhausted', async () => {
    const primary: ChatModel = { async *stream() { await Promise.resolve(); for (const item of [] as ModelStreamEvent[]) yield item; throw new ModelFailure('server', 'down', true); } };
    const fallback: ChatModel = { async *stream() { await Promise.resolve(); for (const item of [] as ModelStreamEvent[]) yield item; return { text: 'fallback', toolCalls: [] }; } };
    const fallbacks: string[] = [];
    const model = new RetryingChatModel(primary, {
      maxAttempts: 1, fallback, sleep: () => Promise.resolve(),
      onFallback: (info) => { fallbacks.push(`${info.runId}:${String(info.reason.details.category)}`); },
    });
    const stream = model.stream([], [], { runId: 'run-fallback', stepId: 'step-1', signal: new AbortController().signal });
    while (true) { const result = await stream.next(); if (result.done) break; }
    expect(fallbacks).toEqual(['run-fallback:server']);
  });
});
