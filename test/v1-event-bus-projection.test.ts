import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

describe('V1 compatibility event delivery', () => {
  it('derives legacy tool lifecycle events from the V2 projection exactly once', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'call-1', name: 'query', input: {} }] },
        { text: 'done', toolCalls: [] },
      ]),
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [{
        name: 'query',
        kind: 'evidence',
        description: 'query',
        inputSchema: z.object({}),
        call: () => ({ blocks: [{ type: 'text', text: 'result' }] }),
      }],
    });
    const events: Array<{ type: string; payload: unknown }> = [];
    runtime.events.subscribe((event) => { events.push(event); });

    await runtime.agent.reply({ message: 'inspect', profileId: 'group-buy-market' });

    expect(events.filter((event) => event.type === 'TOOL_STARTED')).toHaveLength(1);
    expect(events.find((event) => event.type === 'TOOL_STARTED')?.payload).toMatchObject({
      toolName: 'query',
      attempt: 1,
    });
    expect(events.filter((event) => event.type === 'TOOL_RESULT')).toHaveLength(1);
  });
});
