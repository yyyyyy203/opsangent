import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import type { ModelResponse, Tool } from '../src/contracts/index.js';

function setup(responses: ModelResponse[]) {
  const executed: Record<string, unknown>[] = [];
  const tool: Tool = {
    name: 'query', kind: 'evidence', description: 'Query evidence', inputSchema: z.object({ service: z.string() }),
    call: (input) => { executed.push(input); return { blocks: [] }; },
  };
  const runtime = createAgentRuntime({ model: new ScriptedModel(responses), workspaceRoots: [], tools: [tool], includeExternalBash: false });
  return { ...runtime, executed };
}
const done: ModelResponse = { text: 'done', toolCalls: [] };
const raw = (id: string, args: string): ModelResponse => ({ toolCalls: [], rawToolCalls: [{ id, name: 'query', arguments: args }] });

describe('tool admission through the Harness', () => {
  it('repairs syntax without changing commas inside strings', async () => {
    const runtime = setup([raw('a', '```json\n{"service":"a,}",}\n```'), done]);
    await runtime.agent.reply({ message: 'inspect', profileId: 'test' });
    expect(runtime.executed).toEqual([{ service: 'a,}' }]);
  });
  it('feeds paired parse errors to the model then executes only the correction', async () => {
    const runtime = setup([raw('a', '{"service":'), raw('b', '{"service":"checkout"}'), done]);
    const result = await runtime.agent.reply({ message: 'inspect', profileId: 'test' });
    const context = await runtime.checkpoints.load(result.runId);
    expect(runtime.executed).toEqual([{ service: 'checkout' }]);
    expect(context?.messages.flatMap((m) => m.blocks)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'raw_tool_call', call: expect.objectContaining({ id: 'a' }) }),
      expect.objectContaining({ type: 'tool_result', result: expect.objectContaining({ toolCallId: 'a', error: expect.objectContaining({ code: 'TOOL_ARGUMENTS_PARSE_FAILED' }) }) }),
    ]));
    expect(context?.budget.toolCallsUsed).toBe(2);
  });
  it('prevents new IDs from resetting exhausted correction state', async () => {
    const runtime = setup([raw('a', '{'), raw('b', '{'), raw('c', '{"service":"checkout"}'), done]);
    const result = await runtime.agent.reply({ message: 'inspect', profileId: 'test' });
    expect(runtime.executed).toEqual([]);
    expect((await runtime.checkpoints.load(result.runId))?.missingEvidence).toContain('query: correction_exhausted');
  });
  it.each(['{"service":"one","service":"two"}', '{"service":7}', '{"service":"one","extra":1}', 'null', '[]'])('rejects invalid arguments: %s', async (args) => {
    const runtime = setup([raw('a', args), done]);
    await runtime.agent.reply({ message: 'inspect', profileId: 'test' });
    expect(runtime.executed).toEqual([]);
  });
  it('counts rejected calls against the total budget', async () => {
    const runtime = setup([raw('a', '{'), raw('b', '{"service":"checkout"}'), done]);
    await runtime.agent.reply({ message: 'inspect', profileId: 'test', maxToolCalls: 1 });
    expect(runtime.executed).toEqual([]);
  });
});
