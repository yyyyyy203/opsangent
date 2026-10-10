import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { MemoryCaptureRequest, MemoryCaptureSource, MemoryEventFactory, MemoryJobClaim,
  MemoryPolicyPort, MemoryWriteUnitOfWork } from '../src/contracts/diagnostic-memory.js';
import type { Clock, IdGenerator } from '../src/contracts/common.js';
import { MemoryCaptureWorker } from '../src/memory/capture-worker.js';
import { MemoryCaptureService } from '../src/memory/capture-service.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import { captureContext, captureRequest, memoryEventFactory } from './fixtures/diagnostic-memory-capture.js';
import { memoryCase, memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(): MemoryCaptureRequest { return captureRequest(captureContext(), 'manual'); }
function claim(overrides: Partial<MemoryJobClaim> = {}): MemoryJobClaim {
  const req = request();
  return { request: req, ownerId: 'worker-1', attempt: 1, leaseUntil: '2026-10-10T00:00:30.000Z', ...overrides };
}

function setup(sourceLoad: MemoryCaptureSource['load'], claimSequence?: readonly MemoryJobClaim[]) {
  let calls = 0;
  const failedCaptures: Parameters<MemoryWriteUnitOfWork['failCapture']>[0][] = [];
  const source: MemoryCaptureSource = {
    inspect: async () => null,
    load: sourceLoad,
  };
  const writes: MemoryWriteUnitOfWork = {
    enqueueManualCapture: async () => { throw new Error('not used'); },
    claimNext: vi.fn(async () => claimSequence === undefined
      ? (calls++ === 0 ? claim() : null)
      : (claimSequence[calls++] ?? null)),
    completeCapture: vi.fn(async (input: Parameters<MemoryWriteUnitOfWork['completeCapture']>[0]) => input.candidate),
    failCapture: vi.fn((input: Parameters<MemoryWriteUnitOfWork['failCapture']>[0]) => {
      failedCaptures.push(input);
      return Promise.resolve();
    }),
    review: async () => { throw new Error('not used'); },
  };
  const dispatch = vi.fn(async () => {});
  const clock = { now: () => new Date(memoryNow) };
  const events: MemoryEventFactory = memoryEventFactory();
  const worker = new MemoryCaptureWorker({ source, writes, clock, ownerId: 'worker-1', events, dispatch });
  return { source, writes, dispatch, worker, failedCaptures };
}

it('builds one deterministic observation and commits it before dispatching the outbox', async () => {
  const context = captureContext();
  const harness = setup(async () => ({ context,
    evidenceRefs: memoryCase({ sourceRunId: context.runId, evidenceRefs: [{ evidenceId: 'capture-evidence',
      ownerRunId: context.runId, source: 'metric', capturedAt: memoryNow, rawSha256: 'b'.repeat(64) }] }).evidenceRefs,
    requiredEvidenceComplete: true, limitations: [] }));
  const result = await harness.worker.drain({ limit: 1 });
  expect(result).toEqual({ completed: 1, failed: 0, pending: true });
  expect(harness.writes.completeCapture).toHaveBeenCalledWith(expect.objectContaining({
    claim: expect.objectContaining({ ownerId: 'worker-1' }), candidate: expect.objectContaining({
      status: 'observation', eligibleForPromotion: false,
    }),
  }));
  expect(harness.dispatch).toHaveBeenCalledTimes(1);
});

it('propagates AbortError without failing the durable lease', async () => {
  const abort = new DOMException('cancelled', 'AbortError');
  const harness = setup(async () => { throw abort; });
  await expect(harness.worker.drain({ limit: 1 })).rejects.toBe(abort);
  expect(harness.writes.failCapture).not.toHaveBeenCalled();
  expect(harness.writes.completeCapture).not.toHaveBeenCalled();
});

it('retries a persisted job at most once and leaves final failure event selection to storage', async () => {
  const first = claim({ attempt: 1 });
  const second = claim({ attempt: 2 });
  const harness = setup(async () => { throw new Error('private source payload'); }, [first, second]);
  const result = await harness.worker.drain({ limit: 2 });
  expect(result).toEqual({ completed: 0, failed: 2, pending: true });
  expect(harness.writes.failCapture).toHaveBeenCalledTimes(2);
  expect(harness.failedCaptures.map((input) => input.events)).toEqual([[], []]);
});

it('rejects oversized drains and close waits for its active drain before refusing new work', async () => {
  const context = captureContext();
  let releaseLoad: (value: Awaited<ReturnType<MemoryCaptureSource['load']>>) => void = () => {
    throw new Error('load gate was not initialized');
  };
  const loadGate = new Promise<Awaited<ReturnType<MemoryCaptureSource['load']>>>((resolve) => { releaseLoad = resolve; });
  const harness = setup(async () => loadGate);
  await expect(harness.worker.drain({ limit: 51 })).rejects.toMatchObject({ code: 'MEMORY_DATA_INVALID' });
  const draining = harness.worker.drain({ limit: 1 });
  let closed = false;
  const closing = harness.worker.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  releaseLoad({ context, evidenceRefs: [], requiredEvidenceComplete: false, limitations: [] });
  await draining;
  await closing;
  expect(closed).toBe(true);
  await expect(harness.worker.drain({ limit: 1 })).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
});

it('recovers a committed candidate and pending outbox after a process-style close and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentops-memory-worker-recovery-'));
  roots.push(root);
  const path = join(root, 'agent.sqlite');
  const clock: Clock = { now: () => new Date() };
  const ids: IdGenerator = { next: (prefix) => `${prefix}-integration` };
  const events = memoryEventFactory();
  const policy: MemoryPolicyPort = { allows: () => true };
  const first = createSqlitePersistence({ path, clock, ids });
  let dispatcherCalls = 0;
  let failFirstDrain = false;
  const dispatchFirst = async () => {
    dispatcherCalls += 1;
    if (failFirstDrain) {
      failFirstDrain = false;
      throw new Error('dispatcher unavailable after candidate commit');
    }
  };
  const context = captureContext();
  const checkpoint = await first.checkpoints.save(context, null);
  await first.evidence.save({ evidenceId: 'capture-evidence', runId: context.runId, source: 'metric',
    summary: { start: 1, end: 2 }, raw: { metricValue: 0.2 }, businessTraceIds: [], capturedAt: memoryNow });
  const service = new MemoryCaptureService({ source: first.memory.captureSource, queries: first.memory.queries,
    writes: first.memory.writes, policy, ids, requiredSources: ['metric'], events, dispatch: dispatchFirst });
  await service.capture({ sourceRunId: context.runId, scope: simulationMemoryScope(),
    expectedCheckpointRevision: checkpoint.revision, requestId: 'worker-recovery-request',
    actorId: 'local-operator', requestedAt: new Date().toISOString() },
  { now: new Date().toISOString(), deadlineMs: Date.now() + 30_000, clock });
  failFirstDrain = true;
  const worker = new MemoryCaptureWorker({ source: first.memory.captureSource, writes: first.memory.writes,
    clock, ownerId: 'worker-before-restart', events, dispatch: dispatchFirst });
  await expect(worker.drain({ limit: 1 })).rejects.toThrow('dispatcher unavailable after candidate commit');
  await worker.close();
  first.close();

  const reopened = createSqlitePersistence({ path, clock, ids });
  try {
    expect(await reopened.memory.queries.getCapture({ runId: context.runId, scope: simulationMemoryScope() })).toMatchObject({
      state: 'saved', candidateId: 'memory-integration', memoryId: 'memory-integration',
    });
    const persisted = await reopened.memory.queries.list({ scope: simulationMemoryScope(), status: 'observation', limit: 10 });
    expect(persisted).toHaveLength(1);
    expect((await reopened.outbox.listPending({ runId: context.runId, limit: 10 })).map((item) => item.event.type))
      .toContain('MEMORY_UPDATE_COMPLETED');
    const replayWorker = new MemoryCaptureWorker({ source: reopened.memory.captureSource,
      writes: reopened.memory.writes, clock, ownerId: 'worker-after-restart', events,
      dispatch: async () => { dispatcherCalls += 1; } });
    expect(await replayWorker.drain({ limit: 1 })).toEqual({ completed: 0, failed: 0, pending: false });
    await replayWorker.close();
    expect(dispatcherCalls).toBe(3);
    expect(await reopened.memory.queries.list({ scope: simulationMemoryScope(), status: 'observation', limit: 10 }))
      .toHaveLength(1);
  } finally {
    reopened.close();
  }
});

it('delegates ordinary generation failure to the persisted fixed event template without leaking the exception', async () => {
  const harness = setup(async () => { throw new Error('private endpoint and secret=do-not-store'); });
  await harness.worker.drain({ limit: 1 });
  expect(harness.writes.failCapture).toHaveBeenCalledWith(expect.objectContaining({
    code: 'MEMORY_CAPTURE_FAILED', events: [],
  }));
  expect(JSON.stringify(vi.mocked(harness.writes.failCapture).mock.calls)).not.toContain('do-not-store');
});
