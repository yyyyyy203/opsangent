import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type {
  AgentContext,
  AgentEvent,
  Clock,
  Tool,
  ToolCall,
  ToolExecutionRecord,
  ToolExecutionResult,
} from '../src/contracts/index.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { checkpointChecksum } from '../src/storage/durable-codec.js';
import type { DiagnosisRunResult } from '../src/agent/types.js';

const timestamp = '2026-09-10T00:00:00.000Z';
const clock: Clock = { now: () => new Date(timestamp) };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('durable Harness recovery', () => {
  it('reuses a completed branch and replays only the unfinished replay-safe call after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-recovery-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const finishedCall: ToolCall = { id: 'finished-call', name: 'metrics.finished', input: { service: 'settlement' } };
    const unfinishedCall: ToolCall = { id: 'unfinished-call', name: 'metrics.unfinished', input: { service: 'settlement' } };
    const completedResult = resultFor(finishedCall, 'success');
    const seed = createSqlitePersistence({ path: sqlitePath, clock });

    try {
      const initial = checkpointContext('run-parallel', [finishedCall, unfinishedCall]);
      const saved = await seed.checkpoints.save(initial, null);
      const finishedExecution = preparedExecution(initial, finishedCall, 'evidence');
      await seed.executions.prepare(finishedExecution);
      await seed.stateUnitOfWork.commitToolResult({
        expectedRevision: saved.revision,
        context: initial,
        execution: finishedExecution,
        result: completedResult,
      });
      await seed.executions.prepare(preparedExecution(initial, unfinishedCall, 'evidence'));
    } finally {
      seed.close();
    }

    let finishedCalls = 0;
    let unfinishedCalls = 0;
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'recovery complete', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      sqlitePath,
      clock,
      tools: [
        evidenceTool(finishedCall.name, 'replay_safe', () => { finishedCalls += 1; }),
        evidenceTool(unfinishedCall.name, 'replay_safe', () => { unfinishedCalls += 1; }),
      ],
    });

    try {
      const resumed = await drain(runtime.agent.resumeStream('run-parallel'));
      expect(resumed.status).toBe('completed');
      expect(finishedCalls).toBe(0);
      expect(unfinishedCalls).toBe(1);
      expect(await runtime.durableState?.executions.get(unfinishedCall.id)).toMatchObject({ state: 'succeeded' });
      expect((await runtime.checkpoints.load('run-parallel'))?.pendingToolBatch).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it('marks a prepared never-replay action uncertain rather than invoking it after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-recovery-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const actionCall: ToolCall = { id: 'action-call', name: 'action.drain', input: { service: 'settlement' } };
    const initial = checkpointContext('run-action', [actionCall]);
    const seed = createSqlitePersistence({ path: sqlitePath, clock });
    try {
      const saved = await seed.checkpoints.save(initial, null);
      expect(saved.revision).toBe(1);
      await seed.executions.prepare(preparedExecution(initial, actionCall, 'action'));
    } finally {
      seed.close();
    }

    let actionCalls = 0;
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'must not reach model', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      sqlitePath,
      clock,
      tools: [{
        name: actionCall.name,
        description: 'drain traffic',
        kind: 'action',
        recoveryPolicy: 'never_replay',
        inputSchema: z.object({ service: z.string() }),
        call: () => {
          actionCalls += 1;
          return Promise.resolve({ blocks: [{ type: 'text' as const, text: 'action invoked' }] });
        },
      }],
    });

    try {
      const resumed = await drain(runtime.agent.resumeStream('run-action'));
      expect(resumed.status).toBe('paused');
      expect(actionCalls).toBe(0);
      expect((await runtime.eventStoreV2.readRun('run-action', 0, 100)).map((event) => event.type))
        .toContain('EXTERNAL_EXECUTION_UNCERTAIN');
    } finally {
      await runtime.close();
    }

    const verification = createSqlitePersistence({ path: sqlitePath, clock });
    try {
      expect(await verification.executions.get(actionCall.id)).toMatchObject({
        state: 'uncertain',
        reasonCode: 'prepared_action_recovery',
      });
    } finally {
      verification.close();
    }
  });

  it('keeps a prepared verify-before-retry source paused instead of invoking it after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-recovery-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const call: ToolCall = { id: 'verify-call', name: 'logs.capture', input: { service: 'settlement' } };
    const initial = checkpointContext('run-verify', [call]);
    const seed = createSqlitePersistence({ path: sqlitePath, clock });
    try {
      const saved = await seed.checkpoints.save(initial, null);
      expect(saved.revision).toBe(1);
      await seed.executions.prepare(preparedExecution(initial, call, 'evidence'));
    } finally {
      seed.close();
    }

    let calls = 0;
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'must not reach model', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      sqlitePath,
      clock,
      tools: [evidenceTool(call.name, 'verify_before_retry', () => { calls += 1; })],
    });

    try {
      const resumed = await drain(runtime.agent.resumeStream('run-verify'));
      expect(resumed.status).toBe('paused');
      expect(calls).toBe(0);
      expect((await runtime.checkpoints.load('run-verify'))?.missingEvidence).toContain('recovery_verification:verify-call');
      expect(await runtime.durableState?.executions.get(call.id)).toMatchObject({ state: 'prepared' });
    } finally {
      await runtime.close();
    }
  });

  it('journals a fresh ToolRunner call before completing its durable batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-recovery-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const call: ToolCall = { id: 'fresh-call', name: 'metrics.fresh', input: { service: 'settlement' } };
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [call] },
        { text: 'fresh complete', toolCalls: [] },
      ]),
      workspaceRoots: [],
      includeExternalBash: false,
      sqlitePath,
      clock,
      tools: [evidenceTool(call.name, 'replay_safe', () => undefined)],
    });

    try {
      const result = await runtime.agent.reply({ runId: 'run-fresh', message: 'inspect', profileId: 'group-buy-market' });
      expect(result.status).toBe('completed');
      const execution = await runtime.durableState?.executions.get(call.id);
      expect(execution?.state).toBe('succeeded');
      expect(execution?.result).toMatchObject({ toolCallId: call.id, status: 'success' });
      expect((await runtime.checkpoints.load('run-fresh'))?.pendingToolBatch).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});

