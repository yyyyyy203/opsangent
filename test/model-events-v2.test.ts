import { describe, expect, it } from 'vitest';
import type { AgentMessage, Clock, IdGenerator, ModelResponse, Tool } from '../src/contracts/index.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { EventedChatModel } from '../src/model/evented-model.js';
import type { EventPublisherV2 } from '../src/event/v2/event-publisher.js';

const clock: Clock = { now: () => new Date('2026-09-08T00:00:00.000Z') };
const ids: IdGenerator = { next: (prefix) => `${prefix}-1` };
const messages: AgentMessage[] = [{ id: 'msg-0', role: 'user', createdAt: clock.now().toISOString(), blocks: [{ type: 'text', text: 'check' }] }];
const tools: Tool[] = [];

async function collect(model: EventedChatModel): Promise<void> {
  const stream = model.stream(messages, tools, { signal: new AbortController().signal, runId: 'run-1', stepId: 'step-1' });
  while (true) { const item = await stream.next(); if (item.done) return; }
}

describe('EventedChatModel', () => {
  it('publishes model lifecycle and text block events while preserving ModelResponse', async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const publisher = { publish: (event: { type: string; payload: unknown }) => { events.push(event); return Promise.resolve(event); } } as unknown as EventPublisherV2;
    const base = {
      async *stream(): AsyncGenerator<{ type: 'text_delta'; delta: string }, ModelResponse> {
        await Promise.resolve();
        yield { type: 'text_delta', delta: 'hi' };
        return { text: 'hi', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 1 } };
      },
    };
    const model = new EventedChatModel(base, publisher, new EventFactoryV2(clock, ids), {
      provider: 'openai-compatible', model: 'deepseek-chat', purpose: 'diagnosis', correlationId: 'corr-1', messageId: 'msg-1',
    });
    await collect(model);
    expect(events.map((event) => event.type)).toEqual([
      'MODEL_CALL_STARTED', 'MESSAGE_STARTED', 'CONTENT_BLOCK_STARTED', 'CONTENT_BLOCK_DELTA',
      'CONTENT_BLOCK_COMPLETED', 'MESSAGE_COMPLETED', 'MODEL_CALL_COMPLETED',
    ]);
    const messageCompleted = events.find((event) => event.type === 'MESSAGE_COMPLETED')?.payload as { finishReason?: string };
    const completed = events.at(-1)?.payload as { usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }; durationMs?: unknown; finishReason?: string; cacheHit?: boolean };
    expect(messageCompleted.finishReason).toBe('stop');
    expect(completed.usage).toEqual({ inputTokens: 2, outputTokens: 1, cachedInputTokens: 1 });
    expect(completed.finishReason).toBe('stop');
    expect(completed.cacheHit).toBe(true);
    expect(typeof completed.durationMs).toBe('number');
  });
});
