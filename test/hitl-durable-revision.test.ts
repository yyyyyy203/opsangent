import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type { ChatModel, Clock, Tool, ToolCall } from '../src/contracts/index.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/index.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { z } from 'zod';

const timestamp = '2026-09-10T00:00:00.000Z';
const clock: Clock = { now: () => new Date(timestamp) };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('durable HITL revision control', () => {
  it('accepts only one concurrent confirmation decision for a durable checkpoint revision', async () => {
    const runtime = await createPausedBashRuntime();
    try {
      const run = await runtime.agent.reply({ runId: 'run-confirm', message: 'inspect', profileId: 'group-buy-market' });
      expect(run.status).toBe('awaiting_confirmation');

      const outcomes = await Promise.allSettled([
        runtime.hitl.decide({ runId: run.runId, toolCallId: 'bash-1', confirmed: true, actor: 'approved', decidedAt: timestamp }),
        runtime.hitl.decide({ runId: run.runId, toolCallId: 'bash-1', confirmed: false, actor: 'rejected', decidedAt: timestamp, reason: 'do not run' }),
      ]);
      const checkpoint = await runtime.durableState?.checkpoints.load(run.runId);

      expect(checkpoint?.context.confirmedToolCallIds).toContain('bash-1');
      expect(checkpoint?.context.rejectedToolCallIds).not.toContain('bash-1');
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
        reason: { code: 'STORAGE_ERROR', details: { category: 'checkpoint_conflict' } },
      });
      expect((await runtime.eventStoreV2.readRun(run.runId, 0, 100))
        .filter((event) => event.type === 'CONFIRMATION_RESOLVED')).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('rejects an identical duplicate confirmation before publishing a second decision event', async () => {
    const runtime = await createPausedBashRuntime();
    try {
      const run = await runtime.agent.reply({ runId: 'run-identical-confirm', message: 'inspect', profileId: 'group-buy-market' });
      const decision = { runId: run.runId, toolCallId: 'bash-1', confirmed: true, actor: 'operator', decidedAt: timestamp };

      const outcomes = await Promise.allSettled([
        runtime.hitl.decide(decision),
        runtime.hitl.decide(decision),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
        reason: { code: 'STORAGE_ERROR', details: { category: 'checkpoint_conflict' } },
      });
      expect((await runtime.eventStoreV2.readRun(run.runId, 0, 100))
        .filter((event) => event.type === 'CONFIRMATION_RESOLVED')).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('uses the persisted pending batch as the authority for durable confirmations', async () => {
    const runtime = await createPausedBashRuntime();
    try {
      const run = await runtime.agent.reply({ runId: 'run-batch-authority-confirm', message: 'inspect', profileId: 'group-buy-market' });
      const checkpoint = await runtime.durableState?.checkpoints.load(run.runId);
      if (checkpoint === null || checkpoint === undefined || checkpoint.context.pendingInterrupt === undefined) {
        throw new Error('Expected a durable confirmation checkpoint.');
      }
      const corrupted = structuredClone(checkpoint.context);
      const unexpected: ToolCall = { id: 'outside-batch', name: 'bash', input: { command: 'pnpm test', cwd: roots.at(-1)! } };
      if (corrupted.pendingInterrupt === undefined) throw new Error('Expected a durable confirmation interrupt.');
      corrupted.pendingInterrupt.toolCallId = unexpected.id;
      corrupted.pendingToolCalls = [unexpected];
      await runtime.durableState?.checkpoints.save(corrupted, checkpoint.revision);

      await expect(runtime.hitl.decide({
        runId: run.runId,
        toolCallId: unexpected.id,
        confirmed: true,
        actor: 'operator',
        decidedAt: timestamp,
      })).rejects.toThrow();

      const unchanged = await runtime.durableState?.checkpoints.load(run.runId);
      expect(unchanged?.context.status).toBe('awaiting_confirmation');
      expect(unchanged?.context.confirmedToolCallIds).not.toContain(unexpected.id);
      expect((await runtime.eventStoreV2.readRun(run.runId, 0, 100))
        .filter((event) => event.type === 'CONFIRMATION_RESOLVED')).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('persists an explicit rejection as the terminal result for its pending batch', async () => {
    const runtime = await createPausedBashRuntime();
    try {
      const run = await runtime.agent.reply({ runId: 'run-reject', message: 'inspect', profileId: 'group-buy-market' });
      await runtime.hitl.decide({
        runId: run.runId,
        toolCallId: 'bash-1',
        confirmed: false,
        actor: 'operator',
        decidedAt: timestamp,
        reason: 'do not run this command',
      });
      const checkpoint = await runtime.durableState?.checkpoints.load(run.runId);

      expect(checkpoint?.context.status).toBe('running');
      expect(checkpoint?.context.rejectedToolCallIds).toContain('bash-1');
      expect(checkpoint?.context.pendingToolBatch?.completedResults).toMatchObject([
        { toolCallId: 'bash-1', status: 'aborted', error: { code: 'USER_REJECTED' } },
      ]);
      expect((await runtime.eventStoreV2.readRun(run.runId, 0, 100))
        .filter((event) => event.type === 'CONFIRMATION_RESOLVED')).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('persists expiration as the terminal result without publishing a confirmation resolution', async () => {
    const runtime = await createPausedBashRuntime();
    try {
      const run = await runtime.agent.reply({ runId: 'run-expired', message: 'inspect', profileId: 'group-buy-market' });
      const checkpoint = await runtime.durableState?.checkpoints.load(run.runId);
      if (checkpoint === null || checkpoint === undefined || checkpoint.context.pendingInterrupt === undefined) {
        throw new Error('Expected a durable confirmation checkpoint.');
      }
      const expired = structuredClone(checkpoint.context);
      if (expired.pendingInterrupt === undefined) throw new Error('Expected an expirable confirmation interrupt.');
      expired.pendingInterrupt.expiresAt = timestamp;
      await runtime.durableState?.checkpoints.save(expired, checkpoint.revision);

      await runtime.hitl.decide({ runId: run.runId, toolCallId: 'bash-1', confirmed: true, actor: 'operator', decidedAt: timestamp });
      const resolved = await runtime.durableState?.checkpoints.load(run.runId);
      const events = await runtime.eventStoreV2.readRun(run.runId, 0, 100);

      expect(resolved?.context.status).toBe('running');
      expect(resolved?.context.rejectedToolCallIds).toContain('bash-1');
      expect(resolved?.context.pendingToolBatch?.completedResults).toMatchObject([
        { toolCallId: 'bash-1', status: 'aborted', error: { code: 'CONFIRMATION_EXPIRED' } },
      ]);
      expect(events.filter((event) => event.type === 'CONFIRMATION_EXPIRED')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'CONFIRMATION_RESOLVED')).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('atomically journals a submitted external result and rejects a stale duplicate submission', async () => {
    const runtime = await createPausedBashRuntime();
    try {
      const run = await runtime.agent.reply({ runId: 'run-external', message: 'inspect', profileId: 'group-buy-market' });
      const awaitingConfirmation = await runtime.durableState?.checkpoints.load(run.runId);
      expect(awaitingConfirmation?.context.pendingToolBatch?.completedResults).toEqual([]);

      await runtime.hitl.decide({ runId: run.runId, toolCallId: 'bash-1', confirmed: true, actor: 'operator', decidedAt: timestamp });
      const paused = await drain(runtime.agent.resumeStream(run.runId));
      expect(paused.status).toBe('paused');
      const awaitingExternal = await runtime.durableState?.checkpoints.load(run.runId);
      expect(awaitingExternal?.context.pendingToolBatch?.completedResults).toEqual([]);
      expect(await runtime.durableState?.executions.get('bash-1')).toMatchObject({ state: 'prepared' });
      if (awaitingExternal === null || awaitingExternal === undefined || awaitingExternal.context.pendingToolBatch === undefined) {
        throw new Error('Expected a durable external execution checkpoint.');
      }
      const legacy = structuredClone(awaitingExternal.context);
      if (legacy.pendingToolBatch === undefined) throw new Error('Expected a pending batch in the legacy checkpoint.');
      legacy.pendingToolBatch.completedResults = [{
        toolCallId: 'bash-1',
        toolName: 'bash',
        status: 'awaiting_external',
        startedAt: timestamp,
        finishedAt: timestamp,
      }];
      await runtime.durableState?.checkpoints.save(legacy, awaitingExternal.revision);

      const submissions = await Promise.allSettled([
        runtime.externalTools.submit({ runId: run.runId, toolCallId: 'bash-1', response: { blocks: [{ type: 'text', text: 'host complete' }] } }),
        runtime.externalTools.submit({ runId: run.runId, toolCallId: 'bash-1', response: { blocks: [{ type: 'text', text: 'stale duplicate' }] } }),
      ]);
      const checkpoint = await runtime.durableState?.checkpoints.load(run.runId);

      expect(submissions.filter((submission) => submission.status === 'fulfilled')).toHaveLength(1);
      expect(submissions.find((submission) => submission.status === 'rejected')).toMatchObject({
        reason: { code: 'STORAGE_ERROR', details: { category: 'checkpoint_conflict' } },
      });
      expect(await runtime.durableState?.executions.get('bash-1')).toMatchObject({
        state: 'succeeded',
        result: { toolCallId: 'bash-1', status: 'success' },
      });
      expect(checkpoint?.context.pendingToolBatch?.completedResults).toEqual([
        expect.objectContaining({ toolCallId: 'bash-1', status: 'success' }),
      ]);
      expect((await runtime.eventStoreV2.readRun(run.runId, 0, 200))
        .filter((event) => event.type === 'EXTERNAL_EXECUTION_RESOLVED')).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('uses the persisted pending batch as the authority for durable external results', async () => {
    const runtime = await createPausedBashRuntime();
    try {
      const run = await runtime.agent.reply({ runId: 'run-batch-authority-external', message: 'inspect', profileId: 'group-buy-market' });
      await runtime.hitl.decide({ runId: run.runId, toolCallId: 'bash-1', confirmed: true, actor: 'operator', decidedAt: timestamp });
      await drain(runtime.agent.resumeStream(run.runId));
      const checkpoint = await runtime.durableState?.checkpoints.load(run.runId);
      if (checkpoint === null || checkpoint === undefined || checkpoint.context.pendingInterrupt === undefined) {
        throw new Error('Expected a durable external execution checkpoint.');
      }
      const corrupted = structuredClone(checkpoint.context);
      const unexpected: ToolCall = { id: 'outside-batch', name: 'bash', input: { command: 'pnpm test', cwd: roots.at(-1)! } };
      if (corrupted.pendingInterrupt === undefined) throw new Error('Expected a durable external execution interrupt.');
      corrupted.pendingInterrupt.toolCallId = unexpected.id;
      corrupted.pendingToolCalls = [unexpected];
      await runtime.durableState?.checkpoints.save(corrupted, checkpoint.revision);

      await expect(runtime.externalTools.submit({
        runId: run.runId,
        toolCallId: unexpected.id,
        response: { blocks: [{ type: 'text', text: 'host complete' }] },
      })).rejects.toThrow();

      expect(await runtime.durableState?.executions.get(unexpected.id)).toBeNull();
      expect((await runtime.eventStoreV2.readRun(run.runId, 0, 100))
        .filter((event) => event.type === 'EXTERNAL_EXECUTION_RESOLVED')).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('fails closed when a durable external result has no prepared execution journal', async () => {
    const runtime = await createPausedBashRuntime();
    try {
      const run = await runtime.agent.reply({ runId: 'run-missing-journal', message: 'inspect', profileId: 'group-buy-market' });
      await runtime.hitl.decide({ runId: run.runId, toolCallId: 'bash-1', confirmed: true, actor: 'operator', decidedAt: timestamp });
      await drain(runtime.agent.resumeStream(run.runId));
      expect(await runtime.durableState?.executions.get('bash-1')).toMatchObject({ state: 'prepared' });

      const database = SqliteDatabase.open(join(roots.at(-1)!, 'runtime.sqlite'));
      try {
        database.raw.prepare('DELETE FROM tool_executions WHERE tool_call_id = ?').run('bash-1');
      } finally {
        database.close();
      }

      await expect(runtime.externalTools.submit({
        runId: run.runId,
        toolCallId: 'bash-1',
        response: { blocks: [{ type: 'text', text: 'host complete' }] },
      })).rejects.toMatchObject({
        code: 'STORAGE_ERROR',
        details: { category: 'execution_journal_missing' },
      });

      const paused = await runtime.durableState?.checkpoints.load(run.runId);
      expect(paused?.context.status).toBe('paused');
      expect((await runtime.eventStoreV2.readRun(run.runId, 0, 100))
        .filter((event) => event.type === 'EXTERNAL_EXECUTION_RESOLVED')).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('does not publish a durable tool result when its checkpoint commit fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-result-commit-'));
    roots.push(root);
    const runtimeRef: { current?: ReturnType<typeof createAgentRuntime> } = {};
    const tool: Tool = {
      name: 'utility.advance_checkpoint',
      description: 'Advances the durable checkpoint for a controlled failure test.',
      kind: 'utility',
      inputSchema: z.object({}),
      isConcurrencySafe: () => true,
      call: async () => {
        const checkpoint = await runtimeRef.current?.durableState?.checkpoints.load('run-result-commit-failure');
        if (checkpoint === null || checkpoint === undefined) throw new Error('Expected a durable checkpoint.');
        const advanced = structuredClone(checkpoint.context);
        advanced.contextVersion += 1;
        await runtime.durableState?.checkpoints.save(advanced, checkpoint.revision);
        return { blocks: [{ type: 'text', text: 'completed before persistence conflict' }] };
      },
    };
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [{ id: 'commit-failure-1', name: tool.name, input: {} }] }]),
      tools: [tool],
      workspaceRoots: [root],
      sqlitePath: join(root, 'runtime.sqlite'),
      clock,
      includeExternalBash: false,
    });
    runtimeRef.current = runtime;
    try {
      await expect(runtime.agent.reply({
        runId: 'run-result-commit-failure',
        message: 'inspect',
        profileId: 'group-buy-market',
      })).rejects.toMatchObject({ category: 'checkpoint_conflict' });
      const events = await runtime.eventStoreV2.readRun('run-result-commit-failure', 0, 100);

      expect(events.filter((event) => event.type === 'TOOL_RESULT')).toHaveLength(0);
      expect(events.filter((event) => event.type === 'RUN_FAILED')).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('does not publish an admission rejection before its checkpoint persists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-admission-commit-'));
    roots.push(root);
    const runtimeRef: { current?: ReturnType<typeof createAgentRuntime> } = {};
    const model: ChatModel = {
      async *stream(_messages, _tools, options) {
        const checkpoint = await runtimeRef.current?.durableState?.checkpoints.load(options.runId);
        if (checkpoint === null || checkpoint === undefined) throw new Error('Expected a durable checkpoint.');
        const advanced = structuredClone(checkpoint.context);
        advanced.contextVersion += 1;
        await runtimeRef.current?.durableState?.checkpoints.save(advanced, checkpoint.revision);
        yield* [];
        return { toolCalls: [], rawToolCalls: [{ id: 'rejected-1', name: 'not.registered', arguments: '{}' }] };
      },
    };
    const runtime = createAgentRuntime({
      model,
      workspaceRoots: [root],
      sqlitePath: join(root, 'runtime.sqlite'),
      clock,
      includeExternalBash: false,
    });
    runtimeRef.current = runtime;
    try {
      await expect(runtime.agent.reply({
        runId: 'run-admission-commit-failure',
        message: 'inspect',
        profileId: 'group-buy-market',
      })).rejects.toMatchObject({ category: 'checkpoint_conflict' });
      const events = await runtime.eventStoreV2.readRun('run-admission-commit-failure', 0, 100);

      expect(events.filter((event) => event.type === 'TOOL_CALL_REJECTED')).toHaveLength(0);
      expect(events.filter((event) => event.type === 'TOOL_RESULT')).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });
});

async function createPausedBashRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'opsangent-hitl-'));
  roots.push(root);
  return createAgentRuntime({
    model: new ScriptedModel([{ toolCalls: [{ id: 'bash-1', name: 'bash', input: { command: 'pnpm test', cwd: root } }] }]),
    workspaceRoots: [root],
    sqlitePath: join(root, 'runtime.sqlite'),
    clock,
    actionMode: 'dry_run',
  });
}

async function drain<T>(stream: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
