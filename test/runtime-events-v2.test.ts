import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import type { ModelResponse } from '../src/contracts/index.js';
import type { ChatModel, ModelStreamEvent } from '../src/contracts/index.js';
import { ModelFailure } from '../src/model/model-failure.js';
import { z } from 'zod';

describe('runtime V2 event wiring', () => {
  it('persists lifecycle events from the authoritative Harness run', async () => {
    const response: ModelResponse = { text: 'inspection complete', toolCalls: [] };
    const runtime = createAgentRuntime({ model: new ScriptedModel([response]), workspaceRoots: [] });
    const result = await runtime.agent.reply({ message: 'inspect', profileId: 'group-buy-market' });
    const events = await runtime.eventStoreV2.readRun(result.runId, 0, 100);
    expect(events.map((item) => item.type)).toEqual([
      'RUN_STARTED', 'STEP_STARTED', 'REASONING_STARTED', 'MODEL_CALL_STARTED',
      'MESSAGE_STARTED', 'CONTENT_BLOCK_STARTED', 'CONTENT_BLOCK_COMPLETED',
      'MESSAGE_COMPLETED', 'MODEL_CALL_COMPLETED', 'STEP_COMPLETED', 'RUN_FINISHED',
    ]);
    expect(runtime.replayV2.readAfter(result.runId, 0).map((item) => item.type)).toContain('CONTENT_BLOCK_DELTA');
    expect(events.every((item) => item.runId === result.runId)).toBe(true);
  });

  it('emits one terminal V2 result from the tool pipeline', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [{ id: 'query-1', name: 'metrics.query', input: { service: 'settlement' } }] }, { text: 'done', toolCalls: [] }]),
      workspaceRoots: [],
      tools: [{ name: 'metrics.query', description: 'query', kind: 'evidence', inputSchema: z.object({ service: z.string() }), call: () => ({ blocks: [{ type: 'text', text: 'ok' }] }), isConcurrencySafe: () => true }],
    });
    const result = await runtime.agent.reply({ message: 'inspect', profileId: 'group-buy-market' });
    const events = await runtime.eventStoreV2.readRun(result.runId, 0, 200);
    expect(events.filter((item) => item.type === 'TOOL_RESULT')).toHaveLength(1);
    expect(events.map((item) => item.type)).toContain('RISK_EVALUATED');
  });

  it('emits model attempt failure and fallback activation through the runtime', async () => {
    const primary: ChatModel = {
      async *stream() {
        await Promise.resolve();
        for (const item of [] as ModelStreamEvent[]) yield item;
        throw new ModelFailure('server', 'primary unavailable', true);
      },
    };
    const fallback: ChatModel = {
      async *stream() {
        await Promise.resolve();
        yield { type: 'text_delta', delta: 'fallback result' };
        return { text: 'fallback result', toolCalls: [] };
      },
    };
    const runtime = createAgentRuntime({
      model: primary, workspaceRoots: [], modelRetry: {
        maxAttempts: 1, fallback, fallbackProvider: 'backup', fallbackModel: 'backup-model', sleep: () => Promise.resolve(),
      },
    });
    const result = await runtime.agent.reply({ message: 'inspect', profileId: 'group-buy-market' });
    const events = await runtime.eventStoreV2.readRun(result.runId, 0, 100);
    expect(events.map((item) => item.type)).toContain('MODEL_CALL_FAILED');
    expect(events.map((item) => item.type)).toContain('MODEL_FALLBACK_ACTIVATED');
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
  });

  it('records a failed step before the terminal run failure', async () => {
    const model: ChatModel = {
      async *stream() {
        await Promise.resolve();
        yield* [];
        throw new ModelFailure('server', 'unavailable', false);
      },
    };
    const runtime = createAgentRuntime({ model, workspaceRoots: [] });
    const result = await runtime.agent.reply({ message: 'inspect', profileId: 'group-buy-market' });
    const events = await runtime.eventStoreV2.readRun(result.runId, 0, 100);
    const types = events.map((item) => item.type);
    expect(types).toContain('STEP_FAILED');
    expect(types.indexOf('STEP_FAILED')).toBeLessThan(types.indexOf('RUN_FAILED'));
  });
});
