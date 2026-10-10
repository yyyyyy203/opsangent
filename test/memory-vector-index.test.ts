import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryVectorEntry } from '../src/contracts/memory-vector.js';
import type { MemorySelection } from '../src/contracts/diagnostic-memory.js';
import { MemoryVectorDatabase } from '../src/infrastructure/sqlite/memory-vector-database.js';
import { SqliteVectorIndex } from '../src/infrastructure/sqlite/memory-vector-index.js';
import { VectorExperimentError } from '../src/memory/vector/vector-error.js';
import { memoryCase, memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';
import { embeddingSpace } from './fixtures/memory-vector.js';

const roots: string[] = [];
const databases: MemoryVectorDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function entry(overrides: Partial<MemoryVectorEntry> = {}): MemoryVectorEntry {
  return { memoryId: 'memory-1', revision: 1, digest: memoryCase().digest, scope: simulationMemoryScope(),
    kind: 'episodic', space: embeddingSpace(), vector: new Float32Array([1, 0, 0]), ...overrides };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'agentops-vector-index-')); roots.push(root);
  const path = join(root, 'index.sqlite'); const database = MemoryVectorDatabase.open(path); databases.push(database);
  let now = Date.parse(memoryNow);
  const clock = { now: () => new Date(now) };
  const index = new SqliteVectorIndex({ database, clock });
  const operation = { now: memoryNow, deadlineMs: now + 60_000 };
  const query = (eligible = [entry()]) => ({ scope: simulationMemoryScope(), space: embeddingSpace(),
    vector: new Float32Array([1, 0, 0]), eligible: eligible.map(({ memoryId, revision, digest }) => ({ memoryId, revision, digest })), limit: 5 });
  return { index, database, path, clock, operation, query, advance: () => { now += 60_001; } };
}
describe('bounded scoped vector index', () => {
  it('filters exact scope, space, kind and eligible version before Top-K', async () => {
    const { index, operation, query } = await setup();
    await index.upsert([entry({ vector: new Float32Array([1, 1, 0]) }),
      entry({ memoryId: 'wrong-scope', scope: { ...simulationMemoryScope(), dataClass: 'simulated', environment: 'simulation', datasetId: 'other' } }),
      entry({ memoryId: 'wrong-space', space: { ...embeddingSpace(), revision: 'v2' } }),
      entry({ memoryId: 'unselected' })], operation);
    expect((await index.search(query(), operation)).map((hit) => hit.memoryId)).toEqual(['memory-1']);
    expect(await index.search(query([entry({ revision: 2 })]), operation)).toEqual([]);
    expect(await index.search(query([entry({ digest: 'd'.repeat(64) })]), operation)).toEqual([]);
  });
  it('uses explicit little-endian Float32 bytes and restarts without loss', async () => {
    const { index, database, path, clock, operation, query } = await setup();
    await index.upsert([entry()], operation);
    const row = database.raw.prepare('SELECT vector_blob FROM memory_vector_rows').get() as { vector_blob: Buffer };
    expect(row.vector_blob.toString('hex')).toBe('0000803f0000000000000000');
    await index.close(); database.close();
    const reopened = MemoryVectorDatabase.open(path); databases.push(reopened);
    const next = new SqliteVectorIndex({ database: reopened, clock });
    expect((await next.search(query(), operation))[0]).toMatchObject({ memoryId: 'memory-1', score: 1 });
  });
  it('allows idempotent upsert but rejects stale/conflicting revisions atomically', async () => {
    const { index, database, operation } = await setup();
    await index.upsert([entry({ revision: 2 })], operation);
    await index.upsert([entry({ revision: 2 })], operation);
    await expect(index.upsert([entry({ memoryId: 'new' }), entry()], operation)).rejects.toMatchObject({ code: 'VECTOR_INPUT_INVALID' });
    expect((database.raw.prepare('SELECT COUNT(*) n FROM memory_vector_rows').get() as { n: number }).n).toBe(1);
    await expect(index.upsert([entry({ revision: 2, digest: 'd'.repeat(64) })], operation)).rejects.toMatchObject({ code: 'VECTOR_INPUT_INVALID' });
    await expect(index.upsert([entry({ revision: 2, vector: new Float32Array([0, 1, 0]) })], operation)).rejects.toMatchObject({ code: 'VECTOR_INPUT_INVALID' });
  });
  it('checks all rows before a batch, including dimension and duplicate identity errors', async () => {
    const { index, operation, query } = await setup();
    await expect(index.upsert([entry(), entry({ memoryId: 'bad', vector: new Float32Array(3) })], operation)).rejects.toMatchObject({ code: 'VECTOR_INPUT_INVALID' });
    await expect(index.upsert([entry(), entry()], operation)).rejects.toMatchObject({ code: 'VECTOR_INPUT_INVALID' });
    expect(await index.search(query(), operation)).toEqual([]);
  });
  it('rejects sparse batches and eligible sets with an input error rather than incomplete success', async () => {
    const { index, operation, query } = await setup();
    await expect(index.upsert(new Array<MemoryVectorEntry>(1), operation)).rejects.toMatchObject({ code: 'VECTOR_INPUT_INVALID' });
    await expect(index.search({ ...query(), eligible: new Array<MemorySelection>(1) }, operation)).rejects.toMatchObject({ code: 'VECTOR_INPUT_INVALID' });
    await expect(index.remove({ scope: simulationMemoryScope(), space: embeddingSpace(), memoryIds: new Array<string>(1) }, operation)).rejects.toMatchObject({ code: 'VECTOR_INPUT_INVALID' });
  });
  it('rejects hash/length corruption in search and on reopen, without leaking raw database errors', async () => {
    const { index, database, path, operation, query } = await setup();
    await index.upsert([entry()], operation);
    database.raw.prepare("UPDATE memory_vector_rows SET vector_blob = x'00000000'").run();
    await expect(index.search(query(), operation)).rejects.toMatchObject({ code: 'VECTOR_INDEX_UNAVAILABLE' });
    database.close();
    expect(() => MemoryVectorDatabase.open(path)).toThrowError(new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE'));
  });
  it('retains deterministic tie order and removes only the selected scope/space', async () => {
    const { index, operation, query } = await setup();
    const same = [entry({ memoryId: 'z' }), entry({ memoryId: 'a' })];
    const otherScope = { ...simulationMemoryScope(), dataClass: 'simulated', environment: 'simulation', datasetId: 'other' } as const;
    await index.upsert([...same, entry({ memoryId: 'a', scope: otherScope })], operation);
    expect((await index.search(query(same), operation)).map((hit) => hit.memoryId)).toEqual(['a', 'z']);
    await index.remove({ scope: simulationMemoryScope(), space: embeddingSpace(), memoryIds: ['a'] }, operation);
    expect((await index.search(query(same), operation)).map((hit) => hit.memoryId)).toEqual(['z']);
    expect((await index.search({ ...query([entry({ memoryId: 'a' })]), scope: otherScope }, operation)).map((hit) => hit.memoryId)).toEqual(['a']);
  });
  it('enforces the thousand-row cap without silently evicting old rows', async () => {
    const { index, database, operation } = await setup();
    for (let start = 0; start < 1000; start += 16) {
      await index.upsert(Array.from({ length: Math.min(16, 1000 - start) }, (_, i) => entry({ memoryId: `m-${start + i}` })), operation);
    }
    await expect(index.upsert([entry()], operation)).rejects.toMatchObject({ code: 'VECTOR_CAPACITY_EXCEEDED' });
    expect((database.raw.prepare('SELECT COUNT(*) n FROM memory_vector_rows').get() as { n: number }).n).toBe(1000);
  });
  it('rolls back a late SQL failure including space metadata and earlier rows', async () => {
    const { index, database, operation, query } = await setup();
    database.raw.exec(`CREATE TRIGGER fail_vector_insert BEFORE INSERT ON memory_vector_rows
      WHEN NEW.memory_id = 'bad' BEGIN SELECT RAISE(ABORT, 'private_sql_error'); END;`);
    await expect(index.upsert([entry(), entry({ memoryId: 'bad' })], operation)).rejects.toMatchObject({ code: 'VECTOR_INDEX_UNAVAILABLE' });
    expect(await index.search(query(), operation)).toEqual([]);
    expect((database.raw.prepare('SELECT COUNT(*) n FROM vector_experiment_meta').get() as { n: number }).n).toBe(0);
  });
  it('checks the deadline within a long candidate loop instead of returning partial Top-K', async () => {
    const { index, database, operation, query } = await setup();
    const entries = Array.from({ length: 128 }, (_, i) => entry({ memoryId: `m-${i}` }));
    for (let offset = 0; offset < entries.length; offset += 16) await index.upsert(entries.slice(offset, offset + 16), operation);
    let reads = 0;
    const expiring = new SqliteVectorIndex({ database, clock: { now: () => new Date(++reads >= 3 ? operation.deadlineMs : Date.parse(memoryNow)) } });
    await expect(expiring.search(query(entries), operation)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(reads).toBe(3);
  });
  it('propagates Abort, rejects an expired deadline, and rejects calls after close', async () => {
    const { index, operation, query, advance } = await setup(); const controller = new AbortController(); controller.abort();
    await expect(index.upsert([entry()], { ...operation, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    advance(); await expect(index.search(query(), operation)).rejects.toMatchObject({ name: 'TimeoutError' });
    await index.close();
    await expect(index.search(query(), { ...operation, deadlineMs: operation.deadlineMs + 60_000 })).rejects.toMatchObject({ code: 'VECTOR_INDEX_UNAVAILABLE' });
  });
  it('rejects a future schema and does not silently reinterpret it', async () => {
    const { database, path } = await setup(); database.raw.pragma('user_version = 2'); database.close();
    expect(() => MemoryVectorDatabase.open(path)).toThrowError(new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE'));
  });
  it('verifies the derived corpus digest on reopen', async () => {
    const { index, database, path, operation } = await setup();
    await index.upsert([entry()], operation);
    database.raw.prepare('UPDATE vector_experiment_meta SET corpus_digest = ?').run('d'.repeat(64));
    database.close();
    expect(() => {
      const opened = MemoryVectorDatabase.open(path); databases.push(opened);
    }).toThrowError(new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE'));
  });
});
