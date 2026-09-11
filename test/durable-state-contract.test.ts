import { describe, expect, it } from 'vitest';
import type {
  AgentContext,
  Clock,
  EvidenceRecord,
  PendingToolBatch,
  ToolCall,
  ToolExecutionRecord,
  ToolExecutionResult,
} from '../src/contracts/index.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';

const now = '2026-09-10T00:00:00.000Z';
const clock: Clock = { now: () => new Date(now) };

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
    budget: {
      startedAt: now,
      maxIterations: 8,
      iteration: 1,
      maxToolCalls: 16,
      toolCallsUsed: 0,
      maxDurationMs: 60_000,
    },
    contextVersion: 1,
    ...overrides,
  };
}

function call(id: string): ToolCall {
  return { id, name: 'logs.capture', input: { service: 'settlement' } };
}

function batch(...calls: ToolCall[]): PendingToolBatch {
  return {
    batchId: 'batch-1',
    stepId: 'step-1',
    calls,
    completedResults: [],
    state: 'executing',
    createdAt: now,
  };
}

function execution(toolCallId: string): ToolExecutionRecord {
  return {
    toolCallId,
    runId: 'run-1',
    stepId: 'step-1',
    toolName: 'logs.capture',
    toolKind: 'evidence',
    inputDigest: `digest-${toolCallId}`,
    state: 'prepared',
    preparedAt: now,
  };
}

function result(toolCallId: string): ToolExecutionResult {
  return {
    toolCallId,
    toolName: 'logs.capture',
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
    source: 'log',
    summary: { count: 1 },
    raw: { evidenceId },
    businessTraceIds: [],
    capturedAt,
    captureKey: `capture-${evidenceId}`,
  };
}

describe('in-memory durable-state contract', () => {
  it('creates, updates and exactly retries checkpoints without allowing stale overwrite', async () => {
    const state = new InMemoryDurableState(clock);
    const created = await state.save(context('run-1'), null);
    const retried = await state.save(created.context, created.revision);
    const updated = await state.save({ ...created.context, stage: 'hypothesis' }, created.revision);

    expect(created.revision).toBe(1);
    expect(created.context.governance?.profile).toMatchObject({
      profileId: 'group-buy-market',
      source: 'legacy_checkpoint',
    });
    expect(retried.revision).toBe(created.revision);
    expect(updated.revision).toBe(2);
    await expect(state.save({ ...created.context, stage: 'action' }, created.revision))
      .rejects.toMatchObject({ category: 'checkpoint_conflict' });
    await expect(state.save(updated.context, created.revision))
      .rejects.toMatchObject({ category: 'checkpoint_conflict' });
    expect((await state.load('run-1'))?.context.stage).toBe('hypothesis');
  });

  it('makes prepare idempotent for the same execution identity and rejects collisions', async () => {
    const state = new InMemoryDurableState(clock);
    const prepared = await state.prepare(execution('call-1'));

    await expect(state.prepare({ ...execution('call-1'), preparedAt: '2026-09-10T00:00:01.000Z' }))
      .resolves.toEqual(prepared);
    await expect(state.prepare({ ...execution('call-1'), inputDigest: 'different' })).rejects.toThrow();
  });

  it('atomically persists a tool result, its journal state and the matching pending batch result', async () => {
    const state = new InMemoryDurableState(clock);
    const firstCall = call('call-1');
    const secondCall = call('call-2');
    const checkpoint = await state.save(context('run-1', {
      pendingToolCalls: [firstCall, secondCall],
      pendingToolBatch: batch(firstCall, secondCall),
    }), null);
    await state.prepare(execution('call-1'));
    await state.prepare(execution('call-2'));

    const committed = await state.commitToolResult({
      expectedRevision: checkpoint.revision,
      context: checkpoint.context,
      execution: execution('call-1'),
      result: result('call-1'),
    });

    expect(committed.revision).toBe(2);
    expect(committed.context.pendingToolBatch?.completedResults).toEqual([result('call-1')]);
    await expect(state.get('call-1')).resolves.toMatchObject({ state: 'succeeded', result: result('call-1') });
    await expect(state.commitToolResult({
      expectedRevision: checkpoint.revision,
      context: committed.context,
      execution: execution('call-2'),
      result: result('call-2'),
    })).rejects.toMatchObject({ category: 'checkpoint_conflict' });
    await expect(state.get('call-2')).resolves.toMatchObject({ state: 'prepared' });
  });

  it('marks a prepared execution uncertain with the supplied checkpoint transition', async () => {
    const state = new InMemoryDurableState(clock);
    const toolCall = call('call-1');
    const checkpoint = await state.save(context('run-1', {
      pendingToolCalls: [toolCall],
      pendingToolBatch: batch(toolCall),
      status: 'paused',
    }), null);
    await state.prepare(execution('call-1'));

    const saved = await state.markToolUncertain({
      expectedRevision: checkpoint.revision,
      context: checkpoint.context,
      execution: execution('call-1'),
      reasonCode: 'external_action_outcome_unknown',
    });

    expect(saved.revision).toBe(2);
    await expect(state.get('call-1')).resolves.toMatchObject({
      state: 'uncertain', reasonCode: 'external_action_outcome_unknown',
    });
  });

  it('paginates Evidence deterministically and rejects a conflicting capture identity', async () => {
    const state = new InMemoryDurableState(clock);
    await state.evidence.save(evidence('evidence-1', '2026-09-10T00:00:01.000Z'));
    await state.evidence.save(evidence('evidence-2', '2026-09-10T00:00:02.000Z'));

    const first = await state.evidence.listByRun('run-1', { limit: 1 });
    if (first.nextCursor === undefined) throw new Error('expected a continuation cursor');
    const second = await state.evidence.listByRun('run-1', { cursor: first.nextCursor, limit: 1 });

    expect(first.items.map(({ evidenceId }) => evidenceId)).toEqual(['evidence-1']);
    expect(second.items.map(({ evidenceId }) => evidenceId)).toEqual(['evidence-2']);
    expect(second.nextCursor).toBeUndefined();
    await expect(state.evidence.save({ ...evidence('evidence-1', '2026-09-10T00:00:01.000Z'), raw: { changed: true } }))
      .rejects.toThrow();
  });
});
