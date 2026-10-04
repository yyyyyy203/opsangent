import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentContext, AgentEventPayloadMap, AgentEventTypeV2, EventCreationContextV2 } from '../src/contracts/index.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import { readAcceptanceSnapshot } from '../src/bootstrap/acceptance-reader.js';

const roots: string[] = [];
const now = '2026-10-04T12:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('acceptance SQLite reader', () => {
  it('reads a bounded parent/child Run tree and only public evidence summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-acceptance-reader-'));
    roots.push(root);
    const sqlitePath = join(root, 'agent.sqlite');
    const persistence = createSqlitePersistence({ path: sqlitePath, clock: { now: () => new Date(now) } });
    try {
      const parentId = 'acceptance-parent';
      const metricsId = 'acceptance-metrics-child';
      const logsId = 'acceptance-logs-child';
      await persistence.checkpoints.save(runContext(parentId, ['metric-evidence-1']), null);
      await persistence.checkpoints.save(runContext(metricsId, ['metric-evidence-1']), null);
      await persistence.checkpoints.save(runContext(logsId), null);
      let id = 0;
      const factory = new EventFactoryV2({ now: () => new Date(now) }, { next: (prefix) => `${prefix}-${++id}` });
      await append(persistence, factory, parentId, 'RUN_FINISHED', { outcome: 'complete', durationMs: 1 });
      await append(persistence, factory, metricsId, 'SUBAGENT_STARTED', {
        subagentType: 'metrics', childRunId: metricsId, parentRunId: parentId,
        budget: { type: 'tool_calls', limit: 8, used: 0 },
      }, { parentRunId: parentId, toolCallId: 'metrics-call' });
      await append(persistence, factory, metricsId, 'RUN_FINISHED', { outcome: 'complete', durationMs: 1 });
      await append(persistence, factory, logsId, 'SUBAGENT_STARTED', {
        subagentType: 'logs', childRunId: logsId, parentRunId: parentId,
        budget: { type: 'tool_calls', limit: 8, used: 0 },
      }, { parentRunId: parentId, toolCallId: 'logs-call' });
      await append(persistence, factory, logsId, 'RUN_FINISHED', { outcome: 'partial', durationMs: 1 });
      await persistence.evidence.save({
        evidenceId: 'metric-evidence-1', runId: metricsId, source: 'metric',
        summary: { status: 'breached', failureRate: 0.15 }, raw: { privateCanary: 'sqlite-reader-raw-canary' },
        businessTraceIds: [], capturedAt: now,
      });
    } finally {
      persistence.close();
    }

    const snapshot = await readAcceptanceSnapshot({ dataDirectory: root, runId: 'acceptance-parent' });
    expect(snapshot.parent.childRunIds).toEqual(['acceptance-metrics-child', 'acceptance-logs-child']);
    expect(snapshot.children.map((child) => child.parentRunId)).toEqual(['acceptance-parent', 'acceptance-parent']);
    expect(snapshot.events).toHaveLength(5);
    expect(snapshot.evidence).toMatchObject([{
      evidenceId: 'metric-evidence-1', runId: 'acceptance-metrics-child', retrievable: false,
    }]);
    expect(JSON.stringify(snapshot)).not.toContain('sqlite-reader-raw-canary');
  });

  it('does not create a database when the acceptance data directory has no existing database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-acceptance-empty-'));
    roots.push(root);
    await expect(readAcceptanceSnapshot({ dataDirectory: root, runId: 'missing-run' }))
      .rejects.toMatchObject({ code: 'DATABASE_NOT_FOUND' });
    expect(existsSync(join(root, 'agent.sqlite'))).toBe(false);
  });

  it('rejects relative directories, malformed Run IDs, and absent Runs with stable error codes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-acceptance-invalid-'));
    roots.push(root);
    await expect(readAcceptanceSnapshot({ dataDirectory: 'relative-data', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'INVALID_DATA_DIRECTORY' });
    await expect(readAcceptanceSnapshot({ dataDirectory: root, runId: 'bad\nrun' }))
      .rejects.toMatchObject({ code: 'INVALID_RUN_ID' });
    const persistence = createSqlitePersistence({ path: join(root, 'agent.sqlite') });
    persistence.close();
    await expect(readAcceptanceSnapshot({ dataDirectory: root, runId: 'absent-run' }))
      .rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });
});

function runContext(runId: string, evidenceIds: string[] = []): AgentContext {
  return {
    runId, status: 'completed', stage: 'postmortem', profileId: 'simulation', messages: [],
    pendingToolCalls: [], confirmedToolCallIds: [], rejectedToolCallIds: [], executedActions: [],
    evidenceIds, missingEvidence: [],
    budget: { startedAt: now, maxIterations: 4, iteration: 1, maxToolCalls: 8, toolCallsUsed: 1, maxDurationMs: 90_000 },
    contextVersion: 1,
  };
}

async function append<T extends AgentEventTypeV2>(
  persistence: ReturnType<typeof createSqlitePersistence>,
  factory: EventFactoryV2,
  runId: string,
  type: T,
  payload: AgentEventPayloadMap[T],
  context: Partial<EventCreationContextV2> = {},
): Promise<void> {
  const eventContext: EventCreationContextV2 = {
    runId, correlationId: `run:${runId}`, visibility: 'audit', durability: 'durable',
    ...context,
  };
  const event = factory.create(type, eventContext, payload);
  const sequence = await persistence.eventMessages.currentSequence(runId);
  await persistence.eventMessages.append(runId, sequence, [event]);
}
