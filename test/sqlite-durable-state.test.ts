import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentContext,
  Clock,
  EvidenceRecord,
  PendingAgentEventV2,
  PendingToolBatch,
  ToolCall,
  ToolExecutionRecord,
  ToolExecutionResult,
} from '../src/contracts/index.js';
import { createInitialRunGovernanceState } from '../src/contracts/governance.js';
import { createSqlitePersistence, SqliteDatabase } from '../src/infrastructure/sqlite/index.js';
import { checkpointChecksum } from '../src/storage/durable-codec.js';
import { memoryCase, memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';

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

function outboxEvent(eventId = 'outbox-event-1'): PendingAgentEventV2<'TOOL_RESULT'> {
  return {
    schemaVersion: 2,
    eventId,
    type: 'TOOL_RESULT',
    payload: { result: result('call-1'), durationMs: 0, evidenceIds: [] },
    runId: 'run-1',
    correlationId: 'run:run-1',
    timestamp: now,
    visibility: 'audit',
    durability: 'durable',
    stepId: 'step-1',
    toolCallId: 'call-1',
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

function insertCheckpoint(path: string, value: AgentContext | Record<string, unknown>, schemaVersion: number,
  checksum = checkpointChecksum(value)): void {
  const database = SqliteDatabase.open(path);
  try {
    database.raw.prepare(`
      INSERT INTO agent_checkpoints(
        run_id, revision, context_version, status, stage, profile_id, checkpoint_schema_version,
        checkpoint_json, checksum, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(value.runId, 1, value.contextVersion, value.status, value.stage, value.profileId,
      schemaVersion, JSON.stringify(value), checksum, now, now);
  } finally {
    database.close();
  }
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

  it('rejects an exact checkpoint retry when its expected revision is stale', async () => {
    const bundle = createSqlitePersistence({ path: await databasePath(), clock });
    try {
      const created = await bundle.checkpoints.save(context('run-1'), null);
      const updated = await bundle.checkpoints.save({ ...created.context, stage: 'hypothesis' }, created.revision);

      await expect(bundle.checkpoints.save(updated.context, created.revision))
        .rejects.toMatchObject({ category: 'checkpoint_conflict' });
      expect((await bundle.checkpoints.load('run-1'))?.revision).toBe(updated.revision);
    } finally {
      bundle.close();
    }
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

  it('loads a legacy checkpoint checksum and upgrades its next write to schema 3', async () => {
    const path = await databasePath();
    const legacy = context('run-legacy');
    const database = SqliteDatabase.open(path);
    database.raw.prepare(`
      INSERT INTO agent_checkpoints(
        run_id, revision, context_version, status, stage, profile_id, checkpoint_schema_version,
        checkpoint_json, checksum, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacy.runId, 1, legacy.contextVersion, legacy.status, legacy.stage, legacy.profileId,
      1, JSON.stringify(legacy), checkpointChecksum(legacy), now, now,
    );
    database.close();

    const persistence = createSqlitePersistence({ path, clock });
    try {
      const loaded = await persistence.checkpoints.load('run-legacy');
      if (loaded === null) throw new Error('expected legacy checkpoint');
      expect(loaded.context.governance?.profile).toMatchObject({
        profileId: 'group-buy-market',
        source: 'legacy_checkpoint',
      });
      await persistence.checkpoints.save(loaded.context, loaded.revision);
    } finally {
      persistence.close();
    }

    const upgraded = SqliteDatabase.open(path);
    try {
      const row = upgraded.raw.prepare(`
        SELECT checkpoint_schema_version, checkpoint_json
        FROM agent_checkpoints WHERE run_id = ?
      `).get('run-legacy') as { checkpoint_schema_version: number; checkpoint_json: string };
      expect(row.checkpoint_schema_version).toBe(3);
      expect(JSON.parse(row.checkpoint_json)).toMatchObject({ governance: { schemaVersion: 1 } });
    } finally {
      upgraded.close();
    }
  });

  it.each([1, 2])('restores real schema %i rows using their original checksum and no invented memory scope', async (version) => {
    const path = await databasePath();
    const stored = context(`old-${version}`, {
      toolCorrections: { 'metrics.capture': { firstCallId: 'call-legacy', failures: 1 } },
      ...(version === 2 ? { governance: createInitialRunGovernanceState({ profileId: 'group-buy-market', capturedAt: now }) } : {}),
    });
    insertCheckpoint(path, stored, version);
    const persistence = createSqlitePersistence({ path, clock });
    try {
      const loaded = await persistence.checkpoints.load(stored.runId);
      expect(loaded?.checksum).toBe(checkpointChecksum(stored));
      expect(loaded?.context).toMatchObject(stored);
      expect(loaded?.context).not.toHaveProperty('memoryControl');
      expect(loaded?.context).not.toHaveProperty('memory');
    } finally { persistence.close(); }
  });

  it('verifies a schema 2 checksum before applying conservative missing-governance defaults', async () => {
    const path = await databasePath();
    const stored = context('v2-defaults');
    insertCheckpoint(path, stored, 2);
    const persistence = createSqlitePersistence({ path, clock });
    try {
      const loaded = await persistence.checkpoints.load(stored.runId);
      expect(loaded?.checksum).toBe(checkpointChecksum(stored));
      expect(loaded?.context.governance?.profile.source).toBe('legacy_checkpoint');
      expect(loaded?.context).not.toHaveProperty('memory');
    } finally { persistence.close(); }
  });

  it('upgrades an unchanged schema 2 checkpoint on its first valid save', async () => {
    const path = await databasePath();
    const stored = context('v2-upgrade', { governance: createInitialRunGovernanceState({ profileId: 'group-buy-market', capturedAt: now }) });
    insertCheckpoint(path, stored, 2);
    const persistence = createSqlitePersistence({ path, clock });
    try {
      const loaded = await persistence.checkpoints.load(stored.runId);
      if (loaded === null) throw new Error('expected old checkpoint');
      expect((await persistence.checkpoints.save(loaded.context, loaded.revision)).revision).toBe(2);
    } finally { persistence.close(); }
    const database = SqliteDatabase.open(path);
    try {
      const row = database.raw.prepare('SELECT checkpoint_schema_version FROM agent_checkpoints WHERE run_id = ?').get(stored.runId);
      expect(row).toEqual({ checkpoint_schema_version: 3 });
    } finally { database.close(); }
  });

  it.each(['control-only', 'full-memory'])('writes and reopens schema 3 with %s', async (kind) => {
    const path = await databasePath();
    const memoryControl = { schemaVersion: 1 as const, scope: simulationMemoryScope(), profilePolicyRevision: 'policy-v1', capture: 'manual' as const, recall: kind === 'full-memory' };
    const candidate = memoryCase();
    const memory = { schemaVersion: 1 as const, scope: simulationMemoryScope(), selectionState: 'selected' as const, availability: 'ready' as const,
      selections: [{ memoryId: candidate.id, revision: candidate.revision, digest: candidate.digest }],
      hints: [{ memoryId: candidate.id, revision: candidate.revision, digest: candidate.digest, sourceRunId: candidate.sourceRunId,
        capturedAt: candidate.capturedAt, validUntil: candidate.validUntil, summary: candidate.summary,
        limitations: candidate.limitations, evidenceRefs: candidate.evidenceRefs, diagnosisOnly: true as const }],
      selectedAt: memoryNow, validatedAt: memoryNow };
    const first = createSqlitePersistence({ path, clock });
    try {
      await first.checkpoints.save({ ...context('v3', { profileId: 'simulation' }), memoryControl,
        ...(kind === 'full-memory' ? { memory } : {}) }, null);
    } finally { first.close(); }
    const second = createSqlitePersistence({ path, clock });
    try {
      const loaded = await second.checkpoints.load('v3');
      expect(loaded?.context).toHaveProperty('memoryControl', memoryControl);
      if (kind === 'full-memory') expect(loaded?.context).toHaveProperty('memory', memory);
      else expect(loaded?.context).not.toHaveProperty('memory');
    } finally { second.close(); }
    const database = SqliteDatabase.open(path);
    try {
      expect(database.raw.prepare('SELECT checkpoint_schema_version FROM agent_checkpoints WHERE run_id = ?').get('v3'))
        .toEqual({ checkpoint_schema_version: 3 });
    } finally { database.close(); }
  });

  it.each([1, 2])('rejects new memory fields smuggled into schema %i despite a matching checksum', async (version) => {
    for (const field of ['memoryControl', 'memory']) {
      const path = await databasePath();
      const value = field === 'memoryControl'
        ? { schemaVersion: 1, scope: simulationMemoryScope(), profilePolicyRevision: 'policy-v1', capture: 'manual', recall: false }
        : { schemaVersion: 1, scope: simulationMemoryScope(), selectionState: 'unselected', availability: 'empty', selections: [], hints: [] };
      insertCheckpoint(path, { ...context(`smuggled-${field}`), [field]: value }, version);
      const persistence = createSqlitePersistence({ path, clock });
      try {
        await expect(persistence.checkpoints.load(`smuggled-${field}`)).rejects.toMatchObject({ recordType: 'checkpoint' });
      } finally { persistence.close(); }
    }
  });

  it.each([1, 2, 3])('rejects schema %i tampering even if the checksum matches the migrated context', async (version) => {
    const path = await databasePath();
    const stored = context(`tampered-${version}`);
    const migrated = { ...stored, governance: createInitialRunGovernanceState({ profileId: stored.profileId, capturedAt: now }) };
    insertCheckpoint(path, stored, version, checkpointChecksum(migrated));
    const persistence = createSqlitePersistence({ path, clock });
    try {
      await expect(persistence.checkpoints.load(stored.runId)).rejects.toMatchObject({ recordType: 'checkpoint' });
    } finally { persistence.close(); }
  });

  it('rejects a future checkpoint version with a valid payload and checksum', async () => {
    const path = await databasePath();
    insertCheckpoint(path, context('future'), 4);
    const persistence = createSqlitePersistence({ path, clock });
    try {
      await expect(persistence.checkpoints.load('future')).rejects.toMatchObject({ recordType: 'checkpoint' });
    } finally { persistence.close(); }
  });

  it('reopens a pending durable Outbox event after SQLite restarts', async () => {
    const path = await databasePath();
    const first = createSqlitePersistence({ path, clock });
    await first.outbox.enqueue({ events: [outboxEvent()], createdAt: now });
    first.close();

    const second = createSqlitePersistence({ path, clock });
    try {
      expect(await second.outbox.listPending({ runId: 'run-1', limit: 10 })).toEqual([
        { event: outboxEvent(), enqueuedAt: now },
      ]);
    } finally {
      second.close();
    }
  });

  it('maps a corrupted durable Outbox event to a safe storage corruption error', async () => {
    const path = await databasePath();
    const first = createSqlitePersistence({ path, clock });
    await first.outbox.enqueue({ events: [outboxEvent()], createdAt: now });
    first.close();
    const database = SqliteDatabase.open(path);
    database.raw.prepare('UPDATE durable_event_outbox SET event_json = ? WHERE event_id = ?')
      .run('{"not":"an-event"}', 'outbox-event-1');
    database.close();

    const second = createSqlitePersistence({ path, clock });
    try {
      await expect(second.outbox.listPending({ runId: 'run-1', limit: 10 }))
        .rejects.toMatchObject({ recordType: 'event', recordId: 'outbox-event-1' });
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
