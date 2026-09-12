import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type { AgentEvent, Tool } from '../src/contracts/index.js';
import type { DiagnosisRunResult } from '../src/agent/types.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

function evidenceTool(): Tool {
  return {
    name: 'metrics.query',
    description: 'query metrics',
    kind: 'evidence',
    inputSchema: z.object({ service: z.string() }),
    isConcurrencySafe: () => false,
    call: () => Promise.resolve({ blocks: [{ type: 'text' as const, text: 'metric evidence' }] }),
  };
}

describe('durable transition integration in the Harness', () => {
  it('commits lifecycle and tool-result events with state before yielding V1 results', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'query-1', name: 'metrics.query', input: { service: 'settlement' } }] },
        { text: 'inspection complete', toolCalls: [] },
      ]),
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [evidenceTool()],
    });
    const durable = runtime.durableState;
    if (durable === undefined) throw new Error('Expected the default runtime to expose durable state.');

    const commitEventTypes: string[][] = [];
    let toolResultTransitionFinished = false;
    let toolResultYieldedBeforeTransition = false;
    const originalCommit = durable.transitions.commit.bind(durable.transitions);
    durable.transitions.commit = async (input) => {
      const saved = await originalCommit(input);
      const eventTypes = input.outboxEvents.map((event) => event.type);
      commitEventTypes.push(eventTypes);
      if (eventTypes.includes('TOOL_RESULT')) toolResultTransitionFinished = true;
      return saved;
    };

    try {
      const stream = runtime.agent.replyStream({
        runId: 'run-transition-harness',
        message: 'inspect',
        profileId: 'group-buy-market',
      });
      const events: AgentEvent[] = [];
      let result: DiagnosisRunResult | undefined;
      while (true) {
        const item = await stream.next();
        if (item.done) {
          result = item.value;
          break;
        }
        events.push(item.value);
        if (item.value.type === 'TOOL_RESULT' && !toolResultTransitionFinished) {
          toolResultYieldedBeforeTransition = true;
        }
      }

      expect(result?.status).toBe('completed');
      expect(commitEventTypes.some((types) => types.includes('RUN_STARTED'))).toBe(true);
      expect(commitEventTypes.some((types) => types.includes('RUN_FINISHED'))).toBe(true);
      expect(commitEventTypes.some((types) => types.includes('TOOL_RESULT'))).toBe(true);
      expect(events.some((event) => event.type === 'TOOL_RESULT')).toBe(true);
      expect(toolResultYieldedBeforeTransition).toBe(false);
      expect(toolResultTransitionFinished).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
