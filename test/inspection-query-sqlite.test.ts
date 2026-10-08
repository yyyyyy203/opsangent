import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentContext, Clock, EvidenceRecord } from '../src/contracts/index.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/index.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';

const roots: string[] = [];
const now = '2026-09-30T10:00:00.000Z';
const clock: Clock = { now: () => new Date(now) };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function context(runId: string, profileId: string): AgentContext {
  return {
    runId,
    status: 'completed',
    stage: 'postmortem',
    profileId,
    messages: [],
    pendingToolCalls: [],
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: ['evidence-1'],
    missingEvidence: ['logs'],
    budget: { startedAt: now, maxIterations: 8, iteration: 1, maxToolCalls: 16, toolCallsUsed: 1, maxDurationMs: 60_000 },
    contextVersion: 1,
  };
}

function evidence(): EvidenceRecord {
  return {
    evidenceId: 'evidence-1',
    runId: 'run-1',
    source: 'metric',
    summary: { failureRate: 0.15, endpoint: 'http://10.0.0.2:9090' },
    raw: { privateMarker: 'sqlite-raw-marker' },
    businessTraceIds: ['trace-1'],
    capturedAt: '2026-09-30T10:00:01.000Z',
  };
}

function ids() {
  let value = 0;
  return { next: (prefix: string) => `${prefix}-${++value}` };
}

async function commitManifest(
  persistence: ReturnType<typeof createSqlitePersistence>,
  input: { evidenceId: string; manifestId: string; runId: string; capturedAt: string },
): Promise<void> {
  await persistence.evidenceManifests.createPending({
    manifestId: input.manifestId,
    evidenceId: input.evidenceId,
    runId: input.runId,
    stepId: 'step-1',
    toolCallId: 'tool-1',
    captureKey: `capture-${input.evidenceId}`,
    source: 'log',
    queryDigest: 'query-digest',
    timeRange: { start: input.capturedAt, end: input.capturedAt },
    compression: 'gzip_ndjson',
    redactionPolicyVersion: 'v1',
    createdAt: input.capturedAt,
  });
  await persistence.evidenceManifests.commit({
    evidenceId: input.evidenceId,
    descriptor: {
      manifestId: input.manifestId,
      evidenceId: input.evidenceId,
      captureKey: `capture-${input.evidenceId}`,
      compression: 'gzip_ndjson',
      sourceBytes: 0,
      storedBytes: 0,
      rawSha256: 'a'.repeat(64),
      chunks: [],
    },
    summary: { recordCount: 0, sourceBytes: 0, levels: [], services: [], exceptionSignatures: [], traceIds: [], samples: [] },
    coverage: 1,
    truncated: false,
    missingEvidence: [],
    updatedAt: input.capturedAt,
    committedAt: input.capturedAt,
  });
}

