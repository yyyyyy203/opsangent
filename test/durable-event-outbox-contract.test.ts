import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentContext,
  Clock,
  PendingAgentEventV2,
  PendingToolBatch,
  StoredRunCheckpoint,
  ToolCall,
  ToolExecutionJournal,
  ToolExecutionRecord,
  ToolExecutionResult,
  VersionedCheckpointStore,
} from '../src/contracts/index.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/index.js';

const roots: string[] = [];
const now = '2026-09-11T00:00:00.000Z';
const later = '2026-09-11T00:01:00.000Z';
const clock: Clock = { now: () => new Date(now) };

interface OutboxRecord {
  event: PendingAgentEventV2;
  enqueuedAt: string;
  publishedAt?: string;
}

interface TransitionPort {
  commit(input: {
    expectedRevision: number | null;
    context: AgentContext;
    execution?:
      | { kind: 'completed'; record: ToolExecutionRecord; result: ToolExecutionResult }
      | { kind: 'uncertain'; record: ToolExecutionRecord; reasonCode: string };
    outboxEvents: readonly PendingAgentEventV2[];
  }): Promise<StoredRunCheckpoint>;
}

interface OutboxPort {
  enqueue(input: { events: readonly PendingAgentEventV2[]; createdAt: string }): Promise<readonly OutboxRecord[]>;
  listPending(input: { runId?: string; limit: number }): Promise<readonly OutboxRecord[]>;
  markPublished(input: { eventId: string; publishedAt: string }): Promise<void>;
}

interface DurableBackend {
  checkpoints: VersionedCheckpointStore;
  executions: ToolExecutionJournal;
  transitions: TransitionPort;
  outbox: OutboxPort;
  close(): void;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    runId: 'run-1',
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

function call(id = 'call-1'): ToolCall {
  return { id, name: 'metrics.capture', input: { service: 'settlement' } };
}

function batch(toolCall: ToolCall): PendingToolBatch {
  return { batchId: 'batch-1', stepId: 'step-1', calls: [toolCall], completedResults: [], state: 'executing', createdAt: now };
}

function execution(toolCallId = 'call-1'): ToolExecutionRecord {
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

function result(toolCallId = 'call-1'): ToolExecutionResult {
  return {
    toolCallId,
    toolName: 'metrics.capture',
    status: 'success',
    response: { blocks: [{ type: 'text', text: 'captured' }] },
    startedAt: now,
    finishedAt: now,
  };
}

function event(eventId = 'event-1'): PendingAgentEventV2<'TOOL_RESULT'> {
  return {
    schemaVersion: 2,
    eventId,
    type: 'TOOL_RESULT',
    payload: { result: result(), durationMs: 0, evidenceIds: [] },
    runId: 'run-1',
    correlationId: 'run:run-1',
    timestamp: now,
    visibility: 'audit',
    durability: 'durable',
    stepId: 'step-1',
    toolCallId: 'call-1',
  };
}

async function backend(kind: 'memory' | 'sqlite'): Promise<DurableBackend> {
  if (kind === 'memory') {
    const state = new InMemoryDurableState(clock);
    return {
      checkpoints: state.checkpoints,
      executions: state.executions,
      transitions: state.transitions,
      outbox: state.outbox,
      close: () => undefined,
    };
  }
  const root = await mkdtemp(join(tmpdir(), 'agentops-outbox-'));
  roots.push(root);
  const persistence = createSqlitePersistence({ path: join(root, 'outbox.sqlite'), clock });
  return {
    checkpoints: persistence.checkpoints,
    executions: persistence.executions,
    transitions: persistence.transitions,
    outbox: persistence.outbox,
    close: () => persistence.close(),
  };
}

describe.each(['memory', 'sqlite'] as const)('%s durable event Outbox', (kind) => {
  it('commits checkpoint, terminal execution, and pending event atomically', async () => {
    const state = await backend(kind);
    try {
      const toolCall = call();
      const checkpoint = await state.checkpoints.save(context({
        pendingToolCalls: [toolCall],
        pendingToolBatch: batch(toolCall),
      }), null);
      await state.executions.prepare(execution());

      const saved = await state.transitions.commit({
        expectedRevision: checkpoint.revision,
        context: checkpoint.context,
        execution: { kind: 'completed', record: execution(), result: result() },
        outboxEvents: [event()],
      });

      expect(saved.context.pendingToolBatch?.completedResults).toEqual([result()]);
      expect(await state.executions.get('call-1')).toMatchObject({ state: 'succeeded', result: result() });
      expect(await state.outbox.listPending({ runId: 'run-1', limit: 10 })).toEqual([
        { event: event(), enqueuedAt: now },
      ]);
    } finally {
      state.close();
    }
  });

  it('leaves no event queued when its checkpoint CAS conflicts', async () => {
    const state = await backend(kind);
    try {
      const checkpoint = await state.checkpoints.save(context(), null);

      await expect(state.transitions.commit({
        expectedRevision: checkpoint.revision - 1,
        context: checkpoint.context,
        outboxEvents: [event('event-stale')],
      })).rejects.toMatchObject({ category: 'checkpoint_conflict' });

      expect(await state.outbox.listPending({ runId: 'run-1', limit: 10 })).toEqual([]);
    } finally {
      state.close();
    }
  });

  it('is idempotent for an identical event ID and rejects divergent reuse', async () => {
    const state = await backend(kind);
    try {
      const first = await state.outbox.enqueue({ events: [event('event-shared')], createdAt: now });
      const retry = await state.outbox.enqueue({ events: [event('event-shared')], createdAt: later });

      expect(retry).toEqual(first);
      await expect(state.outbox.enqueue({
        events: [{ ...event('event-shared'), payload: { ...event('event-shared').payload, durationMs: 1 } }],
        createdAt: later,
      })).rejects.toMatchObject({ eventId: 'event-shared' });

      await state.outbox.markPublished({ eventId: 'event-shared', publishedAt: later });
      await state.outbox.markPublished({ eventId: 'event-shared', publishedAt: later });
      expect(await state.outbox.listPending({ runId: 'run-1', limit: 10 })).toEqual([]);
    } finally {
      state.close();
    }
  });
});
