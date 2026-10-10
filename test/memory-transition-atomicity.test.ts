import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentContext, Clock, DurableTransitionUnitOfWork, MemoryCaptureIntent } from '../src/contracts/index.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteDurableStateStore } from '../src/infrastructure/sqlite/durable-state-store.js';
import { SqliteEventOutboxStore } from '../src/infrastructure/sqlite/event-outbox-store.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';
import { checkpointChecksum, parseAgentContext } from '../src/storage/durable-codec.js';
import { memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const clock: Clock = { now: () => new Date(memoryNow) };

export function sourceContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return parseAgentContext({
    runId: 'historical-run-1', profileId: 'simulation', status: 'completed', stage: 'postmortem',
    messages: [], pendingToolCalls: [], confirmedToolCallIds: [], rejectedToolCallIds: [],
    executedActions: [], evidenceIds: ['evidence-1'], missingEvidence: [], contextVersion: 1,
    budget: { startedAt: memoryNow, maxIterations: 8, iteration: 1, maxToolCalls: 16,
      toolCallsUsed: 1, maxDurationMs: 60_000 },
    memoryControl: { schemaVersion: 1, scope: simulationMemoryScope(), profilePolicyRevision: 'policy-v1',
      capture: 'automatic', recall: false }, ...overrides,
  });
}

export function captureIntent(context = sourceContext()): MemoryCaptureIntent {
  const envelope = { schemaVersion: 2 as const, runId: context.runId, correlationId: `run:${context.runId}`,
    timestamp: memoryNow, visibility: 'audit' as const, durability: 'durable' as const };
  const failure = (eventId: string, category: 'MEMORY_CAPACITY_EXCEEDED' | 'MEMORY_CAPTURE_FAILED') => ({
    ...envelope, eventId, type: 'MEMORY_UPDATE_FAILED' as const,
    payload: { candidateId: 'memory-1', error: { code: 'STORAGE_ERROR' as const,
      message: 'Memory update unavailable.', retryable: false, details: { category } } },
  });
  return {
    request: { candidateId: 'memory-1', sourceRunId: context.runId, scope: simulationMemoryScope(),
      extractorVersion: 'episodic-v1', origin: 'automatic', requestId: 'automatic-1',
      sourceRunStatus: 'completed', sourceContextVersion: context.contextVersion,
      sourceCheckpointChecksum: checkpointChecksum(context), requiredSources: ['metric'], requestedAt: memoryNow },
    scheduledEvent: { ...envelope, eventId: 'schedule-1', type: 'MEMORY_UPDATE_SCHEDULED',
      payload: { candidateType: 'episodic', sourceRunId: context.runId } },
    rejectedEvent: failure('capacity-1', 'MEMORY_CAPACITY_EXCEEDED'),
    failedEvent: failure('failure-1', 'MEMORY_CAPTURE_FAILED'),
  };
}

describe.each(['memory', 'sqlite'] as const)('%s memory transition', (kind: 'memory' | 'sqlite') => {
  it('stages an automatic capture fact inside the completed checkpoint transaction', async () => {
    let transitions: DurableTransitionUnitOfWork;
    let outbox;
    if (kind === 'memory') {
      const state = new InMemoryDurableState(clock);
      transitions = state;
      outbox = state.outbox;
    } else {
      const root = await mkdtemp(join(tmpdir(), 'agentops-memory-transition-'));
      const database = SqliteDatabase.open(join(root, 'state.sqlite'));
      cleanups.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
      transitions = new SqliteDurableStateStore(database, clock);
      outbox = new SqliteEventOutboxStore(database);
    }
    // The baseline transition silently ignores this additive field. This test
    // catches a separate post-checkpoint memory save or missing Job/outbox integration.
    const input: Parameters<DurableTransitionUnitOfWork['commit']>[0] & { memoryCapture: MemoryCaptureIntent } = {
      expectedRevision: null, context: sourceContext(), outboxEvents: [], memoryCapture: captureIntent(),
    };
    await transitions.commit(input);
    expect((await outbox.listPending({ limit: 10 })).map((record) => record.event.type))
      .toEqual(['MEMORY_UPDATE_SCHEDULED']);
  });
});
