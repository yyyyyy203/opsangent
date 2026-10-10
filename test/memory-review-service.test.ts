import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Clock, IdGenerator } from '../src/contracts/common.js';
import type {
  DiagnosticMemoryCase, MemoryCaptureIntent, MemoryEventFactory, MemoryMaintenance, MemoryManualCaptureCommand,
  MemoryQueryStore, MemoryReviewCommand, MemoryWriteUnitOfWork,
} from '../src/contracts/diagnostic-memory.js';
import type { AgentEventPayloadMap, AgentEventTypeV2 } from '../src/contracts/event-v2/index.js';
import type { PendingAgentEventV2 } from '../src/contracts/event-store.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteDiagnosticMemoryStore } from '../src/infrastructure/sqlite/diagnostic-memory-store.js';
import { SqliteDurableStateStore } from '../src/infrastructure/sqlite/durable-state-store.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';
import type { DurableTransitionUnitOfWork } from '../src/contracts/storage.js';
import { checkpointChecksum, parseAgentContext } from '../src/storage/durable-codec.js';
import { MemoryReviewService } from '../src/memory/review-service.js';
import type { MemoryEvidenceValidator } from '../src/contracts/diagnostic-memory.js';
import { memoryCase, memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';

const clock: Clock = { now: () => new Date(memoryNow) };

function makeEvents(): { events: MemoryEventFactory; createdTypes: AgentEventTypeV2[]; createdEvents: PendingAgentEventV2[] } {
  let nextId = 0;
  const ids: IdGenerator = { next: (prefix) => `${prefix}-review-test-${++nextId}` };
  const factory = new EventFactoryV2(clock, ids);
  const createdTypes: AgentEventTypeV2[] = [];
  const createdEvents: PendingAgentEventV2[] = [];
  const create = <T extends AgentEventTypeV2>(type: T, runId: string, payload: AgentEventPayloadMap[T]) => {
    createdTypes.push(type);
    const event = factory.create(type, { runId, correlationId: `run:${runId}`, visibility: 'audit', durability: 'durable' }, payload);
    createdEvents.push(event);
    return event;
  };
  return { events: { create }, createdTypes, createdEvents };
}

function operation(now = memoryNow) {
  return { now, deadlineMs: Date.parse(now) + 10_000, clock: { now: () => new Date(now) } };
}

function command(overrides: Partial<MemoryReviewCommand> = {}): MemoryReviewCommand {
  return { memoryId: 'memory-1', scope: simulationMemoryScope(), expectedRevision: 1,
    requestId: 'review-request-1', decision: 'approved', claimCheck: 'supported',
    actorId: 'local-operator', reviewedAt: memoryNow, ...overrides };
}

function liveMemoryScope() {
  return { profileId: 'group-buy-market', profileRevision: 'profile-v1', serviceId: 'settlement',
    faultType: 'settlement_failure', targetFingerprint: 'd'.repeat(64), environment: 'production' as const,
    dataClass: 'live' as const };
}

async function makeHarness(input: { candidate?: Partial<DiagnosticMemoryCase>; sourceStatus?: 'completed' | 'failed' | 'cancelled';
  backend?: 'memory' | 'sqlite'; conflictReviewEvent?: boolean } = {}) {
  const runId = 'historical-run-1';
  const scope = input.candidate?.scope ?? simulationMemoryScope();
  const sourceStatus = input.sourceStatus ?? 'completed';
  const events = makeEvents();
  let database: SqliteDatabase | null = null;
  let databaseDirectory: string | null = null;
  let memory: MemoryQueryStore & MemoryWriteUnitOfWork & MemoryMaintenance;
  let transitions: DurableTransitionUnitOfWork;
  if (input.backend === 'sqlite') {
    databaseDirectory = await mkdtemp(join(tmpdir(), 'agentops-memory-review-'));
    database = SqliteDatabase.open(join(databaseDirectory, 'state.sqlite'));
    memory = new SqliteDiagnosticMemoryStore(database, { clock });
    transitions = new SqliteDurableStateStore(database, clock);
  } else {
    const inMemory = new InMemoryDurableState(clock);
    memory = inMemory.memory;
    transitions = inMemory.transitions;
  }
  const state = { memory };
  const context = parseAgentContext({
    runId, profileId: scope.profileId, status: sourceStatus, stage: 'postmortem',
    messages: [], pendingToolCalls: [], confirmedToolCallIds: [], rejectedToolCallIds: [],
    executedActions: [], evidenceIds: ['evidence-1'], missingEvidence: [], contextVersion: 1,
    budget: { startedAt: memoryNow, maxIterations: 8, iteration: 1, maxToolCalls: 16,
      toolCallsUsed: 1, maxDurationMs: 60_000 },
    memoryControl: { schemaVersion: 1, scope, profilePolicyRevision: 'policy-v1', capture: 'manual', recall: false },
  });
  // The service generates the review and completion events as IDs 6 and 7;
  // colliding with ID 7 proves the first event is rolled back too.
  const runEnvelope = { schemaVersion: 2 as const, eventId: 'event-review-test-7', type: 'EXPERIENCE_REVIEWED' as const,
    runId, correlationId: `run:${runId}`, timestamp: memoryNow, visibility: 'audit' as const, durability: 'durable' as const,
    payload: { candidateId: 'preexisting-event', decision: 'rejected' as const, reviewer: 'local-operator' } };
  await transitions.commit({ expectedRevision: null, context,
    outboxEvents: input.conflictReviewEvent ? [runEnvelope] : [] });

  const captureCommand: MemoryManualCaptureCommand = {
    sourceRunId: runId, scope, expectedCheckpointRevision: 1,
    requestId: 'capture-request-1', actorId: 'local-operator', requestedAt: memoryNow,
  };
  const candidateId = 'memory-1';
  const request = {
    candidateId, sourceRunId: runId, scope, extractorVersion: 'episodic-v1' as const,
    origin: 'manual' as const, requestId: captureCommand.requestId, sourceRunStatus: sourceStatus,
    sourceContextVersion: context.contextVersion, sourceCheckpointChecksum: checkpointChecksum(context),
    requiredSources: ['metric'] as const, requestedAt: memoryNow,
  };
  const failure = (suffix: string): MemoryCaptureIntent['failedEvent'] => events.events.create('MEMORY_UPDATE_FAILED', runId, {
    candidateId, error: { code: 'UNAVAILABLE', message: 'Memory capture unavailable.', retryable: false,
      details: { category: suffix === 'capacity' ? 'MEMORY_CAPACITY_EXCEEDED' : 'MEMORY_CAPTURE_FAILED' } },
  });
  const intent: MemoryCaptureIntent = {
    request,
    scheduledEvent: events.events.create('MEMORY_UPDATE_SCHEDULED', runId,
      { candidateType: 'episodic', sourceRunId: runId }),
    rejectedEvent: failure('capacity'),
    failedEvent: failure('failed'),
  };
  await memory.enqueueManualCapture({ command: captureCommand, intent });
  const claim = await memory.claimNext({ ownerId: 'memory-test-worker', now: memoryNow,
    leaseUntil: '2026-10-10T00:00:30.000Z', maxAttempts: 2 });
  if (claim === null) throw new Error('Memory capture job was not claimable.');
  const base = memoryCase({ id: candidateId, sourceRunId: runId, scope, sourceRunStatus: sourceStatus,
    quality: sourceStatus === 'completed' ? 'sufficient' : 'failed',
    evidenceRefs: sourceStatus === 'completed' ? memoryCase().evidenceRefs : [],
    ...(input.candidate ?? {}) });
  await memory.completeCapture({ claim, candidate: base, now: memoryNow, events: [
    events.events.create('MEMORY_UPDATE_COMPLETED', runId,
      { memoryId: base.id, status: 'observation', eligibility: 'not_eligible' }),
    events.events.create('EXPERIENCE_CANDIDATE_CREATED', runId,
      { candidateId: base.id, evidenceIds: base.evidenceRefs.map((ref) => ref.evidenceId), qualityStatus: base.quality }),
  ] });

  const evidence: MemoryEvidenceValidator = { validate: vi.fn(async () => true) };
  const dispatch = vi.fn(async () => {});
  return { state, candidate: base, evidence, dispatch, events, database, databaseDirectory,
    dispose: async () => {
      database?.close();
      if (databaseDirectory !== null) await rm(databaseDirectory, { recursive: true, force: true });
    },
    service: new MemoryReviewService({ queries: memory, writes: memory, evidence, events: events.events, dispatch }) };
}

describe('MemoryReviewService', () => {
  it('approves a supported, sufficient observation only after evidence validation and keeps simulated cases unpromoted', async () => {
    const harness = await makeHarness();
    const reviewed = await harness.service.review(command(), operation());

    expect(reviewed).toMatchObject({ revision: 2, status: 'approved', eligibleForPromotion: false });
    expect(harness.evidence.validate).toHaveBeenCalledWith({ sourceRunId: 'historical-run-1',
      refs: harness.candidate.evidenceRefs, scope: simulationMemoryScope() }, expect.anything());
    expect(harness.events.createdTypes).toContain('EXPERIENCE_REVIEWED');
    expect(harness.events.createdEvents.find((event) => event.type === 'EXPERIENCE_REVIEWED')?.payload)
      .toEqual({ candidateId: 'memory-1', decision: 'approved', reviewer: 'local-operator' });
    expect(harness.dispatch).toHaveBeenCalledOnce();
  });

  it('marks only a validated live case as eligible for promotion', async () => {
    const scope = liveMemoryScope();
    const harness = await makeHarness({ candidate: { scope } });
    const reviewed = await harness.service.review(command({ scope }), operation());
    expect(reviewed).toMatchObject({ status: 'approved', eligibleForPromotion: true });
  });

  it('fails closed when the evidence validator cannot confirm the refs', async () => {
    const harness = await makeHarness();
    vi.mocked(harness.evidence.validate).mockResolvedValue(false);

    await expect(harness.service.review(command(), operation()))
      .rejects.toMatchObject({ code: 'MEMORY_EVIDENCE_UNAVAILABLE' });
    expect(await harness.state.memory.get('memory-1', simulationMemoryScope())).toEqual(harness.candidate);
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('maps evidence-validator exceptions to the stable unavailable error without writing a review', async () => {
    const harness = await makeHarness();
    vi.mocked(harness.evidence.validate).mockRejectedValue(new Error('private evidence backend details'));

    await expect(harness.service.review(command(), operation()))
      .rejects.toMatchObject({ code: 'MEMORY_EVIDENCE_UNAVAILABLE' });
    expect(await harness.state.memory.get('memory-1', simulationMemoryScope())).toEqual(harness.candidate);
    expect(await harness.state.memory.findReviewResult(command())).toBeNull();
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('does not consult evidence for unsupported claims, insufficient cases, expired cases, or empty refs', async () => {
    const unsupported = await makeHarness();
    await expect(unsupported.service.review(command({ claimCheck: 'unsupported' }), operation()))
      .rejects.toMatchObject({ code: 'MEMORY_APPROVAL_DENIED' });
    expect(unsupported.evidence.validate).not.toHaveBeenCalled();

    const insufficient = await makeHarness({ candidate: { quality: 'insufficient' } });
    await expect(insufficient.service.review(command(), operation())).rejects.toMatchObject({ code: 'MEMORY_APPROVAL_DENIED' });
    expect(insufficient.evidence.validate).not.toHaveBeenCalled();

    const expired = await makeHarness();
    await expect(expired.service.review(command(), operation('2026-12-01T00:00:00.000Z')))
      .rejects.toMatchObject({ code: 'MEMORY_APPROVAL_DENIED' });
    expect(expired.evidence.validate).not.toHaveBeenCalled();

    const noEvidence = await makeHarness({ candidate: { quality: 'sufficient', evidenceRefs: [] } });
    await expect(noEvidence.service.review(command(), operation())).rejects.toMatchObject({ code: 'MEMORY_EVIDENCE_UNAVAILABLE' });
    expect(noEvidence.evidence.validate).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'] as const)('rejects a %s investigation even when the reviewer claims support', async (sourceStatus: 'failed' | 'cancelled') => {
    const harness = await makeHarness({ sourceStatus });
    await expect(harness.service.review(command(), operation())).rejects.toMatchObject({ code: 'MEMORY_APPROVAL_DENIED' });
    expect(harness.evidence.validate).not.toHaveBeenCalled();
  });

  it('rejects a wrong scope before evidence lookup', async () => {
    const harness = await makeHarness();
    await expect(harness.service.review(command({ scope: { ...simulationMemoryScope(), datasetId: 'other' } }), operation()))
      .rejects.toMatchObject({ code: 'MEMORY_SCOPE_INVALID' });
    expect(harness.evidence.validate).not.toHaveBeenCalled();
  });

  it('supports approval then revocation, and permanently denies reapproval of a rejected case', async () => {
    const harness = await makeHarness();
    const approved = await harness.service.review(command(), operation());
    const rejected = await harness.service.review(command({ expectedRevision: approved.revision,
      requestId: 'revoke-request', decision: 'rejected' }), operation());
    expect(rejected).toMatchObject({ revision: 3, status: 'rejected', eligibleForPromotion: false });
    expect(await harness.state.memory.revalidate({ scope: simulationMemoryScope(), now: memoryNow,
      selections: [{ memoryId: rejected.id, revision: rejected.revision, digest: rejected.digest }] })).toEqual([]);
    const replay = await harness.service.review(command({ reviewedAt: '2026-12-01T00:00:00.000Z' }),
      operation('2026-12-01T00:00:00.000Z'));
    expect(replay).toEqual(approved);
    expect(await harness.state.memory.get('memory-1', simulationMemoryScope())).toEqual(rejected);
    await expect(harness.service.review(command({ requestId: 'reapprove-request', expectedRevision: rejected.revision }), operation()))
      .rejects.toMatchObject({ code: 'MEMORY_APPROVAL_DENIED' });
  });

  it('uses revision CAS and returns the original stored outcome for an identical request replay', async () => {
    const harness = await makeHarness();
    const originalCommand = command();
    const first = await harness.service.review(originalCommand, operation());
    const createCount = harness.events.createdTypes.length;
    const replay = await harness.service.review({ ...originalCommand, reviewedAt: '2026-10-11T00:00:00.000Z' }, operation());
    expect(replay).toEqual(first);
    expect(harness.events.createdTypes).toHaveLength(createCount);

    await expect(harness.service.review(command({ requestId: 'stale-request', expectedRevision: 1 }), operation()))
      .rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' });
    await expect(harness.service.review(command({ requestId: originalCommand.requestId, actorId: 'someone-else' }), operation()))
      .rejects.toMatchObject({ code: 'MEMORY_REQUEST_CONFLICT' });
  });

  it.each(['memory', 'sqlite'] as const)('%s store rolls back the case, review record, and already-enqueued first event on a later event-id collision', async (backend: 'memory' | 'sqlite') => {
    const harness = await makeHarness({ backend, conflictReviewEvent: true });
    await expect(harness.service.review(command(), operation())).rejects.toThrow();
    expect(await harness.state.memory.get('memory-1', simulationMemoryScope())).toEqual(harness.candidate);
    expect(await harness.state.memory.findReviewResult(command())).toBeNull();
  });

  it('does not complete or dispatch after the operation deadline has elapsed', async () => {
    const harness = await makeHarness();
    const delayedEvidence: MemoryEvidenceValidator = { validate: vi.fn(async () => {
      await Promise.resolve();
      return true;
    }) };
    const service = new MemoryReviewService({ queries: harness.state.memory, writes: harness.state.memory,
      evidence: delayedEvidence, events: harness.events.events, dispatch: harness.dispatch });
    const clockAtDeadline: Clock = { now: () => new Date(Date.parse(memoryNow) + 10_000) };

    await expect(service.review(command(), { now: memoryNow, deadlineMs: Date.parse(memoryNow) + 5_000, clock: clockAtDeadline }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('removes an approved case from the SQLite FTS index and preserves the revoked state after reopening', async () => {
    const harness = await makeHarness({ backend: 'sqlite' });
    const originalDatabase = harness.database;
    const directory = harness.databaseDirectory;
    if (originalDatabase === null || directory === null) throw new Error('SQLite review fixture was not created.');
    let activeDatabase: SqliteDatabase | null = originalDatabase;
    let reopenedDatabase: SqliteDatabase | null = null;
    try {
      const approved = await harness.service.review(command(), operation());
      expect(originalDatabase.raw.prepare('SELECT memory_id FROM diagnostic_memory_case_fts WHERE memory_id = ?')
        .get(approved.id)).toBeDefined();

      const rejected = await harness.service.review(command({ expectedRevision: approved.revision,
        requestId: 'sqlite-revoke-request', decision: 'rejected' }), operation());
      expect(rejected.status).toBe('rejected');
      expect(originalDatabase.raw.prepare('SELECT memory_id FROM diagnostic_memory_case_fts WHERE memory_id = ?')
        .get(rejected.id)).toBeUndefined();

      originalDatabase.close();
      activeDatabase = null;
      reopenedDatabase = SqliteDatabase.open(join(directory, 'state.sqlite'));
      const reopenedStore = new SqliteDiagnosticMemoryStore(reopenedDatabase, { clock });
      expect(await reopenedStore.get(rejected.id, simulationMemoryScope())).toMatchObject({ status: 'rejected', revision: 3 });
      expect(reopenedDatabase.raw.prepare('SELECT memory_id FROM diagnostic_memory_case_fts WHERE memory_id = ?')
        .get(rejected.id)).toBeUndefined();
    } finally {
      activeDatabase?.close();
      reopenedDatabase?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
