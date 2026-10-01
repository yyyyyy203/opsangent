import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type { Clock, EvidencePage, EvidenceQueryStore, EvidenceRecord, EvidenceStore } from '../src/contracts/index.js';
import { InMemoryCheckpointStore } from '../src/storage/in-memory-checkpoint-store.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { InMemoryInspectionQueryService } from '../src/storage/in-memory-inspection-query.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const fixedClock: Clock = { now: () => new Date('2026-10-01T00:00:00.000Z') };

describe('InspectionQueryService', () => {
  it('reads only one evidence page for a bounded response', async () => {
    const evidence = new FirstPageOnlyEvidenceStore();
    const checkpoints = new InMemoryCheckpointStore();
    await checkpoints.save({
      runId: 'run-1', status: 'completed', stage: 'postmortem', profileId: 'profile-a', messages: [], pendingToolCalls: [],
      confirmedToolCallIds: [], rejectedToolCallIds: [], executedActions: [], evidenceIds: [], missingEvidence: [],
      budget: { startedAt: '2026-10-01T00:00:00.000Z', maxIterations: 4, iteration: 1, maxToolCalls: 4, toolCallsUsed: 0, maxDurationMs: 60_000 },
      contextVersion: 1,
    });
    const queries = new InMemoryInspectionQueryService(new InMemoryEventMessageStore(), checkpoints, evidence);

    const page = await queries.listEvidence('run-1', { limit: 1 });

    expect(page.items.map((item) => item.evidenceId)).toEqual(['evidence-1']);
    expect(page.nextCursor).toBeTypeOf('string');
    expect(evidence.pageRequests).toBe(1);
  });

  it('finds an in-memory Subagent relationship beyond the first event batch', async () => {
    const events = new InMemoryEventMessageStore();
    const checkpoints = new InMemoryCheckpointStore();
    await checkpoints.save(runContext('parent-run'));
    await checkpoints.save(runContext('child-run'));
    let id = 0;
    const factory = new EventFactoryV2(fixedClock, { next: (prefix) => `${prefix}-${++id}` });
    const filler = Array.from({ length: 100 }, () => factory.create('RUN_STARTED', {
      runId: 'child-run', correlationId: 'corr-child', visibility: 'public', durability: 'durable',
    }, { profile: 'profile-a', trigger: 'manual', deadline: fixedClock.now().toISOString(), versionSnapshot: {} }));
    const started = factory.create('SUBAGENT_STARTED', {
      runId: 'child-run', correlationId: 'corr-child', visibility: 'public', durability: 'durable',
    }, {
      subagentType: 'metrics', childRunId: 'child-run', parentRunId: 'parent-run',
      budget: { type: 'tool_calls', limit: 4, used: 0 },
    });
    await events.append('child-run', 0, [...filler, started]);
    const queries = new InMemoryInspectionQueryService(events, checkpoints, new FirstPageOnlyEvidenceStore());

    expect((await queries.getRun('parent-run'))?.childRunIds).toEqual(['child-run']);
    expect((await queries.getRun('child-run'))?.parentRunId).toBe('parent-run');
  });

  it('lists completed Runs and exposes only bounded evidence metadata', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: '诊断完成', toolCalls: [] }]),
      workspaceRoots: [],
    });
    try {
      await runtime.agent.reply({ runId: 'run-1', message: '巡检', profileId: 'group-buy-market' });
      await runtime.evidence.save({
        evidenceId: 'evidence-1',
        runId: 'run-1',
        source: 'metric',
        summary: { failureRate: 0.15, endpoint: 'http://10.0.0.2:9090' },
        raw: { secretMarker: 'must-not-leave-storage' },
        businessTraceIds: ['trace-1'],
        capturedAt: '2026-09-30T10:00:00.000Z',
      });

      const queries = runtime.queries;
      if (queries === undefined) throw new Error('runtime query service is not configured');
      const runs = await queries.listRuns({ limit: 1 });
      expect(runs.items).toHaveLength(1);
      expect(runs.items[0]).toMatchObject({ runId: 'run-1', profileId: 'group-buy-market', status: 'completed' });

      const evidence = await queries.listEvidence('run-1');
      expect(evidence.items).toHaveLength(1);
      expect(evidence.items[0]).toMatchObject({ evidenceId: 'evidence-1', source: 'metric', traceIdCount: 1 });
      expect(evidence.items[0]?.summary).toEqual({ failureRate: 0.15, endpoint: '[REDACTED]' });
      expect(JSON.stringify(evidence)).not.toContain('must-not-leave-storage');
      expect(await queries.getEvidence('other-run', 'evidence-1')).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it('keeps Run pagination stable when multiple checkpoints share a timestamp', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: '完成', toolCalls: [] }]),
      workspaceRoots: [],
    });
    try {
      await runtime.agent.reply({ runId: 'run-a', message: '巡检', profileId: 'profile-a' });
      await runtime.agent.reply({ runId: 'run-b', message: '巡检', profileId: 'profile-a' });
      const queries = runtime.queries;
      if (queries === undefined) throw new Error('runtime query service is not configured');
      const first = await queries.listRuns({ profileId: 'profile-a', limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toBeTypeOf('string');
      if (first.nextCursor === undefined) throw new Error('expected a next cursor');
      const second = await queries.listRuns({ profileId: 'profile-a', cursor: first.nextCursor, limit: 1 });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.runId).not.toBe(first.items[0]?.runId);
    } finally {
      await runtime.close();
    }
  });
});

class FirstPageOnlyEvidenceStore implements EvidenceStore, EvidenceQueryStore {
  public pageRequests = 0;

  public save(record: EvidenceRecord): Promise<void> { void record; return Promise.resolve(); }
  public get(evidenceId: string): Promise<EvidenceRecord | null> { void evidenceId; return Promise.resolve(null); }

  public listByRun(runId: string): Promise<EvidencePage> {
    this.pageRequests += 1;
    if (this.pageRequests > 1) throw new Error('bounded query must not fetch a second page');
    return Promise.resolve({
      items: [{
        evidenceId: 'evidence-1', runId, source: 'metric', summary: { status: 'partial' }, raw: null,
        businessTraceIds: [], capturedAt: '2026-10-01T00:00:00.000Z',
      }],
      nextCursor: 'more',
    });
  }
}

function runContext(runId: string) {
  return {
    runId, status: 'completed' as const, stage: 'postmortem' as const, profileId: 'profile-a', messages: [], pendingToolCalls: [],
    confirmedToolCallIds: [], rejectedToolCallIds: [], executedActions: [], evidenceIds: [], missingEvidence: [],
    budget: { startedAt: fixedClock.now().toISOString(), maxIterations: 4, iteration: 1, maxToolCalls: 4, toolCallsUsed: 0, maxDurationMs: 60_000 },
    contextVersion: 1,
  };
}
