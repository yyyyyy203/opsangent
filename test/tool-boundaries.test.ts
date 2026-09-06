import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { parseJsonArguments } from '../src/tool/json-arguments.js';
import type { AgentEvent, Guardian, ModelResponse, Tool } from '../src/contracts/index.js';

const finish: ModelResponse = { toolCalls: [], text: 'finished' };
const options = { message: 'inspect', profileId: 'test' };
function tool(name: string, call: NonNullable<Tool['call']>): Tool {
  return { name, kind: 'evidence', description: name, inputSchema: z.object({}), isConcurrencySafe: () => true, call };
}

describe('execution boundaries', () => {
  it('rejects duplicate call IDs before any member of the batch executes', async () => {
    let count = 0;
    const runtime = createAgentRuntime({ model: new ScriptedModel([{ toolCalls: [
      { id: 'duplicate', name: 'query', input: {} }, { id: 'duplicate', name: 'query', input: {} },
    ] }, finish]), workspaceRoots: [], includeExternalBash: false, tools: [tool('query', () => { count += 1; return { blocks: [] }; })] });
    await runtime.agent.reply(options);
    expect(count).toBe(0);
  });

  it('never dispatches after the model cancels the run', async () => {
    const controller = new AbortController();
    let count = 0;
    class CancellingModel extends ScriptedModel {
      public override async *stream(...args: Parameters<ScriptedModel['stream']>): ReturnType<ScriptedModel['stream']> {
        controller.abort();
        return yield* super.stream(...args);
      }
    }
    const runtime = createAgentRuntime({ model: new CancellingModel([finish]), workspaceRoots: [], tools: [tool('query', () => { count += 1; return { blocks: [] }; })] });
    const result = await runtime.agent.reply({ ...options, signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(count).toBe(0);
  });

  it('passes schema defaults to Guard and Runner', async () => {
    const seen: unknown[] = [];
    const runtime = createAgentRuntime({ model: new ScriptedModel([{ toolCalls: [{ id: 'a', name: 'query', input: {} }] }, finish]),
      workspaceRoots: [], includeExternalBash: false,
      guardians: [{ id: 'inspect-input', inspect: ({ toolCall }) => { seen.push(toolCall.input); return Promise.resolve([]); } }],
      tools: [{ ...tool('query', (input) => { seen.push(input); return { blocks: [] }; }), inputSchema: z.object({ limit: z.number().default(10) }) }],
    });
    await runtime.agent.reply(options);
    expect(seen).toEqual([{ limit: 10 }, { limit: 10 }]);
  });

  it('isolates a throwing Guardian and keeps successful siblings and results in call order', async () => {
    const executed: string[] = [];
    const events: AgentEvent[] = [];
    const guardian: Guardian = { id: 'failing-policy', inspect: ({ tool: target }) => {
      if (target.name === 'bad') throw new Error('policy unavailable');
      return Promise.resolve([]);
    } };
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [{ id: 'a', name: 'bad', input: {} }, { id: 'b', name: 'good', input: {} }] }, finish]),
      workspaceRoots: [], includeExternalBash: false, guardians: [guardian],
      tools: [tool('bad', () => { executed.push('bad'); return { blocks: [] }; }), tool('good', () => { executed.push('good'); return { blocks: [] }; })],
    });
    runtime.events.subscribe((event) => { events.push(event); });
    const result = await runtime.agent.reply(options);
    expect(result.status).toBe('completed');
    expect(executed).toEqual(['good']);
    expect(events.filter((event) => event.type === 'TOOL_RESULT')).toHaveLength(2);
    const context = await runtime.checkpoints.load(result.runId);
    const results = context?.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_result').map((b) => b.result);
    expect(results?.map((r) => [r.toolCallId, r.status])).toEqual([['a', 'failed'], ['b', 'success']]);
  });

  it('does not execute raw invalid input even when every field is optional', async () => {
    let executed = false;
    const events: AgentEvent[] = [];
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [], rawToolCalls: [{ id: 'a', name: 'query', arguments: '{' }] }, finish]),
      workspaceRoots: [], includeExternalBash: false, tools: [tool('query', () => { executed = true; return { blocks: [] }; })],
    });
    runtime.events.subscribe((event) => { events.push(event); });
    await runtime.agent.reply(options);
    expect(executed).toBe(false);
    expect(events.filter((event) => event.type === 'TOOL_RESULT')).toHaveLength(1);
  });

  it('preserves injected semantic policy rejection without offering a permission bypass', async () => {
    let executed = false;
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [{ id: 'a', name: 'query', input: {} }] }, finish]),
      workspaceRoots: [], includeExternalBash: false, tools: [{ ...tool('query', () => { executed = true; return { blocks: [] }; }),
        validateSemantics: () => ({ valid: false, error: { code: 'POLICY_DENIED', message: 'Service outside Profile.', retryable: false } }),
      }],
    });
    const result = await runtime.agent.reply(options);
    expect(executed).toBe(false);
    expect((await runtime.checkpoints.load(result.runId))?.toolCorrections).toEqual({});
  });

  it('rejects numeric overflow rather than admitting Infinity', () => {
    expect(parseJsonArguments('{"limit":1e999}')).toMatchObject({ ok: false });
  });

  it('rejects escaped duplicate keys and bounded-input violations', () => {
    expect(parseJsonArguments('{"service":"a","ser\\u0076ice":"b"}')).toMatchObject({ ok: false, reason: 'duplicate_key' });
    expect(parseJsonArguments('{"a":{"b":{}}}', 100, 2)).toMatchObject({ ok: false, reason: 'depth_limit' });
    expect(parseJsonArguments('{"value":"中文"}', 10)).toMatchObject({ ok: false, reason: 'byte_limit' });
  });

  it('records successful syntax repairs in tool progress for auditing', async () => {
    const events: AgentEvent[] = [];
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [], rawToolCalls: [{ id: 'a', name: 'query', arguments: '{"limit":1,}' }] }, finish]),
      workspaceRoots: [], includeExternalBash: false, tools: [{ ...tool('query', () => ({ blocks: [] })), inputSchema: z.object({ limit: z.number() }) }],
    });
    runtime.events.subscribe((event) => { events.push(event); });
    await runtime.agent.reply(options);
    expect(events.filter((event) => event.type === 'TOOL_PROGRESS').map((event) => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCallId: 'a', stage: 'admission', repairs: ['trailing_comma'] }),
    ]));
  });
});
