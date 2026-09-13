import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock, IdGenerator, NormalizedLogRecord, EvidenceSourcePage } from '../src/contracts/index.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteEvidenceManifestStore } from '../src/infrastructure/sqlite/blob-manifest-store.js';
import { LocalEvidenceBlobStore } from '../src/infrastructure/blob/local-evidence-blob-store.js';
import { DefaultStreamingEvidenceRecorder } from '../src/application/streaming-evidence-recorder.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { EventPublisherV2, InMemoryProjectionFailureSink } from '../src/event/v2/event-publisher.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import { ReplayBufferV2 } from '../src/event/v2/replay-buffer.js';
import { generatedLogPages } from './fixtures/generated-log-pages.js';

const roots: string[] = [];
const now = new Date('2026-09-13T00:00:00.000Z');
const clock: Clock = { now: () => new Date(now) };
let sequence = 0;
const ids: IdGenerator = { next: (prefix) => prefix + '-' + ++sequence };

afterEach(async () => {
  sequence = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function budget(overrides: Partial<{
  maxSourceBytes: number;
  maxRecords: number;
  maxDurationMs: number;
  maxModelSummaryBytes: number;
  maxSamples: number;
}> = {}) {
  return {
    maxSourceBytes: 64 * 1024 * 1024,
    maxRecords: 50_000,
    maxDurationMs: 60_000,
    maxModelSummaryBytes: 16 * 1024,
    maxSamples: 20,
    ...overrides,
  };
}

function record(message: string, sequenceNumber: number): NormalizedLogRecord {
  return {
    timestamp: new Date(Date.UTC(2026, 8, 13, 0, 0, sequenceNumber)).toISOString(),
    service: 'checkout',
    level: 'ERROR',
    exception: 'SettlementException',
    message,
  };
}

function request(pages: AsyncIterable<EvidenceSourcePage> = generatedLogPages({ totalBytes: 1_024 })) {
  return {
    evidenceId: 'evidence-log-1',
    runId: 'run-1',
    stepId: 'step-1',
    toolCallId: 'call-1',
    captureKey: 'capture-log-1',
    source: 'log' as const,
    queryDigest: 'query-digest-1',
    timeRange: {
      start: '2026-09-13T00:00:00.000Z',
      end: '2026-09-13T01:00:00.000Z',
    },
    pages,
    budget: budget(),
  };
}

async function createRecorder(withEvents = false) {
  const root = await mkdtemp(join(tmpdir(), 'agentops-l0-recorder-'));
  roots.push(root);
  const database = SqliteDatabase.open(join(root, 'state.sqlite'));
  const blobRoot = join(root, 'blobs');
  const manifests = new SqliteEvidenceManifestStore(database);
  const blobStore = new LocalEvidenceBlobStore({ rootPath: blobRoot, clock, ids });
  const eventStore = withEvents ? new InMemoryEventMessageStore() : undefined;
  const publisher = withEvents
    ? new EventPublisherV2(eventStore!, new ReplayBufferV2({ maxEvents: 10, maxBytes: 10_000 }), new InMemoryProjectionFailureSink())
    : undefined;
  const recorder = new DefaultStreamingEvidenceRecorder({
    blobStore,
    manifests,
    clock,
    ids,
    ...(publisher === undefined || eventStore === undefined ? {} : {
      events: {
        factory: new EventFactoryV2(clock, ids),
        publisher,
        store: eventStore,
        correlationId: (runId: string) => `run:${runId}`,
      },
    }),
    redactor: (input) => ({
      ...input,
      ...(input.message === undefined ? {} : { message: input.message.replaceAll('raw-log-marker', '[REDACTED]') }),
    }),
  });
  return { recorder, manifests, database, eventStore, publisher };
}

describe('DefaultStreamingEvidenceRecorder', () => {
  it('captures 64 MiB of generated records with bounded redacted summary', async () => {
    const { recorder, manifests, database } = await createRecorder();
    try {
      const result = await recorder.capture({
        ...request(generatedLogPages({ totalBytes: 64 * 1024 * 1024 })),
        budget: budget({ maxDurationMs: 10 * 60_000 }),
      });

      expect(result.manifest.state).toBe('committed');
      expect(result.manifest.recordCount).toBe(32_768);
      expect(result.manifest.sourceBytes).toBeLessThan(64 * 1024 * 1024);
      expect(result.manifest.sourceBytes).toBeGreaterThan(60 * 1024 * 1024);
      expect(result.manifest.chunkCount).toBeGreaterThan(1);
      expect(Buffer.byteLength(JSON.stringify(result.summary), 'utf8')).toBeLessThanOrEqual(16 * 1024);
      expect(JSON.stringify(result.summary)).not.toContain('raw-log-marker');
      expect((await manifests.getVisible('evidence-log-1'))?.state).toBe('committed');
    } finally {
      database.close();
    }
  }, 30_000);

  it('commits partial evidence when the byte budget is reached', async () => {
    const { recorder, manifests, database } = await createRecorder();
    try {
      const pages = (async function* (): AsyncIterable<EvidenceSourcePage> {
        await Promise.resolve();
        yield { records: [record('first', 1), record('second', 2)], encodedBytes: 200, nextCursor: 'cursor-2' };
        yield { records: [record('third', 3)], encodedBytes: 100, nextCursor: 'cursor-3' };
      })();
      const result = await recorder.capture({
        ...request(pages),
        budget: budget({ maxSourceBytes: 150 }),
      });

      expect(result.truncated).toBe(true);
      expect(result.manifest.state).toBe('partial');
      expect(result.missingEvidence).toContain('ELK_CAPTURE_BYTE_BUDGET_EXCEEDED');
      expect(result.manifest.coverage).toBeGreaterThanOrEqual(0);
      expect(await manifests.getVisible('evidence-log-1')).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it('stops without exposing evidence when the caller aborts', async () => {
    const { recorder, manifests, database } = await createRecorder();
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(recorder.capture(request(), { signal: controller.signal })).rejects.toMatchObject({
        code: 'ABORTED',
      });
      expect(await manifests.getVisible('evidence-log-1')).toBeNull();
    } finally {
      database.close();
    }
  });

  it('publishes one safe evidence event only after the manifest is visible', async () => {
    const { recorder, manifests, database, eventStore, publisher } = await createRecorder(true);
    if (eventStore === undefined || publisher === undefined) throw new Error('event test setup failed');
    const observedVisible: boolean[] = [];
    publisher.subscribe({
      name: 'streaming-evidence-order',
      project: async (event) => {
        if (event.type === 'EVIDENCE_COLLECTED') observedVisible.push(await manifests.getVisible('evidence-log-1') !== null);
      },
    });
    try {
      await recorder.capture(request(generatedLogPages({ totalBytes: 64 * 1024 })));
      await recorder.capture(request(generatedLogPages({ totalBytes: 64 * 1024 })));
      const events = await eventStore.readRun('run-1', 0, 10);
      expect(observedVisible).toEqual([true]);
      expect(events.filter((event) => event.type === 'EVIDENCE_COLLECTED')).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('raw-log-marker');
    } finally {
      database.close();
    }
  });
});
