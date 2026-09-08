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
    const call = tool.call?.({}, { runId: 'parent-1', stepId: 'step-1', signal: new AbortController().signal, mode: 'execute' });
    if (!call || typeof call !== 'object' || !(Symbol.asyncIterator in call)) throw new Error('expected stream');
    while (true) { const item = await call.next(); if (item.done) break; }
    expect(events.map((event) => event.type)).toEqual(['SUBAGENT_STARTED', 'SUBAGENT_COMPLETED']);
    expect(events[0]).toMatchObject({ runId: 'subrun-1', parentRunId: 'parent-1' });
  });
});