describe('SQLite inspection query read model', () => {
  it.each([
    { label: 'inline mixed-case IDs', parentKind: 'inline', childKind: 'inline', parentId: 'ev-a', childId: 'ev-Z', expected: ['ev-Z', 'ev-a'] },
    { label: 'manifest mixed-case IDs', parentKind: 'manifest', childKind: 'manifest', parentId: 'ev-a', childId: 'ev-Z', expected: ['ev-Z', 'ev-a'] },
    { label: 'inline and manifest mixed-case IDs', parentKind: 'inline', childKind: 'manifest', parentId: 'ev-a', childId: 'ev-Z', expected: ['ev-Z', 'ev-a'] },
    { label: 'supplementary Unicode IDs', parentKind: 'inline', childKind: 'inline', parentId: 'ev-\u{10000}', childId: 'ev-\uE000', expected: ['ev-\uE000', 'ev-\u{10000}'] },
  ])('paginates equal-timestamp parent/child evidence in SQLite BINARY order: $label', async ({ parentKind, childKind, parentId, childId, expected }) => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-inspection-binary-order-'));
    roots.push(root);
    const persistence = createSqlitePersistence({ path: join(root, 'runtime.sqlite'), clock });
    try {
      const factory = new EventFactoryV2(clock, ids());
      await persistence.eventMessages.append('parent-run', 0, [factory.create('SUBAGENT_STARTED', {
        runId: 'parent-run', correlationId: 'corr-parent', visibility: 'public', durability: 'durable',
      }, {
        subagentType: 'metrics', childRunId: 'child-run', parentRunId: 'parent-run',
        budget: { type: 'tool_calls', limit: 4, used: 0 },
      })]);
      for (const [runId, evidenceId, kind] of [
        ['parent-run', parentId, parentKind], ['child-run', childId, childKind],
      ] as const) {
        if (kind === 'manifest') {
          await commitManifest(persistence, { runId, evidenceId, manifestId: `manifest-${evidenceId}`, capturedAt: now });
        } else {
          await persistence.evidence.save({ ...evidence(), runId, evidenceId, capturedAt: now });
        }
      }

      const first = await persistence.queries.listEvidence('parent-run', { limit: 1 });
      expect(first.items.map((item) => item.evidenceId)).toEqual([expected[0]]);
      if (first.nextCursor === undefined) throw new Error('parent evidence page should have a cursor');
      expect(JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))).toEqual({
        runId: 'parent-run', capturedAt: now, evidenceId: expected[0],
      });
      const second = await persistence.queries.listEvidence('parent-run', { limit: 1, cursor: first.nextCursor });
      expect(second.items.map((item) => item.evidenceId)).toEqual([expected[1]]);
      expect(second.nextCursor).toBeUndefined();
    } finally {
      persistence.close();
    }
  });

  it('keeps inline/manifest source pages and the parent merge in the same seek order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-inspection-source-order-'));
    roots.push(root);
    const persistence = createSqlitePersistence({ path: join(root, 'runtime.sqlite'), clock });
    try {
      const factory = new EventFactoryV2(clock, ids());
      await persistence.eventMessages.append('parent-run', 0, [factory.create('SUBAGENT_STARTED', {
        runId: 'parent-run', correlationId: 'corr-parent', visibility: 'public', durability: 'durable',
      }, {
        subagentType: 'metrics', childRunId: 'child-run', parentRunId: 'parent-run',
        budget: { type: 'tool_calls', limit: 4, used: 0 },
      })]);
      for (const runId of ['parent-run', 'child-run']) {
        const evidenceId = runId === 'parent-run' ? 'ev-a' : 'ev-b';
        const manifestId = runId === 'parent-run' ? 'ev-Z' : 'ev-Y';
        await persistence.evidence.save({ ...evidence(), runId, evidenceId, capturedAt: now });
        await commitManifest(persistence, { runId, evidenceId: manifestId, manifestId: `manifest-${manifestId}`, capturedAt: now });
      }

      let cursor: string | undefined;
      for (const [index, expectedId] of ['ev-Y', 'ev-Z', 'ev-a', 'ev-b'].entries()) {
        const page = await persistence.queries.listEvidence('parent-run', { limit: 1, ...(cursor === undefined ? {} : { cursor }) });
        expect(page.items.map((item) => item.evidenceId)).toEqual([expectedId]);
        if (index < 3) expect(page.nextCursor).toBeTypeOf('string');
        else expect(page.nextCursor).toBeUndefined();
        cursor = page.nextCursor;
      }
    } finally {
      persistence.close();
    }
  });

  it.each([
    { label: 'invalid timestamp', runId: 'parent-run', capturedAt: 'not-a-time', evidenceId: 'ev-1' },
    { label: 'empty timestamp', runId: 'parent-run', capturedAt: '', evidenceId: 'ev-1' },
    { label: 'invalid calendar date', runId: 'parent-run', capturedAt: '2026-02-30T00:00:00.000Z', evidenceId: 'ev-1' },
    { label: 'empty evidence ID', runId: 'parent-run', capturedAt: now, evidenceId: '' },
    { label: 'empty Run ID', runId: '', capturedAt: now, evidenceId: 'ev-1' },
  ])('rejects a parent evidence cursor before child reencoding: $label', async ({ runId, capturedAt, evidenceId }) => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-inspection-invalid-cursor-'));
    roots.push(root);
    const persistence = createSqlitePersistence({ path: join(root, 'runtime.sqlite'), clock });
    try {
      const cursor = Buffer.from(JSON.stringify({ runId, capturedAt, evidenceId }), 'utf8').toString('base64url');
      const factory = new EventFactoryV2(clock, ids());
      await persistence.eventMessages.append('parent-run', 0, [factory.create('SUBAGENT_STARTED', {
        runId: 'parent-run', correlationId: 'corr-parent', visibility: 'public', durability: 'durable',
      }, {
        subagentType: 'metrics', childRunId: 'child-run', parentRunId: 'parent-run',
        budget: { type: 'tool_calls', limit: 4, used: 0 },
      })]);

      await expect(persistence.queries.listEvidence(runId, { limit: 1, cursor })).rejects.toThrow('evidence cursor is invalid');
    } finally {
      persistence.close();
    }
  });

  it.each([
    now, '2026-09-30T18:00:00+08:00', '2026-09-30T10:00:00.000123Z',
  ])('preserves valid existing parent evidence cursors with timestamp %s', async (capturedAt) => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-inspection-valid-cursor-'));
    roots.push(root);
    const persistence = createSqlitePersistence({ path: join(root, 'runtime.sqlite'), clock });
    try {
      const factory = new EventFactoryV2(clock, ids());
      await persistence.eventMessages.append('parent-run', 0, [factory.create('SUBAGENT_STARTED', {
        runId: 'parent-run', correlationId: 'corr-parent', visibility: 'public', durability: 'durable',
      }, {
        subagentType: 'metrics', childRunId: 'child-run', parentRunId: 'parent-run',
        budget: { type: 'tool_calls', limit: 4, used: 0 },
      })]);
      for (const evidenceId of ['ev-1', 'ev-2']) {
        await persistence.evidence.save({ ...evidence(), runId: 'child-run', evidenceId, capturedAt });
      }
      const cursor = Buffer.from(JSON.stringify({ runId: 'parent-run', capturedAt, evidenceId: 'ev-1' }), 'utf8').toString('base64url');

      const page = await persistence.queries.listEvidence('parent-run', { limit: 1, cursor });

      expect(page.items.map((item) => ({ evidenceId: item.evidenceId, capturedAt: item.capturedAt }))).toEqual([{ evidenceId: 'ev-2', capturedAt }]);
      expect(page.nextCursor).toBeUndefined();
    } finally {
      persistence.close();
    }
  });

  it('lists child evidence through the parent Run and paginates the whole Run tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-inspection-tree-evidence-'));
    roots.push(root);
    const persistence = createSqlitePersistence({ path: join(root, 'runtime.sqlite'), clock });
    try {
      await persistence.checkpoints.save(context('parent-run', 'profile-a'), null);
      await persistence.checkpoints.save(context('child-run', 'profile-a'), null);
      const factory = new EventFactoryV2(clock, ids());
      const relation = factory.create('SUBAGENT_STARTED', {
        runId: 'parent-run', correlationId: 'corr-parent', visibility: 'public', durability: 'durable',
      }, {
        subagentType: 'metrics', childRunId: 'child-run', parentRunId: 'parent-run',
        budget: { type: 'tool_calls', limit: 4, used: 0 },
      });
      await persistence.eventMessages.append('parent-run', 0, [relation]);
      await persistence.evidence.save({
        evidenceId: 'child-evidence-1', runId: 'child-run', source: 'metric',
        summary: { failureRate: 0.15, start: 1791421875, end: 1791422175 },
        raw: { private: 'never-public' }, businessTraceIds: [],
        capturedAt: '2026-09-30T10:00:01.000Z',
      });
      await persistence.evidence.save({
        evidenceId: 'child-evidence-2', runId: 'child-run', source: 'metric',
        summary: { failureRate: 0.2, start: 1791421875, end: 1791422175 },
        raw: { private: 'never-public' }, businessTraceIds: [],
        capturedAt: '2026-09-30T10:00:02.000Z',
      });

      const first = await persistence.queries.listEvidence('parent-run', { limit: 1 });
      if (first.nextCursor === undefined) throw new Error('parent evidence page should have a cursor');
      const second = await persistence.queries.listEvidence('parent-run', { limit: 1, cursor: first.nextCursor });

      expect(first.items.map((item) => item.evidenceId)).toEqual(['child-evidence-1']);
      expect(second.items.map((item) => item.evidenceId)).toEqual(['child-evidence-2']);
      expect(first.items[0]?.runId).toBe('child-run');
      for (const item of [...first.items, ...second.items]) {
        expect(item.timeRange).toEqual({
          start: '2026-10-08T01:11:15.000Z', end: '2026-10-08T01:16:15.000Z',
        });
      }
      expect(await persistence.queries.getEvidence('parent-run', 'child-evidence-1')).toMatchObject({
        evidenceId: 'child-evidence-1', runId: 'child-run', retrievable: false,
        timeRange: { start: '2026-10-08T01:11:15.000Z', end: '2026-10-08T01:16:15.000Z' },
      });
      expect(JSON.stringify([first, second])).not.toContain('never-public');
    } finally {
      persistence.close();
    }
  });

  it('includes safe structured source missing-evidence codes in the parent Run detail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-inspection-missing-evidence-'));
    roots.push(root);
    const persistence = createSqlitePersistence({ path: join(root, 'runtime.sqlite'), clock });
    try {
      const parent = context('parent-run', 'profile-a');
      parent.messages.push({
        id: 'logs-subagent-result',
        role: 'tool',
        createdAt: now,
        blocks: [{
          type: 'tool_result',
          result: {
            toolCallId: 'logs-call', toolName: 'logs_subagent', status: 'failed', startedAt: now,
            response: { blocks: [{ type: 'json', value: {
              source: 'logs', status: 'unavailable', missingEvidence: [
                'logs_capture_unavailable', 'traces', 'raw log text from 10.0.0.5:9200',
                'elasticsearch:9200', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
              ],
            } }] },
          },
        }],
      });
      await persistence.checkpoints.save(parent, null);

      const detail = await persistence.queries.getRun('parent-run');

      expect(detail?.missingEvidence).toEqual(['logs', 'logs_capture_unavailable', 'traces']);
    } finally {
      persistence.close();
    }
  });

  it('reconstructs token usage from durable audit events after reopening the database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-inspection-usage-'));
    roots.push(root);
    const path = join(root, 'runtime.sqlite');
    const first = createSqlitePersistence({ path, clock });
    await first.checkpoints.save(context('usage-run', 'profile-a'), null);
    const factory = new EventFactoryV2(clock, ids());
    await first.eventMessages.append('usage-run', 0, [
      factory.create('MODEL_CALL_STARTED', {
        runId: 'usage-run', correlationId: 'run:usage-run', visibility: 'audit', durability: 'durable',
      }, { provider: 'test', model: 'test-model', purpose: 'inspection', attempt: 1, inputSummary: 'internal' }),
      factory.create('MODEL_CALL_COMPLETED', {
        runId: 'usage-run', correlationId: 'run:usage-run', visibility: 'audit', durability: 'durable',
      }, { provider: 'test', model: 'test-model', attempt: 1, durationMs: 10, usage: { inputTokens: 81, outputTokens: 19 } }),
    ]);
    first.close();

    const reopened = createSqlitePersistence({ path, clock });
    try {
      expect((await reopened.queries.getRun('usage-run'))?.usage).toEqual({
        completeness: 'complete', inputTokens: 81, outputTokens: 19,
      });
    } finally {
      reopened.close();
    }
  });

  it('accepts the public maximum page size when Run evidence includes manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-inspection-page-limit-'));
    roots.push(root);
    const persistence = createSqlitePersistence({ path: join(root, 'runtime.sqlite'), clock });
    try {
      await persistence.checkpoints.save(context('run-1', 'profile-a'), null);
      for (let index = 0; index < 100; index += 1) {
        const suffix = String(index).padStart(3, '0');
        await commitManifest(persistence, {
          evidenceId: `evidence-${suffix}`,
          manifestId: `manifest-${suffix}`,
          runId: 'run-1',
          capturedAt: now,
        });
      }

      const page = await persistence.queries.listEvidence('run-1', { limit: 100 });

      expect(page.items).toHaveLength(100);
      expect(page.nextCursor).toBeUndefined();
    } finally {
      persistence.close();
    }
  });

  it('finds a Subagent relationship after more than 250 lifecycle-unrelated events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-inspection-subagent-relation-'));
    roots.push(root);
    const persistence = createSqlitePersistence({ path: join(root, 'runtime.sqlite'), clock });
    try {
      await persistence.checkpoints.save(context('parent-run', 'profile-a'), null);
      await persistence.checkpoints.save(context('child-run', 'profile-a'), null);
      const factory = new EventFactoryV2(clock, ids());
      const filler = Array.from({ length: 250 }, () => factory.create('RUN_STARTED', {
        runId: 'child-run', correlationId: 'corr-child', visibility: 'public', durability: 'durable',
      }, {
        profile: 'profile-a', trigger: 'manual', deadline: now, versionSnapshot: {},
      }));
      const started = factory.create('SUBAGENT_STARTED', {
        runId: 'child-run', correlationId: 'corr-child', visibility: 'public', durability: 'durable',
      }, {
        subagentType: 'metrics', childRunId: 'child-run', parentRunId: 'parent-run',
        budget: { type: 'tool_calls', limit: 4, used: 0 },
      });
      await persistence.eventMessages.append('child-run', 0, [...filler, started]);

      const detail = await persistence.queries.getRun('parent-run');

      expect(detail?.childRunIds).toEqual(['child-run']);
      expect((await persistence.queries.getRun('child-run'))?.parentRunId).toBe('parent-run');
    } finally {
      persistence.close();
    }
  });

  it('paginates and reopens safe Run and Evidence views without selecting raw payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-inspection-query-'));
    roots.push(root);
    const path = join(root, 'runtime.sqlite');
    const first = createSqlitePersistence({ path, clock });
    await first.checkpoints.save(context('run-1', 'profile-a'), null);
    await first.checkpoints.save(context('run-2', 'profile-a'), null);
    await first.evidence.save(evidence());
    await first.evidenceManifests.createPending({
      manifestId: 'manifest-1', evidenceId: 'log-evidence-1', runId: 'run-1', stepId: 'step-1', toolCallId: 'tool-1',
      captureKey: 'capture-log-1', source: 'log', queryDigest: 'query-digest',
      timeRange: { start: now, end: now }, compression: 'gzip_ndjson', redactionPolicyVersion: 'v1', createdAt: now,
    });
    expect((await first.queries.listEvidence('run-1')).items.map((item) => item.evidenceId)).toEqual(['evidence-1']);
    await first.evidenceManifests.commit({
      evidenceId: 'log-evidence-1',
      descriptor: {
        manifestId: 'manifest-1', evidenceId: 'log-evidence-1', captureKey: 'capture-log-1', compression: 'gzip_ndjson',
        sourceBytes: 0, storedBytes: 0, rawSha256: 'a'.repeat(64), chunks: [],
      },
      summary: { recordCount: 0, sourceBytes: 0, levels: [], services: [], exceptionSignatures: [], traceIds: [], samples: [] },
      coverage: 1, truncated: false, missingEvidence: [], updatedAt: now, committedAt: now,
    });
    const page = await first.queries.listRuns({ profileId: 'profile-a', limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTypeOf('string');
    const evidencePage = await first.queries.listEvidence('run-1');
    expect(evidencePage.items.map((item) => item.evidenceId)).toEqual(['log-evidence-1', 'evidence-1']);
    expect(evidencePage.items[1]).toMatchObject({ evidenceId: 'evidence-1', traceIdCount: 1 });
    expect(JSON.stringify(evidencePage)).not.toContain('sqlite-raw-marker');
    first.close();

    const second = createSqlitePersistence({ path, clock });
    try {
      const detail = await second.queries.getRun('run-1');
      expect(detail).toMatchObject({ runId: 'run-1', status: 'completed', missingEvidence: ['logs'] });
      expect(await second.queries.getEvidence('other-run', 'evidence-1')).toBeNull();
      expect((await second.queries.getEvidence('run-1', 'evidence-1'))?.summary).toEqual({ failureRate: 0.15, endpoint: '[REDACTED]' });
    } finally {
      second.close();
    }
  });
});
