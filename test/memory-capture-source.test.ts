import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { InspectionQueryService, PublicEvidenceView } from '../src/contracts/read-model.js';
import { StoredDataCorruptionError } from '../src/contracts/event-store.js';
import { MemoryError } from '../src/memory/memory-error.js';
import { createSqlitePersistence, SqliteDatabase, SqliteMemoryCaptureSource } from '../src/infrastructure/sqlite/index.js';
import { captureContext, captureRequest } from './fixtures/diagnostic-memory-capture.js';
import { memoryNow } from './fixtures/diagnostic-memory.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'agentops-memory-source-'));
  roots.push(root);
  const path = join(root, 'agent.sqlite');
  const persistence = createSqlitePersistence({ path });
  const context = captureContext();
  const saved = await persistence.checkpoints.save(context, null);
  await persistence.evidence.save({
    evidenceId: context.evidenceIds[0]!, runId: context.runId, source: 'metric',
    summary: { start: 1_791_590_400, end: 1_791_590_460 },
    raw: { marker: 'private-raw-evidence' }, businessTraceIds: [], capturedAt: memoryNow,
  });
  const operation = { now: new Date().toISOString(), deadlineMs: Date.now() + 30_000 };
  const request = { ...captureRequest(saved.context), sourceCheckpointChecksum: saved.checksum };
  const captureDatabase = SqliteDatabase.openReadOnly(path);
  const source = new SqliteMemoryCaptureSource({ database: captureDatabase, queries: persistence.queries });
  return { persistence, captureDatabase, path, context: saved.context, saved, operation, request, source };
}

it('loads bounded evidence references through metadata-only queries without reading raw_json', async () => {
  const harness = await setup();
  try {
    const database = SqliteDatabase.open(harness.path);
    database.raw.prepare('UPDATE evidence_records SET raw_json = ? WHERE evidence_id = ?')
      .run('{invalid raw payload that must never be parsed}', harness.context.evidenceIds[0]);
    database.close();

    const loaded = await harness.source.load(harness.request, harness.operation);
    expect(loaded.context.runId).toBe(harness.context.runId);
    expect(loaded.requiredEvidenceComplete).toBe(true);
    expect(loaded.evidenceRefs).toMatchObject([{ evidenceId: 'capture-evidence', ownerRunId: 'capture-run', source: 'metric' }]);
    expect(JSON.stringify(loaded)).not.toContain('private-raw-evidence');
  } finally {
    harness.captureDatabase.close();
    harness.persistence.close();
  }
});

it('checks checkpoint byte size before decoding and reports corrupt checksums safely', async () => {
  const oversized = await setup();
  try {
    const database = SqliteDatabase.open(oversized.path);
    database.raw.prepare('UPDATE agent_checkpoints SET checkpoint_json = ? WHERE run_id = ?')
      .run('x'.repeat(1_048_577), oversized.context.runId);
    database.close();
    await expect(oversized.source.inspect(oversized.context.runId, oversized.operation))
      .rejects.toMatchObject({ code: 'MEMORY_CAPTURE_FAILED' });
  } finally {
    oversized.captureDatabase.close();
    oversized.persistence.close();
  }

  const corrupt = await setup();
  try {
    const database = SqliteDatabase.open(corrupt.path);
    database.raw.prepare('UPDATE agent_checkpoints SET checksum = ? WHERE run_id = ?')
      .run('0'.repeat(64), corrupt.context.runId);
    database.close();
    await expect(corrupt.source.inspect(corrupt.context.runId, corrupt.operation))
      .rejects.toBeInstanceOf(StoredDataCorruptionError);
  } finally {
    corrupt.captureDatabase.close();
    corrupt.persistence.close();
  }
});

it('marks invalid evidence ownership, hashes, and time windows incomplete without exposing payloads', async () => {
  const harness = await setup();
  try {
    const base = harness.persistence.queries;
    const cases: { view: PublicEvidenceView; expectedLimitation: string; expectedRefs: number }[] = [
      { view: { evidenceId: 'capture-evidence', runId: 'foreign-run', source: 'metric', state: 'available',
        capturedAt: memoryNow, summary: { start: 1, end: 2 }, rawSha256: 'a'.repeat(64), traceIdCount: 0, retrievable: false },
        expectedLimitation: 'EVIDENCE_OWNER_INVALID', expectedRefs: 0 },
      { view: { evidenceId: 'capture-evidence', runId: 'child-run', source: 'metric', state: 'available',
        capturedAt: memoryNow, summary: { start: 1, end: 2 }, rawSha256: 'not-a-hash', traceIdCount: 0, retrievable: false },
        expectedLimitation: 'EVIDENCE_HASH_INVALID', expectedRefs: 0 },
      { view: { evidenceId: 'capture-evidence', runId: 'child-run', source: 'metric', state: 'available',
        capturedAt: memoryNow, summary: { start: '2026-10-10T01:00:00.000Z', end: '2026-10-10T00:00:00.000Z' },
        rawSha256: 'a'.repeat(64), traceIdCount: 0, retrievable: false },
        expectedLimitation: 'EVIDENCE_WINDOW_UNVERIFIABLE', expectedRefs: 1 },
    ];
    for (const item of cases) {
      const queries: InspectionQueryService = {
        listRuns: (options) => base.listRuns(options),
        getRun: async (runId) => {
          const run = await base.getRun(runId);
          return run === null ? null : { ...run, childRunIds: ['child-run'] };
        },
        listEvidence: async () => ({ items: [item.view] }),
        getEvidence: (runId, evidenceId) => base.getEvidence(runId, evidenceId),
      };
      const source = new SqliteMemoryCaptureSource({ database: harness.captureDatabase, queries });
      const loaded = await source.load(harness.request, harness.operation);
      expect(loaded.requiredEvidenceComplete).toBe(false);
      expect(loaded.evidenceRefs).toHaveLength(item.expectedRefs);
      expect(loaded.limitations).toContain(item.expectedLimitation);
    }
  } finally {
    harness.captureDatabase.close();
    harness.persistence.close();
  }
});

it('rejects a missing source checkpoint instead of synthesizing a capture snapshot', async () => {
  const harness = await setup();
  try {
    await expect(harness.source.inspect('missing-run', harness.operation)).resolves.toBeNull();
    const stale = { ...harness.request, sourceCheckpointChecksum: 'f'.repeat(64) };
    await expect(harness.source.load(stale, harness.operation)).rejects.toBeInstanceOf(MemoryError);
  } finally {
    harness.captureDatabase.close();
    harness.persistence.close();
  }
});
