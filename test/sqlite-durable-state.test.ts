import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentContext,
  Clock,
  EvidenceRecord,
  PendingToolBatch,
  ToolCall,
  ToolExecutionRecord,
  ToolExecutionResult,
} from '../src/contracts/index.js';
import { createSqlitePersistence, SqliteDatabase } from '../src/infrastructure/sqlite/index.js';

const roots: string[] = [];
const now = '2026-09-10T00:00:00.000Z';
const clock: Clock = { now: () => new Date(now) };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentops-durable-state-'));
  roots.push(root);
  return join(root, 'durable.sqlite');
}

function context(runId: string, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    runId,
    status: 'running',
    stage: 'evidence_collection',
    profileId: 'group-buy-market',
    messages: [],
    pendingToolCalls: [],
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: [],
    missingEvidence: [],
    budget: { startedAt: now, maxIterations: 8, iteration: 1, maxToolCalls: 16, toolCallsUsed: 0, maxDurationMs: 60_000 },
    contextVersion: 1,
    ...overrides,
  };
}

function call(id: string): ToolCall {
  return { id, name: 'metrics.capture', input: { service: 'settlement' } };
}

function batch(...calls: ToolCall[]): PendingToolBatch {
  return { batchId: 'batch-1', stepId: 'step-1', calls, completedResults: [], state: 'executing', createdAt: now };
}

function execution(toolCallId: string): ToolExecutionRecord {
  return {
    toolCallId,
    runId: 'run-1',
    stepId: 'step-1',
    toolName: 'metrics.capture',
    toolKind: 'evidence',
    inputDigest: `digest-${toolCallId}`,
    state: 'prepared',
    preparedAt: now,
  };
}

function result(toolCallId: string): ToolExecutionResult {
  return {
    toolCallId,
    toolName: 'metrics.capture',
    status: 'success',
    response: { blocks: [{ type: 'text', text: 'captured' }] },
    startedAt: now,
    finishedAt: now,
  };
}

function evidence(evidenceId: string, capturedAt: string): EvidenceRecord {
  return {
    evidenceId,
    runId: 'run-1',
    source: 'metric',
    summary: { total: 100 },
    raw: { evidenceId, marker: 'private-raw-evidence' },
    businessTraceIds: ['trace-1'],
    capturedAt,
    captureKey: `capture-${evidenceId}`,
  };
}

describe('SQLite durable-state persistence', () => {
  it('reopens a versioned checkpoint and Evidence record after closing SQLite', async () => {
    const path = await databasePath();
    const first = createSqlitePersistence({ path, clock });
    const checkpoint = await first.checkpoints.save(context('run-1'), null);
    expect(await first.checkpoints.save(checkpoint.context, checkpoint.revision)).toMatchObject({ revision: checkpoint.revision });
    await first.evidence.save(evidence('evidence-1', '2026-09-10T00:00:01.000Z'));
    first.close();

    const second = createSqlitePersistence({ path, clock });
    expect(await second.checkpoints.load('run-1')).toMatchObject({ revision: checkpoint.revision, context: { profileId: 'group-buy-market' } });
    expect(await second.evidence.get('evidence-1')).toMatchObject({ source: 'metric', raw: { marker: 'private-raw-evidence' } });
    second.close();
  });

  it('maps a corrupted checkpoint to a safe storage corruption error', async () => {
    const path = await databasePath();
    const first = createSqlitePersistence({ path, clock });
    await first.checkpoints.save(context('run-1'), null);
    first.close();
    const database = SqliteDatabase.open(path);
    database.raw.prepare('UPDATE agent_checkpoints SET checkpoint_json = ? WHERE run_id = ?').run('{"not":"a-checkpoint"}', 'run-1');
    database.close();

    const second = createSqlitePersistence({ path, clock });
    try {
      await expect(second.checkpoints.load('run-1')).rejects.toMatchObject({ recordType: 'checkpoint', recordId: 'run-1' });
    } finally {
      second.close();
    }
  });

  it('does not partially commit a tool result when its checkpoint revision is stale', async () => {
    const bundle = createSqlitePersistence({ path: await databasePath(), clock });
    const firstCall = call('call-1');
    const secondCall = call('call-2');
    const checkpoint = await bundle.checkpoints.save(context('run-1', {
      pendingToolCalls: [firstCall, secondCall],
      pendingToolBatch: batch(firstCall, secondCall),
    }), null);
    await bundle.executions.prepare(execution('call-1'));
    await bundle.executions.prepare(execution('call-2'));
    const committed = await bundle.stateUnitOfWork.commitToolResult({
      expectedRevision: checkpoint.revision,
      context: checkpoint.context,
      execution: execution('call-1'),
      result: result('call-1'),
    });

    await expect(bundle.stateUnitOfWork.commitToolResult({
      expectedRevision: checkpoint.revision,
      context: committed.context,
      execution: execution('call-2'),
      result: result('call-2'),
    })).rejects.toMatchObject({ category: 'checkpoint_conflict' });
    await expect(bundle.executions.get('call-1')).resolves.toMatchObject({ state: 'succeeded', result: result('call-1') });
    await expect(bundle.executions.get('call-2')).resolves.toMatchObject({ state: 'prepared' });
    expect((await bundle.checkpoints.load('run-1'))?.revision).toBe(committed.revision);
    bundle.close();
  });

  it('uses capture identity idempotence and stable Evidence pagination', async () => {
    const bundle = createSqlitePersistence({ path: await databasePath(), clock });
    await bundle.evidence.save(evidence('evidence-1', '2026-09-10T00:00:01.000Z'));
    await bundle.evidence.save(evidence('evidence-1', '2026-09-10T00:00:01.000Z'));
    await bundle.evidence.save(evidence('evidence-2', '2026-09-10T00:00:02.000Z'));

    const first = await bundle.evidence.listByRun('run-1', { limit: 1 });
    if (first.nextCursor === undefined) throw new Error('expected an Evidence continuation cursor');
    const second = await bundle.evidence.listByRun('run-1', { cursor: first.nextCursor, limit: 1 });

    expect(first.items.map(({ evidenceId }) => evidenceId)).toEqual(['evidence-1']);
    expect(second.items.map(({ evidenceId }) => evidenceId)).toEqual(['evidence-2']);
    await expect(bundle.evidence.save({ ...evidence('evidence-1', '2026-09-10T00:00:01.000Z'), raw: { changed: true } })).rejects.toThrow();
    bundle.close();
  });
});
