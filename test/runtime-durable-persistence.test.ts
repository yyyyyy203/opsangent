import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type { AgentContext, Clock, PendingAgentEventV2 } from '../src/contracts/index.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/index.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const roots: string[] = [];
const timestamp = '2026-09-11T00:00:00.000Z';
const clock: Clock = { now: () => new Date(timestamp) };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runtime durable persistence', () => {
  it('uses the SQLite persistence bundle for checkpoints across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-durable-runtime-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const first = createAgentRuntime({
      model: new ScriptedModel([{ text: 'done', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      sqlitePath,
    });
    const result = await first.agent.reply({ message: 'inspect', profileId: 'group-buy-market' });
    await first.evidence.save({
      evidenceId: 'runtime-evidence-1',
      runId: result.runId,
      source: 'metric',
      summary: { status: 'healthy' },
      raw: { marker: 'runtime-private-evidence' },
      businessTraceIds: [],
      capturedAt: '2026-09-10T00:00:00.000Z',
      captureKey: `runtime:${result.runId}:metric:0`,
    });
    await first.close();

    const second = createAgentRuntime({
      model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      sqlitePath,
    });
    try {
      expect(await second.checkpoints.load(result.runId)).toMatchObject({ runId: result.runId, status: 'completed' });
      expect(await second.evidence.get('runtime-evidence-1')).toMatchObject({ raw: { marker: 'runtime-private-evidence' } });
      expect(await second.eventStoreV2.currentSequence(result.runId)).toBeGreaterThan(0);
    } finally {
      await second.close();
    }
  });

  it('drains durable Outbox facts during restart readiness before projector replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-outbox-runtime-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const context: AgentContext = {
      runId: 'run-outbox-restart',
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
      budget: { startedAt: timestamp, maxIterations: 8, iteration: 1, maxToolCalls: 16, toolCallsUsed: 0, maxDurationMs: 60_000 },
      contextVersion: 1,
    };
    const pending: PendingAgentEventV2<'RUN_STARTED'> = {
      schemaVersion: 2,
      eventId: 'event-outbox-restart',
      type: 'RUN_STARTED',
      payload: { profile: 'group-buy-market', trigger: 'manual', deadline: '2026-09-11T00:01:00.000Z', versionSnapshot: {} },
      runId: context.runId,
      correlationId: `run:${context.runId}`,
      timestamp,
      visibility: 'audit',
      durability: 'durable',
    };
    const first = createSqlitePersistence({ path: sqlitePath, clock });
    try {
      await first.transitions.commit({ expectedRevision: null, context, outboxEvents: [pending] });
      expect(await first.eventMessages.findById(pending.eventId)).toBeNull();
      expect(await first.outbox.listPending({ runId: context.runId, limit: 10 })).toHaveLength(1);
    } finally {
      first.close();
    }

    const second = createAgentRuntime({
      model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      sqlitePath,
      clock,
    });
    try {
      await second.ready;
      expect(await second.eventStoreV2.findById(pending.eventId)).toMatchObject({ type: 'RUN_STARTED', runId: context.runId });
      expect(await second.durableState?.outbox.listPending({ runId: context.runId, limit: 10 })).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it('does not emit a drained V1 lifecycle event twice during restart readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-outbox-v1-runtime-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const context: AgentContext = {
      runId: 'run-outbox-v1-restart',
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
      budget: { startedAt: timestamp, maxIterations: 8, iteration: 1, maxToolCalls: 16, toolCallsUsed: 0, maxDurationMs: 60_000 },
      contextVersion: 1,
    };
    const pending: PendingAgentEventV2<'RUN_STARTED'> = {
      schemaVersion: 2,
      eventId: 'event-outbox-v1-restart',
      type: 'RUN_STARTED',
      payload: { profile: 'group-buy-market', trigger: 'manual', deadline: '2026-09-11T00:01:00.000Z', versionSnapshot: {} },
      runId: context.runId,
      correlationId: `run:${context.runId}`,
      timestamp,
      visibility: 'audit',
      durability: 'durable',
    };
    const first = createSqlitePersistence({ path: sqlitePath, clock });
    try {
      await first.transitions.commit({ expectedRevision: null, context, outboxEvents: [pending] });
    } finally {
      first.close();
    }

    const second = createAgentRuntime({
      model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      sqlitePath,
      clock,
    });
    const projected: string[] = [];
    second.events.subscribe((event) => {
      if (event.runId === context.runId && event.type === 'RUN_STARTED') projected.push(event.type);
    });
    try {
      await second.ready;
      expect(projected).toEqual(['RUN_STARTED']);
    } finally {
      await second.close();
    }
  });
});
