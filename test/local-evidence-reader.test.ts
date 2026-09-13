import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock, EvidenceSourcePage, NormalizedLogRecord } from '../src/contracts/index.js';
import { DefaultStreamingEvidenceRecorder } from '../src/application/streaming-evidence-recorder.js';
import { LocalEvidenceBlobStore } from '../src/infrastructure/blob/local-evidence-blob-store.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { SqliteEvidenceManifestStore } from '../src/infrastructure/sqlite/blob-manifest-store.js';
import { LocalEvidenceReader } from '../src/infrastructure/elk/local-evidence-reader.js';
import { canonicalJson } from '../src/contracts/stable-json.js';

const roots: string[] = [];
const clock: Clock = { now: () => new Date('2026-09-13T00:00:00.000Z') };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(message: string, second: number): NormalizedLogRecord {
  return {
    timestamp: new Date(Date.UTC(2026, 8, 13, 0, 0, second)).toISOString(),
    service: 'checkout',
    level: 'ERROR',
    exception: message === 'first' ? 'SettlementException' : 'TimeoutException',
    message,
    traceId: `trace-${second}`,
  };
}

function page(records: readonly NormalizedLogRecord[]): EvidenceSourcePage {
  return {
    records,
    encodedBytes: records.reduce((total, item) => total + Buffer.byteLength(canonicalJson(item) + '\n', 'utf8'), 0),
  };
}

describe('LocalEvidenceReader', () => {
  it('reads committed gzip NDJSON through opaque cursors and aggregates deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-evidence-reader-'));
    roots.push(root);
    const database = SqliteDatabase.open(join(root, 'state.sqlite'));
    const manifests = new SqliteEvidenceManifestStore(database);
    const blobStore = new LocalEvidenceBlobStore({ rootPath: join(root, 'blobs'), clock });
    const recorder = new DefaultStreamingEvidenceRecorder({ blobStore, manifests, clock });
    try {
      await recorder.capture({
        evidenceId: 'evidence-log-1',
        runId: 'run-1',
        stepId: 'step-1',
        toolCallId: 'call-1',
        captureKey: 'capture-log-1',
        source: 'log',
        queryDigest: 'digest',
        timeRange: { start: '2026-09-13T00:00:00.000Z', end: '2026-09-13T01:00:00.000Z' },
        pages: (async function* () {
          await Promise.resolve();
          yield page([record('first', 1), record('second', 2)]);
        })(),
        budget: {
          maxSourceBytes: 64 * 1024 * 1024,
          maxRecords: 50_000,
          maxDurationMs: 60_000,
          maxModelSummaryBytes: 16 * 1024,
          maxSamples: 20,
        },
      });

      const reader = new LocalEvidenceReader({ blobStore, manifests });
      const signal = new AbortController().signal;
      const first = await reader.search({ evidenceId: 'evidence-log-1', runId: 'run-1', limit: 1, signal });
      expect(first.records).toHaveLength(1);
      expect(first.records[0]?.message).toBe('first');
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_.-]+$/);

      const second = await reader.readSlice({
        evidenceId: 'evidence-log-1', runId: 'run-1',
        ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
        limit: 1,
        signal,
      });
      expect(second.records[0]?.message).toBe('second');

      const aggregate = await reader.aggregate({ evidenceId: 'evidence-log-1', runId: 'run-1', topN: 10, signal });
      expect(aggregate.recordCount).toBe(2);
      expect(aggregate.levels).toEqual([{ value: 'ERROR', count: 2 }]);
      expect(aggregate.exceptionSignatures).toEqual([
        { value: 'SettlementException', count: 1 },
        { value: 'TimeoutException', count: 1 },
      ]);
      expect(aggregate.traceIds).toEqual(['trace-1', 'trace-2']);

      const forged = `${first.nextCursor}.forged`;
      await expect(reader.readSlice({
        evidenceId: 'evidence-log-1', runId: 'run-1', cursor: forged, limit: 1, signal,
      })).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    } finally {
      database.close();
    }
  });

  it('rejects pending, failed or cross-run manifests before reading Blob data', async () => {
    const manifests = {
      get: () => Promise.resolve({ state: 'pending' as const }),
    } as never;
    const reader = new LocalEvidenceReader({ blobStore: {} as never, manifests });
    const input = { evidenceId: 'evidence-log-1', runId: 'run-1', limit: 1, signal: new AbortController().signal };

    await expect(reader.search(input)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});
