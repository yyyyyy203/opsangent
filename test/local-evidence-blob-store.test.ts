import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  BeginEvidenceBlobInput,
  CommitEvidenceManifestInput,
  CreateEvidenceManifestInput,
  EvidenceBlobDescriptor,
  EvidenceChunkRef,
} from '../src/contracts/index.js';
import { SqliteDatabase } from '../src/infrastructure/sqlite/database.js';
import { LocalEvidenceBlobStore } from '../src/infrastructure/blob/local-evidence-blob-store.js';
import { SqliteEvidenceManifestStore } from '../src/infrastructure/sqlite/blob-manifest-store.js';

const gunzipAsync = promisify(gunzip);
const roots: string[] = [];
const now = '2026-09-13T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function beginInput(chunkIndex = 0): BeginEvidenceBlobInput {
  return {
    manifestId: 'manifest-1',
    evidenceId: 'evidence-1',
    captureKey: 'capture-1',
    source: 'log',
    chunkIndex,
    chunkTargetBytes: 4 * 1024 * 1024,
  };
}

function pendingInput(): CreateEvidenceManifestInput {
  return {
    manifestId: 'manifest-1',
    evidenceId: 'evidence-1',
    runId: 'run-1',
    stepId: 'step-1',
    toolCallId: 'call-1',
    captureKey: 'capture-1',
    source: 'log',
    queryDigest: 'query-1',
    timeRange: {
      start: '2026-09-13T00:00:00.000Z',
      end: '2026-09-13T00:01:00.000Z',
    },
    compression: 'gzip_ndjson',
    redactionPolicyVersion: 'redaction/v1',
    createdAt: now,
  };
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function temporaryFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.endsWith('.tmp'));
}

describe('LocalEvidenceBlobStore', () => {
  it('publishes a gzip chunk atomically and reads the committed bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-l0-blob-'));
    roots.push(root);
    const blobStore = new LocalEvidenceBlobStore({ rootPath: root });
    const writer = await blobStore.begin(beginInput());
    await writer.write(new TextEncoder().encode('first\n'));
    await writer.write(new TextEncoder().encode('second\n'));

    const descriptor = await writer.commit();

    expect(descriptor.chunks).toHaveLength(1);
    expect(descriptor.chunks[0]?.storageKey).toContain('manifest-1');
    const compressed = await collect(blobStore.readChunk(descriptor.chunks[0]!));
    expect((await gunzipAsync(compressed)).toString('utf8')).toBe('first\nsecond\n');
    expect(await temporaryFiles(root)).toEqual([]);
  });

  it('removes an aborted temporary chunk and rejects writes after abort', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-l0-abort-'));
    roots.push(root);
    const blobStore = new LocalEvidenceBlobStore({ rootPath: root });
    const writer = await blobStore.begin(beginInput());
    await writer.write(new TextEncoder().encode('partial\n'));
    await writer.abort('CAPTURE_ABORTED');

    await expect(writer.write(new TextEncoder().encode('late\n'))).rejects.toThrow();
    expect(await temporaryFiles(root)).toEqual([]);
  });
});

describe('SqliteEvidenceManifestStore', () => {
  it('keeps pending and failed manifests invisible to readers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-l0-manifest-'));
    roots.push(root);
    const database = SqliteDatabase.open(join(root, 'state.sqlite'));
    try {
      const manifests = new SqliteEvidenceManifestStore(database);
      await manifests.createPending(pendingInput());
      expect(await manifests.getVisible('evidence-1')).toBeNull();

      await manifests.markFailed({
        evidenceId: 'evidence-1',
        reasonCode: 'SOURCE_FAILED',
        updatedAt: now,
      });
      expect(await manifests.getVisible('evidence-1')).toBeNull();
      expect((await manifests.get('evidence-1'))?.state).toBe('failed');
    } finally {
      database.close();
    }
  });

  it('exposes only a committed manifest summary and preserves capture identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-l0-commit-'));
    roots.push(root);
    const database = SqliteDatabase.open(join(root, 'state.sqlite'));
    try {
      const manifests = new SqliteEvidenceManifestStore(database);
      await manifests.createPending(pendingInput());
      const chunk: EvidenceChunkRef = {
        manifestId: 'manifest-1',
        evidenceId: 'evidence-1',
        chunkIndex: 0,
        storageKey: 'manifest-1/chunk-0.gz',
        recordCount: 1,
        sourceBytes: 42,
        storedBytes: 35,
        sha256: 'b'.repeat(64),
        committedAt: now,
      };
      await manifests.recordChunk({
        evidenceId: 'evidence-1',
        chunk,
        updatedAt: now,
      });
      const descriptor: EvidenceBlobDescriptor = {
        manifestId: 'manifest-1',
        evidenceId: 'evidence-1',
        captureKey: 'capture-1',
        compression: 'gzip_ndjson',
        sourceBytes: 42,
        storedBytes: 35,
        rawSha256: 'a'.repeat(64),
        chunks: [chunk],
      };
      const commit: CommitEvidenceManifestInput = {
        evidenceId: 'evidence-1',
        descriptor,
        summary: {
          recordCount: 1,
          sourceBytes: 42,
          levels: [{ value: 'ERROR', count: 1 }],
          services: [],
          exceptionSignatures: [],
          traceIds: [],
          samples: [],
        },
        coverage: 1,
        truncated: false,
        missingEvidence: [],
        updatedAt: now,
        committedAt: now,
      };

      const visible = await manifests.commit(commit);

      expect(visible.state).toBe('committed');
      expect(await manifests.getVisible('evidence-1')).toMatchObject({
        evidenceId: 'evidence-1',
          chunkCount: 1,
        sourceBytes: 42,
        storedBytes: 35,
      });
      expect(JSON.stringify(await manifests.getVisible('evidence-1'))).not.toContain('storageKey');
      await expect(manifests.createPending({ ...pendingInput(), manifestId: 'manifest-2', evidenceId: 'evidence-2', captureKey: 'capture-1' }))
        .rejects.toThrow();
    } finally {
      database.close();
    }
  });
});
