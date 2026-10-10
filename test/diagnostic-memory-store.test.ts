import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../src/contracts/common.js';
import type {
  DiagnosticMemoryCase, MemoryCaptureIntent, MemoryManualCaptureCommand, MemoryReviewCommand,
} from '../src/contracts/diagnostic-memory.js';
import type { PendingAgentEventV2 } from '../src/contracts/event-store.js';
import type { DiagnosisSignal } from '../src/contracts/hooks.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteDiagnosticMemoryStore } from '../src/infrastructure/sqlite/diagnostic-memory-store.js';
import { SqliteDurableStateStore } from '../src/infrastructure/sqlite/durable-state-store.js';
import { SqliteEventOutboxStore } from '../src/infrastructure/sqlite/event-outbox-store.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';
import { checkpointChecksum, parseAgentContext } from '../src/storage/durable-codec.js';
import { MemoryError } from '../src/memory/memory-error.js';
import { memoryCase, memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';

const clock: Clock = { now: () => new Date(memoryNow) };

function sourceContext(capture: 'manual' | 'automatic' | 'skip' = 'automatic', runId = 'historical-run-1') {
  return parseAgentContext({
    runId, profileId: 'simulation', status: 'completed', stage: 'postmortem',
    messages: [], pendingToolCalls: [], confirmedToolCallIds: [], rejectedToolCallIds: [],
    executedActions: [], evidenceIds: ['evidence-1'], missingEvidence: [], contextVersion: 1,
    budget: { startedAt: memoryNow, maxIterations: 8, iteration: 1, maxToolCalls: 16,
      toolCallsUsed: 1, maxDurationMs: 60_000 },
    memoryControl: { schemaVersion: 1, scope: simulationMemoryScope(), profilePolicyRevision: 'policy-v1',
      capture, recall: false },
  });
}

function captureIntent(context = sourceContext(), origin: 'automatic' | 'manual' = 'automatic', requestId = `${origin}-request`): MemoryCaptureIntent {
  const envelope = { schemaVersion: 2 as const, runId: context.runId, correlationId: `run:${context.runId}`,
    timestamp: memoryNow, visibility: 'audit' as const, durability: 'durable' as const };
  const failure = (eventId: string, category: 'MEMORY_CAPACITY_EXCEEDED' | 'MEMORY_CAPTURE_FAILED') => ({
    ...envelope, eventId, type: 'MEMORY_UPDATE_FAILED' as const,
    payload: { candidateId: 'memory-1', error: { code: 'STORAGE_ERROR' as const,
      message: 'Memory update unavailable.', retryable: false, details: { category } } },
  });
  return {
    request: { candidateId: 'memory-1', sourceRunId: context.runId, scope: simulationMemoryScope(),
      extractorVersion: 'episodic-v1', origin, requestId,
      sourceRunStatus: 'completed', sourceContextVersion: context.contextVersion,
      sourceCheckpointChecksum: checkpointChecksum(context), requiredSources: ['metric'], requestedAt: memoryNow },
    scheduledEvent: { ...envelope, eventId: `schedule-${requestId}`, type: 'MEMORY_UPDATE_SCHEDULED',
      payload: { candidateType: 'episodic', sourceRunId: context.runId } },
    rejectedEvent: failure(`capacity-${requestId}`, 'MEMORY_CAPACITY_EXCEEDED'),
    failedEvent: failure(`failure-${requestId}`, 'MEMORY_CAPTURE_FAILED'),
  };
}

function captureEvents(candidate: DiagnosticMemoryCase): readonly PendingAgentEventV2[] {
  const envelope = { schemaVersion: 2 as const, runId: candidate.sourceRunId,
    correlationId: `run:${candidate.sourceRunId}`, timestamp: memoryNow,
    visibility: 'audit' as const, durability: 'durable' as const };
  return [
    { ...envelope, eventId: 'memory-completed', type: 'MEMORY_UPDATE_COMPLETED',
      payload: { memoryId: candidate.id, status: candidate.status, eligibility: 'not_eligible' } },
    { ...envelope, eventId: 'memory-candidate-created', type: 'EXPERIENCE_CANDIDATE_CREATED',
      payload: { candidateId: candidate.id, evidenceIds: candidate.evidenceRefs.map((ref) => ref.evidenceId), qualityStatus: candidate.quality } },
  ];
}

function reviewEvents(command: MemoryReviewCommand): readonly PendingAgentEventV2[] {
  const envelope = { schemaVersion: 2 as const, runId: 'historical-run-1',
    correlationId: 'run:historical-run-1', timestamp: command.reviewedAt,
    visibility: 'audit' as const, durability: 'durable' as const };
  return [
    { ...envelope, eventId: `review-completed-${command.requestId}`, type: 'MEMORY_UPDATE_COMPLETED',
      payload: { memoryId: command.memoryId, status: command.decision, eligibility: 'not_eligible' } },
    { ...envelope, eventId: `reviewed-${command.requestId}`, type: 'EXPERIENCE_REVIEWED',
      payload: { candidateId: command.memoryId, decision: command.decision, reviewer: command.actorId } },
  ];
}

function memorySignal(runId: string, overrides: Partial<DiagnosisSignal> = {}): DiagnosisSignal {
  return { schemaVersion: 1, kind: 'tool_outcome', candidateStatus: 'observation', runId,
    stepId: 'step-1', toolCallId: 'tool-call-1', toolName: 'metrics_query', phase: 'completion',
    outcome: 'success', riskSeverity: 'LOW', evidenceIds: ['evidence-1'], observedAt: memoryNow, ...overrides };
}

function manualCommand(overrides: Partial<MemoryManualCaptureCommand> = {}): MemoryManualCaptureCommand {
  return { sourceRunId: 'historical-run-1', scope: simulationMemoryScope(), expectedCheckpointRevision: 1,
    requestId: 'manual-command-1', actorId: 'operator-1', requestedAt: memoryNow, ...overrides };
}

async function makeStore(kind: 'memory' | 'sqlite') {
  if (kind === 'memory') {
    const state = new InMemoryDurableState(clock);
    return { writes: state.memory, queries: state.memory, transitions: state, checkpoints: state,
      outbox: state, dispose: async () => {} };
  }
  const root = await mkdtemp(join(tmpdir(), 'agentops-memory-store-'));
  const database = SqliteDatabase.open(join(root, 'state.sqlite'));
  return {
    writes: new SqliteDiagnosticMemoryStore(database, { clock }),
    queries: new SqliteDiagnosticMemoryStore(database, { clock }),
    transitions: new SqliteDurableStateStore(database, clock),
    checkpoints: new SqliteDurableStateStore(database, clock),
    outbox: new SqliteEventOutboxStore(database),
    dispose: async () => { database.close(); await rm(root, { recursive: true, force: true }); },
  };
}

it('migrates the governed memory tables with the main SQLite database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentops-memory-migration-'));
  const database = SqliteDatabase.open(join(root, 'state.sqlite'));
  try {
    const tables = database.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      'diagnostic_memory_cases', 'diagnostic_memory_case_fts', 'diagnostic_memory_reviews',
      'diagnostic_memory_capture_jobs', 'diagnostic_memory_capture_commands', 'diagnostic_memory_signals',
    ]));
    expect(database.raw.pragma('user_version', { simple: true })).toBe(5);
  } finally {
    database.close();
    const reopened = SqliteDatabase.open(join(root, 'state.sqlite'));
    expect(reopened.raw.pragma('user_version', { simple: true })).toBe(5);
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

describe.each(['memory', 'sqlite'] as const)('%s diagnostic memory store', (kind: 'memory' | 'sqlite') => {
  it('claims, completes, scope-filters and revalidates an observation', async () => {
    const store = await makeStore(kind);
    try {
      const context = sourceContext();
      await store.transitions.commit({ expectedRevision: null, context, outboxEvents: [], memoryCapture: captureIntent(context) });
      const claim = await store.writes.claimNext({ ownerId: 'worker-1', now: memoryNow,
        leaseUntil: '2026-10-10T00:00:30.000Z', maxAttempts: 2 });
      expect(claim?.request.sourceRunId).toBe(context.runId);
      if (claim === null) throw new Error('fixture memory capture was not enqueued');
      const candidate = memoryCase();
      const saved = await store.writes.completeCapture({ claim, candidate, now: memoryNow, events: captureEvents(candidate) });
      expect(saved.status).toBe('observation');
      expect(await store.queries.get(saved.id, simulationMemoryScope())).toEqual(saved);
      expect(await store.queries.list({ scope: simulationMemoryScope(), status: 'observation', limit: 10 })).toEqual([saved]);
      expect(await store.queries.get(saved.id, { ...simulationMemoryScope(), datasetId: 'other' })).toBeNull();
      expect(await store.queries.revalidate({ scope: simulationMemoryScope(), now: memoryNow,
        selections: [{ memoryId: saved.id, revision: saved.revision, digest: saved.digest }] })).toEqual([]);
      expect((await store.queries.getCapture({ runId: context.runId, scope: simulationMemoryScope() }))?.state).toBe('saved');
    } finally { await store.dispose(); }
  });

  it('fences expired worker leases and writes a durable failure after the final attempt', async () => {
    const store = await makeStore(kind);
    try {
      const context = sourceContext();
      await store.transitions.commit({ expectedRevision: null, context, outboxEvents: [], memoryCapture: captureIntent(context) });
      const first = await store.writes.claimNext({ ownerId: 'worker-1', now: memoryNow,
        leaseUntil: '2026-10-10T00:00:30.000Z', maxAttempts: 2 });
      if (first === null) throw new Error('first lease was not created');
      const second = await store.writes.claimNext({ ownerId: 'worker-2', now: '2026-10-10T00:00:31.000Z',
        leaseUntil: '2026-10-10T00:01:01.000Z', maxAttempts: 2 });
      if (second === null) throw new Error('expired lease was not reclaimed');
      expect(second.attempt).toBe(2);
      await expect(store.writes.completeCapture({ claim: first, candidate: memoryCase(), now: '2026-10-10T00:00:31.000Z',
        events: captureEvents(memoryCase()) })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_CONFLICT' });
      await store.writes.failCapture({ claim: second, now: '2026-10-10T00:00:32.000Z', code: 'MEMORY_CAPTURE_FAILED', events: [] });
      expect((await store.queries.getCapture({ runId: context.runId, scope: simulationMemoryScope() }))?.state).toBe('failed');
      const pending = await store.outbox.listPending({ runId: context.runId, limit: 10 });
      expect(pending.map((record) => record.event.type)).toContain('MEMORY_UPDATE_FAILED');
    } finally { await store.dispose(); }
  });

  it('CAS-reviews a case, allows identical request replay and rejects conflicting replay', async () => {
    const store = await makeStore(kind);
    try {
      const context = sourceContext();
      await store.transitions.commit({ expectedRevision: null, context, outboxEvents: [], memoryCapture: captureIntent(context) });
      const claim = await store.writes.claimNext({ ownerId: 'worker-1', now: memoryNow,
        leaseUntil: '2026-10-10T00:00:30.000Z', maxAttempts: 2 });
      if (claim === null) throw new Error('capture claim was not created');
      const candidate = memoryCase();
      await store.writes.completeCapture({ claim, candidate, now: memoryNow, events: captureEvents(candidate) });
      const command: MemoryReviewCommand = { memoryId: candidate.id, scope: simulationMemoryScope(), expectedRevision: 1,
        requestId: 'review-1', decision: 'approved', claimCheck: 'supported', actorId: 'operator-1', reviewedAt: memoryNow };
      const reviewed = await store.writes.review({ command, now: memoryNow, events: reviewEvents(command) });
      expect(reviewed).toMatchObject({ revision: 2, status: 'approved', eligibleForPromotion: false });
      expect(await store.writes.review({ command, now: memoryNow, events: reviewEvents(command) })).toEqual(reviewed);
      expect(await store.queries.revalidate({ scope: simulationMemoryScope(), now: memoryNow,
        selections: [{ memoryId: reviewed.id, revision: reviewed.revision, digest: reviewed.digest }] })).toEqual([reviewed]);
      await expect(store.writes.review({ command: { ...command, actorId: 'other-operator' }, now: memoryNow, events: reviewEvents(command) }))
        .rejects.toMatchObject({ code: 'MEMORY_REQUEST_CONFLICT' });
      await expect(store.writes.review({ command: { ...command, requestId: 'stale-review', expectedRevision: 1 },
        now: memoryNow,
        events: reviewEvents({ ...command, requestId: 'stale-review', expectedRevision: 1 }) }))
        .rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' });
    } finally { await store.dispose(); }
  });

  it('manual capture replays idempotently without changing the source checkpoint', async () => {
    const store = await makeStore(kind);
    try {
      const context = sourceContext('manual');
      await store.transitions.commit({ expectedRevision: null, context, outboxEvents: [] });
      const before = await store.checkpoints.load(context.runId);
      if (before === null) throw new Error('source checkpoint was not saved');
      const command = manualCommand();
      const intent = captureIntent(context, 'manual', command.requestId);
      const first = await store.writes.enqueueManualCapture({ command, intent });
      const replay = await store.writes.enqueueManualCapture({ command, intent });
      expect(replay).toEqual(first);
      expect(first.state).toBe('queued');
      expect(await store.writes.findCaptureResult(command)).toEqual(first);
      await expect(store.writes.enqueueManualCapture({ command: { ...command, actorId: 'changed-actor' }, intent }))
        .rejects.toMatchObject({ code: 'MEMORY_REQUEST_CONFLICT' });
      expect(await store.checkpoints.load(context.runId)).toEqual(before);
      expect((await store.outbox.listPending({ runId: context.runId, limit: 10 })).map((record) => record.event.type))
        .toEqual(['MEMORY_UPDATE_SCHEDULED']);
    } finally { await store.dispose(); }
  });

  it('deduplicates automatic/manual competition into one job', async () => {
    const store = await makeStore(kind);
    try {
      const context = sourceContext();
      await store.transitions.commit({ expectedRevision: null, context, outboxEvents: [], memoryCapture: captureIntent(context) });
      const command = manualCommand();
      const manualIntent = captureIntent(context, 'manual', command.requestId);
      const ticket = await store.writes.enqueueManualCapture({ command, intent: manualIntent });
      expect(ticket.state).toBe('queued');
      expect(await store.queries.getCapture({ runId: context.runId, scope: simulationMemoryScope() })).toMatchObject({
        state: 'queued', candidateId: 'memory-1',
      });
      expect((await store.outbox.listPending({ runId: context.runId, limit: 10 })).map((record) => record.event.type))
        .toEqual(['MEMORY_UPDATE_SCHEDULED']);
    } finally { await store.dispose(); }
  });

  it('stores signals independent of recall, deduplicates identical effects and ignores skipped capture', async () => {
    const store = await makeStore(kind);
    try {
      const context = sourceContext('automatic'); // recall is false; signal retention must still work.
      const signal = memorySignal(context.runId);
      const effects = [{ type: 'memory_signal' as const, signal }];
      await store.transitions.commit({ expectedRevision: null, context, outboxEvents: [], governanceEffects: effects });
      await store.transitions.commit({ expectedRevision: 1, context, outboxEvents: [], governanceEffects: effects });
      const checkpoint = await store.checkpoints.load(context.runId);
      if (checkpoint === null) throw new Error('signal checkpoint was not persisted');
      await expect(store.transitions.commit({ expectedRevision: checkpoint.revision,
        context: { ...context, contextVersion: 2 }, outboxEvents: [],
        governanceEffects: [{ type: 'memory_signal', signal: memorySignal(context.runId, { evidenceIds: ['different-evidence'] }) }] }))
        .rejects.toMatchObject({ code: 'MEMORY_SOURCE_CONFLICT' });

      const skipped = sourceContext('skip', 'skipped-run');
      const skippedEffects = [{ type: 'memory_signal' as const, signal: memorySignal(skipped.runId) }];
      await store.transitions.commit({ expectedRevision: null, context: skipped, outboxEvents: [], governanceEffects: skippedEffects });
      const enabledAgain = { ...skipped, memoryControl: { ...skipped.memoryControl!, capture: 'manual' as const } };
      await store.transitions.commit({ expectedRevision: 1, context: enabledAgain, outboxEvents: [],
        governanceEffects: [{ type: 'memory_signal', signal: memorySignal(skipped.runId, { evidenceIds: ['different-evidence'] }) }] });
    } finally { await store.dispose(); }
  });

  it('prunes expired observations and signals in bounded batches', async () => {
    const store = await makeStore(kind);
    try {
      const context = sourceContext();
      const signal = memorySignal(context.runId);
      await store.transitions.commit({ expectedRevision: null, context, outboxEvents: [],
        memoryCapture: captureIntent(context), governanceEffects: [{ type: 'memory_signal', signal }] });
      const claim = await store.writes.claimNext({ ownerId: 'worker-1', now: memoryNow,
        leaseUntil: '2026-10-10T00:00:30.000Z', maxAttempts: 2 });
      if (claim === null) throw new Error('capture claim was not created');
      const expiredCase = memoryCase({ capturedAt: '2026-09-01T00:00:00.000Z',
        validUntil: '2026-10-09T00:00:00.000Z', evidenceRefs: [{ evidenceId: 'evidence-1',
          ownerRunId: context.runId, source: 'metric', capturedAt: '2026-09-01T00:00:00.000Z', rawSha256: 'b'.repeat(64) }] });
      await store.writes.completeCapture({ claim, candidate: expiredCase, now: memoryNow, events: captureEvents(expiredCase) });
      expect(await store.writes.prune({ now: memoryNow, limit: 1 })).toEqual({ expiredObservations: 1, signalsRemoved: 0 });
      expect(await store.queries.get(expiredCase.id, simulationMemoryScope())).toBeNull();
      expect(await store.writes.prune({ now: '2026-10-18T00:00:00.000Z', limit: 1 }))
        .toEqual({ expiredObservations: 0, signalsRemoved: 1 });
    } finally { await store.dispose(); }
  });

  it('rolls checkpoint and memory job back when the shared outbox transaction conflicts', async () => {
    const store = await makeStore(kind);
    try {
      const context = sourceContext();
      await store.outbox.enqueue({ events: [{ schemaVersion: 2, runId: context.runId, eventId: 'schedule-automatic-request',
        correlationId: `run:${context.runId}`, timestamp: memoryNow, visibility: 'audit', durability: 'durable',
        type: 'RUN_STARTED', payload: { profile: 'simulation', trigger: 'test', deadline: memoryNow,
          versionSnapshot: {} } }], createdAt: memoryNow });
      await expect(store.transitions.commit({ expectedRevision: null, context, outboxEvents: [],
        memoryCapture: captureIntent(context) })).rejects.toBeInstanceOf(Error);
      expect(await store.checkpoints.load(context.runId)).toBeNull();
      expect(await store.queries.getCapture({ runId: context.runId, scope: simulationMemoryScope() })).toBeNull();
      expect((await store.outbox.listPending({ runId: context.runId, limit: 10 })).map((record) => record.event.type)).toEqual(['RUN_STARTED']);
    } finally { await store.dispose(); }
  });

  it('rejects manual capture when the expected source revision is stale', async () => {
    const store = await makeStore(kind);
    try {
      const context = sourceContext('manual');
      await store.transitions.commit({ expectedRevision: null, context, outboxEvents: [] });
      const intent = captureIntent(context, 'manual', 'stale-command');
      await expect(store.writes.enqueueManualCapture({ command: manualCommand({ expectedCheckpointRevision: 2,
        requestId: 'stale-command' }), intent })).rejects.toBeInstanceOf(MemoryError);
      expect(await store.writes.getCapture({ runId: context.runId, scope: simulationMemoryScope() })).toMatchObject({ state: 'not_saved' });
      expect(await store.outbox.listPending({ runId: context.runId, limit: 10 })).toEqual([]);
    } finally { await store.dispose(); }
  });
});
