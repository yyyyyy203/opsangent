import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type { Clock, EvidencePage, EvidenceQueryStore, EvidenceRecord, EvidenceStore } from '../src/contracts/index.js';
import { InMemoryCheckpointStore } from '../src/storage/in-memory-checkpoint-store.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { InMemoryInspectionQueryService } from '../src/storage/in-memory-inspection-query.js';
import { InMemoryEvidenceStore } from '../src/storage/in-memory-evidence-store.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const fixedClock: Clock = { now: () => new Date('2026-10-01T00:00:00.000Z') };

describe('InspectionQueryService', () => {
  it.each([
    { label: 'mixed-case IDs', parentId: 'ev-a', childId: 'ev-Z', expected: ['ev-Z', 'ev-a'] },
    { label: 'supplementary Unicode IDs', parentId: 'ev-\u{10000}', childId: 'ev-\uE000', expected: ['ev-\uE000', 'ev-\u{10000}'] },
  ])('paginates equal-timestamp parent/child evidence in SQLite BINARY order: $label', async ({ parentId, childId, expected }) => {
    const events = new InMemoryEventMessageStore();
    const evidence = new InMemoryEvidenceStore();
    await appendParentChildRelation(events);
    for (const [runId, evidenceId] of [['parent-run', parentId], ['child-run', childId]] as const) {
      await evidence.save({
        runId, evidenceId, source: 'metric', summary: {}, raw: null, businessTraceIds: [],
        capturedAt: fixedClock.now().toISOString(),
      });
    }
    const queries = new InMemoryInspectionQueryService(events, new InMemoryCheckpointStore(), evidence);

    const first = await queries.listEvidence('parent-run', { limit: 1 });
    expect(first.items.map((item) => item.evidenceId)).toEqual([expected[0]]);
    if (first.nextCursor === undefined) throw new Error('parent evidence page should have a cursor');
    expect(JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))).toEqual({
      runId: 'parent-run', capturedAt: fixedClock.now().toISOString(), evidenceId: expected[0],
    });
    const second = await queries.listEvidence('parent-run', { limit: 1, cursor: first.nextCursor });
    expect(second.items.map((item) => item.evidenceId)).toEqual([expected[1]]);
    expect(second.nextCursor).toBeUndefined();
  });

  it.each([
    { label: 'mixed-case IDs', parentIds: ['ev-a', 'ev-Z'], childIds: ['ev-b', 'ev-Y'], expected: ['ev-Y', 'ev-Z', 'ev-a', 'ev-b'] },
    { label: 'supplementary Unicode IDs', parentIds: ['ev-\u{10000}', 'ev-\uE000'], childIds: ['ev-\u{10001}'], expected: ['ev-\uE000', 'ev-\u{10000}', 'ev-\u{10001}'] },
  ])('keeps bounded source pages and the parent merge in the same seek order: $label', async ({ parentIds, childIds, expected }) => {
    const events = new InMemoryEventMessageStore();
    const evidence = new InMemoryEvidenceStore();
    await appendParentChildRelation(events);
    for (const [runId, evidenceIds] of [['parent-run', parentIds], ['child-run', childIds]] as const) {
      for (const evidenceId of evidenceIds) {
        await evidence.save({ runId, evidenceId, source: 'metric', summary: {}, raw: null, businessTraceIds: [], capturedAt: fixedClock.now().toISOString() });
      }
    }
    const queries = new InMemoryInspectionQueryService(events, new InMemoryCheckpointStore(), evidence);

    let cursor: string | undefined;
    for (const [index, expectedId] of expected.entries()) {
      const page = await queries.listEvidence('parent-run', { limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      expect(page.items.map((item) => item.evidenceId)).toEqual([expectedId]);
      if (index < expected.length - 1) expect(page.nextCursor).toBeTypeOf('string');
      else expect(page.nextCursor).toBeUndefined();
      cursor = page.nextCursor;
    }
  });

  it.each([
    { label: 'invalid timestamp', runId: 'parent-run', capturedAt: 'not-a-time', evidenceId: 'ev-1' },
    { label: 'empty timestamp', runId: 'parent-run', capturedAt: '', evidenceId: 'ev-1' },
    { label: 'invalid calendar date', runId: 'parent-run', capturedAt: '2026-02-30T00:00:00.000Z', evidenceId: 'ev-1' },
    { label: 'empty evidence ID', runId: 'parent-run', capturedAt: fixedClock.now().toISOString(), evidenceId: '' },
    { label: 'empty Run ID', runId: '', capturedAt: fixedClock.now().toISOString(), evidenceId: 'ev-1' },
  ])('rejects a parent evidence cursor before child reencoding: $label', async ({ runId, capturedAt, evidenceId }) => {
    const events = new InMemoryEventMessageStore();
    await appendParentChildRelation(events);
    const queries = new InMemoryInspectionQueryService(events, new InMemoryCheckpointStore(), new InMemoryEvidenceStore());
    const cursor = Buffer.from(JSON.stringify({ runId, capturedAt, evidenceId }), 'utf8').toString('base64url');

    await expect(queries.listEvidence(runId, { limit: 1, cursor })).rejects.toThrow('evidence cursor is invalid');
  });

  it.each([
    '2026-10-01T00:00:00.000Z', '2026-10-01T08:00:00+08:00', '2026-10-01T00:00:00.000123Z',
  ])('preserves valid existing parent evidence cursors with timestamp %s', async (capturedAt) => {
    const events = new InMemoryEventMessageStore();
    const evidence = new InMemoryEvidenceStore();
    await appendParentChildRelation(events);
    for (const evidenceId of ['ev-1', 'ev-2']) {
      await evidence.save({ runId: 'child-run', evidenceId, source: 'metric', summary: {}, raw: null, businessTraceIds: [], capturedAt });
    }
    const queries = new InMemoryInspectionQueryService(events, new InMemoryCheckpointStore(), evidence);
    const cursor = Buffer.from(JSON.stringify({ runId: 'parent-run', capturedAt, evidenceId: 'ev-1' }), 'utf8').toString('base64url');

    const page = await queries.listEvidence('parent-run', { limit: 1, cursor });

    expect(page.items.map((item) => ({ evidenceId: item.evidenceId, capturedAt: item.capturedAt }))).toEqual([{ evidenceId: 'ev-2', capturedAt }]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('derives token usage from model audit events for the public Run detail', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: '诊断完成', toolCalls: [], usage: { inputTokens: 41, outputTokens: 9, cachedInputTokens: 3 } }]),
      workspaceRoots: [],
    });
    try {
      await runtime.agent.reply({ runId: 'usage-run', message: '巡检', profileId: 'group-buy-market' });
      const detail = await runtime.queries?.getRun('usage-run');

      expect(detail?.usage).toEqual({
        completeness: 'complete', inputTokens: 41, outputTokens: 9, cachedInputTokens: 3,
      });
    } finally {
      await runtime.close();
    }
  });

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

  it('lists and resolves child evidence through the parent in-memory Run tree', async () => {
    const events = new InMemoryEventMessageStore();
    const checkpoints = new InMemoryCheckpointStore();
    const evidence = new InMemoryEvidenceStore();
    await checkpoints.save(runContext('parent-run'));
    await checkpoints.save(runContext('child-run'));
    const factory = new EventFactoryV2(fixedClock, { next: (prefix) => `${prefix}-tree` });
    const relation = factory.create('SUBAGENT_STARTED', {
      runId: 'parent-run', correlationId: 'corr-parent', visibility: 'public', durability: 'durable',
    }, {
      subagentType: 'metrics', childRunId: 'child-run', parentRunId: 'parent-run',
      budget: { type: 'tool_calls', limit: 4, used: 0 },
    });
    await events.append('parent-run', 0, [relation]);
    for (const [index, evidenceId] of ['child-evidence-1', 'child-evidence-2'].entries()) {
      await evidence.save({
        evidenceId, runId: 'child-run', source: 'metric', summary: { failureRate: 0.15 + index },
        raw: { marker: 'must-stay-private' }, businessTraceIds: [],
        capturedAt: `2026-10-01T00:00:0${index + 1}.000Z`,
      });
    }
    const queries = new InMemoryInspectionQueryService(events, checkpoints, evidence);

    const first = await queries.listEvidence('parent-run', { limit: 1 });
    if (first.nextCursor === undefined) throw new Error('parent evidence page should have a cursor');
    const second = await queries.listEvidence('parent-run', { limit: 1, cursor: first.nextCursor });

    expect(first.items.map((item) => item.evidenceId)).toEqual(['child-evidence-1']);
    expect(second.items.map((item) => item.evidenceId)).toEqual(['child-evidence-2']);
    expect(await queries.getEvidence('parent-run', 'child-evidence-1')).toMatchObject({
      evidenceId: 'child-evidence-1', runId: 'child-run', retrievable: false,
    });
    expect(JSON.stringify([first, second])).not.toContain('must-stay-private');
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

async function appendParentChildRelation(events: InMemoryEventMessageStore): Promise<void> {
  const factory = new EventFactoryV2(fixedClock, { next: (prefix) => `${prefix}-pagination` });
  await events.append('parent-run', 0, [factory.create('SUBAGENT_STARTED', {
    runId: 'parent-run', correlationId: 'corr-parent', visibility: 'public', durability: 'durable',
  }, {
    subagentType: 'metrics', childRunId: 'child-run', parentRunId: 'parent-run',
    budget: { type: 'tool_calls', limit: 4, used: 0 },
  })]);
}

function runContext(runId: string) {
  return {
    runId, status: 'completed' as const, stage: 'postmortem' as const, profileId: 'profile-a', messages: [], pendingToolCalls: [],
    confirmedToolCallIds: [], rejectedToolCallIds: [], executedActions: [], evidenceIds: [], missingEvidence: [],
    budget: { startedAt: fixedClock.now().toISOString(), maxIterations: 4, iteration: 1, maxToolCalls: 4, toolCallsUsed: 0, maxDurationMs: 60_000 },
    contextVersion: 1,
  };
}
