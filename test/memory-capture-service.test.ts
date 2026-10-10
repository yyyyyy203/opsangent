import { expect, it, vi } from 'vitest';
import type {
  MemoryCaptureRequest, MemoryCaptureSource, MemoryCaptureTicket, MemoryEventFactory,
  MemoryManualCaptureCommand, MemoryPolicyPort, MemoryQueryStore, MemoryWriteUnitOfWork,
} from '../src/contracts/diagnostic-memory.js';
import { MemoryError } from '../src/memory/memory-error.js';
import { MemoryCaptureService } from '../src/memory/capture-service.js';
import { captureContext, memoryEventFactory } from './fixtures/diagnostic-memory-capture.js';
import { memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';
import { checkpointChecksum } from '../src/storage/durable-codec.js';

function command(overrides: Partial<MemoryManualCaptureCommand> = {}): MemoryManualCaptureCommand {
  return { sourceRunId: 'capture-run', scope: simulationMemoryScope(), expectedCheckpointRevision: 1,
    requestId: 'manual-request-1', actorId: 'local-operator', requestedAt: memoryNow, ...overrides };
}

function setup(options: { status?: 'completed' | 'failed' | 'cancelled' | 'running'; revision?: number;
  isParent?: boolean; allowed?: boolean; replay?: MemoryCaptureTicket | null } = {}) {
  const context = captureContext(options.status ?? 'completed');
  const source: MemoryCaptureSource = {
    inspect: vi.fn(async () => ({ context, checkpointRevision: options.revision ?? 1,
      checkpointChecksum: checkpointChecksum(context), isParent: options.isParent ?? true })),
    load: vi.fn(async () => ({ context, evidenceRefs: [], requiredEvidenceComplete: false, limitations: [] })),
  };
  const queries: MemoryQueryStore = {
    get: async () => null, getCapture: async () => null,
    findCaptureResult: vi.fn(async () => options.replay ?? null), findReviewResult: async () => null,
    list: async () => [], search: async () => [], revalidate: async () => [],
  };
  let queued: { command: MemoryManualCaptureCommand; intent: { request: MemoryCaptureRequest } } | undefined;
  const ticket: MemoryCaptureTicket = { sourceRunId: context.runId, state: 'queued', sourceCheckpointRevision: options.revision ?? 1,
    candidateId: 'candidate-1' };
  const writes: MemoryWriteUnitOfWork = {
    enqueueManualCapture: vi.fn(async (input: Parameters<MemoryWriteUnitOfWork['enqueueManualCapture']>[0]) => {
      queued = input; return ticket;
    }),
    claimNext: async () => null, completeCapture: async () => { throw new Error('not used'); },
    failCapture: async () => {}, review: async () => { throw new Error('not used'); },
  };
  const policy: MemoryPolicyPort = { allows: () => options.allowed ?? true };
  let id = 0;
  const ids = { next: (prefix: string) => `${prefix}-${++id}` };
  const dispatch = vi.fn(async () => {});
  const events: MemoryEventFactory = memoryEventFactory();
  const service = new MemoryCaptureService({ source, queries, writes, policy, ids,
    requiredSources: ['metric'], events, dispatch });
  return { context, source, queries, writes, service, dispatch, get queued() { return queued; }, ticket };
}

it('enqueues a manual capture from a saved terminal parent without changing its checkpoint', async () => {
  const harness = setup();
  const result = await harness.service.capture(command(), { now: memoryNow, deadlineMs: Date.now() + 1000 });
  expect(result).toEqual(harness.ticket);
  expect(harness.queued?.intent.request).toMatchObject({ sourceRunId: harness.context.runId,
    origin: 'manual', sourceContextVersion: harness.context.contextVersion,
    sourceCheckpointChecksum: checkpointChecksum(harness.context), requiredSources: ['metric'] });
  expect(harness.dispatch).toHaveBeenCalledTimes(1);
  expect(harness.source.load).not.toHaveBeenCalled();
});

it('replays an authorized request before rejecting a now-stale source revision', async () => {
  const replay: MemoryCaptureTicket = { sourceRunId: 'capture-run', state: 'queued', sourceCheckpointRevision: 1, candidateId: 'candidate-1' };
  const harness = setup({ revision: 2, replay });
  expect(await harness.service.capture(command(), { now: memoryNow, deadlineMs: Date.now() + 1000 })).toEqual(replay);
  expect(harness.writes.enqueueManualCapture).not.toHaveBeenCalled();
  expect(harness.dispatch).not.toHaveBeenCalled();
});

it('rejects a new request with a stale checkpoint revision before enqueueing', async () => {
  const harness = setup({ revision: 2 });
  await expect(harness.service.capture(command({ expectedCheckpointRevision: 1 }), {
    now: memoryNow, deadlineMs: Date.now() + 1000,
  })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_CONFLICT' });
  expect(harness.writes.enqueueManualCapture).not.toHaveBeenCalled();
});

it('fails closed for nonterminal runs, child runs, scope mismatch, and revoked policy', async () => {
  for (const options of [
    { status: 'running' as const }, { isParent: false }, { allowed: false },
  ]) {
    const harness = setup(options);
    await expect(harness.service.capture(command(), { now: memoryNow, deadlineMs: Date.now() + 1000 }))
      .rejects.toBeInstanceOf(MemoryError);
    expect(harness.writes.enqueueManualCapture).not.toHaveBeenCalled();
  }
  const harness = setup();
  await expect(harness.service.capture(command({ scope: { ...simulationMemoryScope(), datasetId: 'other' } }),
    { now: memoryNow, deadlineMs: Date.now() + 1000 })).rejects.toBeInstanceOf(MemoryError);
});

it('accepts an explicit manual archive for a failed terminal run without claiming success', async () => {
  const failed = captureContext('failed');
  const harness = setup({ status: 'failed' });
  await harness.service.capture(command(), { now: memoryNow, deadlineMs: Date.now() + 1000 });
  expect(harness.queued?.intent.request.sourceRunStatus).toBe(failed.status);
});

it('uses the injected operation clock to stop work at its deadline', async () => {
  const harness = setup();
  const nowMs = Date.now();
  await expect(harness.service.capture(command(), {
    now: new Date(nowMs).toISOString(), deadlineMs: nowMs + 1,
    clock: { now: () => new Date(nowMs + 2) },
  })).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(harness.source.inspect).not.toHaveBeenCalled();
});