function checkpointContext(runId: string, calls: ToolCall[]): AgentContext {
  return {
    runId,
    sessionId: `session-${runId}`,
    replyId: `reply-${runId}`,
    streamId: `stream-${runId}`,
    status: 'running',
    stage: 'evidence_collection',
    profileId: 'group-buy-market',
    messages: [],
    pendingToolCalls: [],
    pendingToolBatch: {
      batchId: `batch-${runId}`,
      stepId: 'step-recovery',
      calls,
      completedResults: [],
      state: 'executing',
      createdAt: timestamp,
    },
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: [],
    missingEvidence: [],
    budget: {
      startedAt: timestamp,
      maxIterations: 5,
      iteration: 1,
      maxToolCalls: 10,
      toolCallsUsed: calls.length,
      maxDurationMs: 60_000,
    },
    contextVersion: 1,
  };
}

function preparedExecution(context: AgentContext, call: ToolCall, toolKind: ToolExecutionRecord['toolKind']): ToolExecutionRecord {
  return {
    toolCallId: call.id,
    runId: context.runId,
    stepId: context.pendingToolBatch?.stepId ?? 'step-recovery',
    toolName: call.name,
    toolKind,
    inputDigest: checkpointChecksum(call.input),
    state: 'prepared',
    preparedAt: timestamp,
  };
}

function resultFor(call: ToolCall, status: ToolExecutionResult['status']): ToolExecutionResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    status,
    response: { blocks: [{ type: 'text', text: 'stored result' }] },
    startedAt: timestamp,
    finishedAt: timestamp,
  };
}

function evidenceTool(name: string, recoveryPolicy: NonNullable<Tool['recoveryPolicy']>, onCall: () => void): Tool {
  return {
    name,
    description: name,
    kind: 'evidence',
    recoveryPolicy,
    inputSchema: z.object({ service: z.string() }),
    call: () => {
      onCall();
      return Promise.resolve({ blocks: [{ type: 'text' as const, text: 'fresh result' }] });
    },
  };
}

async function drain(stream: AsyncGenerator<AgentEvent, DiagnosisRunResult>): Promise<DiagnosisRunResult> {
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
