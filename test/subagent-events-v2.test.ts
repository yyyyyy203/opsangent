import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { adaptSubagentTool } from '../src/tool/adapters/subagent-tool-adapter.js';
import type { AgentEventEnvelopeV2, Clock, EventPublisherV2Like, IdGenerator } from '../src/contracts/index.js';

describe('Subagent tool lifecycle', () => {
  it('emits a child run lifecycle around the delegated tool', async () => {
    const clock: Clock = { now: () => new Date('2026-09-08T00:00:00.000Z') };
    const ids: IdGenerator = { next: (prefix) => `${prefix}-1` };
    const events: AgentEventEnvelopeV2[] = [];
    const publisher: EventPublisherV2Like = {
      publish: (event) => {
        const stored = { ...event, sequence: events.length + 1 } as AgentEventEnvelopeV2;
        events.push(stored);
        return Promise.resolve(stored);
      },
    };
    const tool = adaptSubagentTool({
      name: 'metrics', description: 'metrics', inputSchema: z.object({}),
      invoke: () => ({ blocks: [{ type: 'text', text: 'ok' }], evidenceIds: ['e-1'] }),
      lifecycle: { factory: new EventFactoryV2(clock, ids), publisher, ids, correlationId: (runId) => `corr:${runId}` },
    });
    const call = tool.call?.({}, {
      runId: 'parent-1', stepId: 'step-1', sessionId: 'session-1', replyId: 'reply-1', streamId: 'stream-1',
      signal: new AbortController().signal, mode: 'execute',
    });
    if (!call || typeof call !== 'object' || !(Symbol.asyncIterator in call)) throw new Error('expected stream');
    while (true) { const item = await call.next(); if (item.done) break; }
    expect(events.map((event) => event.type)).toEqual(['SUBAGENT_STARTED', 'SUBAGENT_COMPLETED']);
    expect(events[0]).toMatchObject({ runId: 'subrun-1', parentRunId: 'parent-1' });
    expect(events.every((event) => event.sessionId === 'session-1')).toBe(true);
    expect(events.every((event) => event.replyId === 'reply-1')).toBe(true);
    expect(events.every((event) => event.streamId === 'stream-1')).toBe(true);
  });

  it('retries a failed subagent before exposing output and records the retry event', async () => {
    const clock: Clock = { now: () => new Date('2026-09-08T00:00:00.000Z') };
    const ids: IdGenerator = { next: (prefix) => `${prefix}-1` };
    const events: AgentEventEnvelopeV2[] = [];
    const publisher: EventPublisherV2Like = {
      publish: (event) => {
        const stored = { ...event, sequence: events.length + 1 } as AgentEventEnvelopeV2;
        events.push(stored);
        return Promise.resolve(stored);
      },
    };
    let attempts = 0;
    const tool = adaptSubagentTool({
      name: 'logs', description: 'logs', inputSchema: z.object({}),
      invoke: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary subagent failure');
        return { blocks: [{ type: 'text', text: 'recovered' }] };
      },
      retry: { maxAttempts: 2, sleep: () => Promise.resolve() },
      lifecycle: { factory: new EventFactoryV2(clock, ids), publisher, ids, correlationId: (runId) => `corr:${runId}` },
    });
    const call = tool.call?.({}, { runId: 'parent-2', stepId: 'step-1', signal: new AbortController().signal, mode: 'execute' });
    if (!call || typeof call !== 'object' || !(Symbol.asyncIterator in call)) throw new Error('expected stream');
    while (true) { const item = await call.next(); if (item.done) break; }

    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      'SUBAGENT_STARTED', 'SUBAGENT_RETRY_SCHEDULED', 'SUBAGENT_COMPLETED',
    ]);
    expect(events[1]?.payload).toMatchObject({ childRunId: 'subrun-1', attempt: 1, reasonCode: 'UNAVAILABLE' });
  });
});
