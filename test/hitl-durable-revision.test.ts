import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type { Clock } from '../src/contracts/index.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

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
