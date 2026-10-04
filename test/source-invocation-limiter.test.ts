import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolCallOptions, ToolResponse } from '../src/contracts/index.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { SourceInvocationLimiter } from '../src/tool/source-invocation-limiter.js';

function callOptions(runId: string): ToolCallOptions {
  return {
    runId,
    stepId: 'step-1',
    signal: new AbortController().signal,
    mode: 'dry_run',
  };
}

function sourceTool(
  name: 'metrics_subagent' | 'logs_subagent',
  call: NonNullable<Tool['call']>,
): Tool {
  return {
    name,
    description: `${name} test tool`,
    kind: 'evidence',
    source: 'subagent',
    inputSchema: z.object({}),
    call,
    userFacingLabel: () => '调查来源',
    isConcurrencySafe: () => true,
  };
}

const ok: ToolResponse = { blocks: [{ type: 'text', text: 'ok' }] };

describe('SourceInvocationLimiter', () => {
  it('limits each canonical source once per Run while isolating Runs and sources', async () => {
    const metricsCall = vi.fn(() => ok);
    const logsCall = vi.fn(() => ok);
    const limiter = new SourceInvocationLimiter({ maxPerSource: 1 });
    const metrics = limiter.wrap(sourceTool('metrics_subagent', metricsCall));
    const logs = limiter.wrap(sourceTool('logs_subagent', logsCall));

    await metrics.call?.({}, callOptions('run-a'));
    await logs.call?.({}, callOptions('run-a'));
    await metrics.call?.({}, callOptions('run-b'));
    await expect(Promise.resolve().then(() => metrics.call?.({}, callOptions('run-a')))).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED', retryable: false,
    });

    expect(metricsCall).toHaveBeenCalledTimes(2);
    expect(logsCall).toHaveBeenCalledTimes(1);
  });

  it('consumes the source slot before invoking and does not refund it after failure', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error('synthetic failure')).mockResolvedValue(ok);
    const limiter = new SourceInvocationLimiter({ maxPerSource: 1 });
    const metrics = limiter.wrap(sourceTool('metrics_subagent', invoke));

    await expect(Promise.resolve().then(() => metrics.call?.({}, callOptions('run-a')))).rejects.toThrow('synthetic failure');
    await expect(Promise.resolve().then(() => metrics.call?.({}, callOptions('run-a'))))
      .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('preserves Tool metadata and the original streaming call contract', async () => {
    const limiter = new SourceInvocationLimiter({ maxPerSource: 1 });
    const original = sourceTool('metrics_subagent', async function* () {
      await Promise.resolve();
      yield { type: 'progress', message: 'checking' };
      return ok;
    });
    const wrapped = limiter.wrap(original);

    expect(wrapped).toMatchObject({
      name: original.name,
      description: original.description,
      kind: original.kind,
      source: original.source,
      inputSchema: original.inputSchema,
      userFacingLabel: original.userFacingLabel,
      isConcurrencySafe: original.isConcurrencySafe,
    });
    const stream = wrapped.call?.({}, callOptions('run-a'));
    expect(stream).toBeDefined();
    if (stream === undefined || !('next' in stream)) throw new Error('Expected a streaming Tool result.');
    expect(await stream.next()).toMatchObject({ done: false, value: { type: 'progress' } });
    expect(await stream.next()).toMatchObject({ done: true, value: ok });
  });

  it('clears all Run-scoped reservations when its owning smoke runtime closes', async () => {
    const invoke = vi.fn(() => ok);
    const limiter = new SourceInvocationLimiter({ maxPerSource: 1 });
    const metrics = limiter.wrap(sourceTool('metrics_subagent', invoke));
    await metrics.call?.({}, callOptions('run-a'));
    limiter.clear();
    await metrics.call?.({}, callOptions('run-a'));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('surfaces the limiter rejection through the normal ToolExecutionPipeline result', async () => {
    const invoke = vi.fn(() => ok);
    const limiter = new SourceInvocationLimiter({ maxPerSource: 1 });
    const metrics = limiter.wrap(sourceTool('metrics_subagent', invoke));
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [
          { id: 'metrics-first', name: 'metrics_subagent', input: {} },
          { id: 'metrics-second', name: 'metrics_subagent', input: {} },
        ] },
        { text: 'done', toolCalls: [] },
      ]),
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [metrics],
    });
    try {
      const run = await runtime.agent.reply({ message: 'inspect', profileId: 'simulation' });
      const context = await runtime.checkpoints.load(run.runId);
      const results = context?.messages.flatMap((message) => message.blocks)
        .filter((block) => block.type === 'tool_result')
        .map((block) => block.result);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(results?.find((result) => result.toolCallId === 'metrics-second')?.error)
        .toMatchObject({ code: 'BUDGET_EXCEEDED', retryable: false });
    } finally {
      await runtime.close();
    }
  });
});
