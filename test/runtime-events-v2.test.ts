import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import type { ModelResponse } from '../src/contracts/index.js';
import type { ChatModel, ModelStreamEvent } from '../src/contracts/index.js';
import { ModelFailure } from '../src/model/model-failure.js';
import { z } from 'zod';
import { PublicEventProjectorV2 } from '../src/event/projectors/public-projector.js';

describe('runtime V2 event wiring', () => {
  it('publishes aggregate token usage on the terminal public Run event without exposing per-call audit events', async () => {
    const response: ModelResponse = {
      text: 'inspection complete', toolCalls: [], usage: { inputTokens: 120, outputTokens: 32, cachedInputTokens: 8 },
    };
    const runtime = createAgentRuntime({ model: new ScriptedModel([response]), workspaceRoots: [] });
    try {
      const result = await runtime.agent.reply({ message: 'inspect', profileId: 'group-buy-market' });
      const events = await runtime.eventStoreV2.readRun(result.runId, 0, 100);
      const finish = events.find((item) => item.type === 'RUN_FINISHED');
      const publicEvents = events.flatMap((event) => {
        const projected = new PublicEventProjectorV2().project(event);
        return projected === null ? [] : [projected];
      });

      expect(finish).toMatchObject({
        type: 'RUN_FINISHED',
        payload: {
          usage: { inputTokens: 120, outputTokens: 32, cachedInputTokens: 8 },
          usageCompleteness: 'complete',
        },
      });
      expect(publicEvents.find((event) => event.type === 'RUN_FINISHED')?.payload).toMatchObject({
        usage: { inputTokens: 120, outputTokens: 32, cachedInputTokens: 8 },
        usageCompleteness: 'complete',
      });
      expect(publicEvents.map((event) => event.type)).not.toContain('MODEL_CALL_COMPLETED');
    } finally {
      await runtime.close();
    }
  });

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

  it('projects sanitized tool lifecycle status to the public stream', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [{ id: 'public-tool-1', name: 'metrics.query', input: { service: 'settlement' } }] }, { text: 'done', toolCalls: [] }]),
      workspaceRoots: [],
      tools: [{ name: 'metrics.query', description: 'query', kind: 'evidence', inputSchema: z.object({ service: z.string() }), call: () => ({ blocks: [{ type: 'json', value: { failureRate: 0.02, secret: 'must-not-leak' } }] }), isConcurrencySafe: () => true }],
    });
    const result = await runtime.agent.reply({ message: 'inspect', profileId: 'group-buy-market' });
    const projector = new PublicEventProjectorV2();
    const events = await runtime.eventStoreV2.readRun(result.runId, 0, 200);
    const publicEvents = events.flatMap((event) => {
      const projected = projector.project(event);
      return projected === null ? [] : [projected];
    });
    expect(publicEvents.map((event) => event.type)).toContain('TOOL_STARTED');
    const publicResult = publicEvents.find((event) => event.type === 'TOOL_RESULT');
    expect(publicResult).toBeDefined();
    expect(publicResult?.payload).toMatchObject({ result: { toolCallId: 'public-tool-1', toolName: 'metrics.query', status: 'success' } });
    expect(JSON.stringify(publicResult)).not.toContain('must-not-leak');
  });

  it('projects a rejected confirmation result without exposing the private payload', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [{ id: 'rejected-tool-1', name: 'metrics.query', input: { service: 'settlement' } }] }]),
      workspaceRoots: [],
      tools: [{ name: 'metrics.query', description: 'query', kind: 'evidence', requireUserConfirm: true, inputSchema: z.object({ service: z.string() }), call: () => ({ blocks: [{ type: 'json', value: { secret: 'never-public' } }] }), isConcurrencySafe: () => true }],
    });
    const result = await runtime.agent.reply({ message: 'inspect', profileId: 'group-buy-market' });
    const checkpoint = await runtime.durableState?.checkpoints.load(result.runId);
    expect(checkpoint).toBeDefined();
    await runtime.hitl.decideWithResult({
      runId: result.runId, toolCallId: 'rejected-tool-1', confirmed: false,
      expectedRevision: checkpoint!.revision, actor: 'test', decidedAt: '2026-10-01T00:00:01.000Z',
      reason: 'rejected in test',
    });
    const projector = new PublicEventProjectorV2();
    const events = await runtime.eventStoreV2.readRun(result.runId, 0, 200);
    const publicEvents = events.flatMap((event) => {
      const projected = projector.project(event);
      return projected === null ? [] : [projected];
    });
    const publicResult = publicEvents.find((event) => event.type === 'TOOL_RESULT' && JSON.stringify(event).includes('USER_REJECTED'));
    expect(publicResult?.payload).toMatchObject({ result: { status: 'aborted', error: { code: 'USER_REJECTED' } } });
    expect(JSON.stringify(publicResult)).not.toContain('never-public');
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

  it('publishes a shared child run through the parent V2 event port exactly once', async () => {
    const parent = createAgentRuntime({
      model: new ScriptedModel([{ text: 'parent complete', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
    });
    const child = createAgentRuntime({
      model: new ScriptedModel([{ text: 'child complete', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      checkpoints: parent.checkpoints,
      evidence: parent.evidence,
      evidenceRecorder: parent.evidenceRecorder,
      sharedEvents: parent.sharedEvents,
    });

    try {
      const result = await child.agent.reply({ runId: 'shared-child-run', message: 'inspect', profileId: 'simulation' });
      const events = await parent.eventStoreV2.readRun(result.runId, 0, 100);
      expect(events.length).toBeGreaterThan(0);
      expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
      expect((await parent.eventStoreV2.listMessagesByRun(result.runId))).toHaveLength(1);
    } finally {
      await child.close();
      await parent.close();
    }
  });
});
