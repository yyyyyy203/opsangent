import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileEmbeddingProvider } from '../src/infrastructure/memory/file-embedding-provider.js';
import { embeddingPack, embeddingSpace } from './fixtures/memory-vector.js';
import { memoryNow } from './fixtures/diagnostic-memory.js';

const roots: string[] = [];
afterEach(async () => { nowMs = Date.parse(memoryNow); vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(contents: unknown = embeddingPack()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentops-vector-pack-')); roots.push(root);
  const path = join(root, 'pack.json'); await writeFile(path, JSON.stringify(contents)); return path;
}
let nowMs = Date.parse(memoryNow);
const clock = { now: () => new Date(nowMs) };
const operation = () => ({ now: memoryNow, deadlineMs: nowMs + 1000 });
async function provider(path = ''): Promise<FileEmbeddingProvider> {
  return FileEmbeddingProvider.load({ path: path || await fixture(), expectedSpace: embeddingSpace(),
    corpusDigest: 'a'.repeat(64), querySetDigest: 'b'.repeat(64), clock });
}
describe('local file embedding provider', () => {
  it('looks up exact normalized text and returns independent normalized copies without HTTP', async () => {
    const fetch = vi.fn(() => { throw new Error('HTTP prohibited'); }); vi.stubGlobal('fetch', fetch);
    const loaded = await provider(); const [a] = await loaded.embed(['  结算失败\r\n '], operation());
    expect(a?.[0]).toBeCloseTo(0.6, 6); if (a) a[0] = 9;
    expect((await loaded.embed(['结算失败'], operation()))[0]?.[0]).toBeCloseTo(0.6, 6);
    expect(fetch).not.toHaveBeenCalled(); expect(loaded.space).toEqual(embeddingSpace());
  });
  it('fails explicitly for missing query vectors and never substitutes random embeddings', async () => {
    const random = vi.spyOn(Math, 'random'); const loaded = await provider();
    await expect(loaded.embed(['different query'], operation())).rejects.toMatchObject({ code: 'VECTOR_EMBEDDING_MISSING' });
    expect(random).not.toHaveBeenCalled(); random.mockRestore();
  });
  it('binds space, corpus and holdout query digests', async () => {
    for (const patch of [{ space: { ...embeddingSpace(), revision: 'v2' } },
      { corpusDigest: 'c'.repeat(64) }, { querySetDigest: 'd'.repeat(64) }]) {
      await expect(provider(await fixture({ ...embeddingPack(), ...patch }))).rejects.toMatchObject({ code: 'VECTOR_SPACE_MISMATCH' });
    }
  });
  it('rejects relative paths, malformed JSON and oversized files before parsing', async () => {
    await expect(provider('pack.json')).rejects.toMatchObject({ code: 'VECTOR_PACK_INVALID' });
    const path = await fixture(); await writeFile(path, '{broken');
    await expect(provider(path)).rejects.toMatchObject({ code: 'VECTOR_PACK_INVALID' });
    const handle = await open(path, 'w'); await handle.truncate(32 * 1024 * 1024 + 1); await handle.close();
    await expect(provider(path)).rejects.toMatchObject({ code: 'VECTOR_PACK_INVALID' });
  });
  it('enforces batch and byte limits', async () => {
    const loaded = await provider();
    await expect(loaded.embed(Array.from({ length: 17 }, () => '结算失败'), operation())).rejects.toMatchObject({ code: 'VECTOR_INPUT_INVALID' });
    await expect(loaded.embed(['汉'.repeat(683)], operation())).rejects.toMatchObject({ code: 'VECTOR_INPUT_INVALID' });
  });
  it('rejects wholly and partly sparse embedding batches', async () => {
    const loaded = await provider();
    const partial = new Array<string>(2); partial[0] = '结算失败';
    for (const texts of [new Array<string>(1), partial]) {
      await expect(loaded.embed(texts, operation())).rejects.toMatchObject({ code: 'VECTOR_INPUT_INVALID' });
    }
  });
  it('propagates Abort and checks the injected deadline', async () => {
    const loaded = await provider(); const controller = new AbortController(); controller.abort();
    await expect(loaded.embed(['结算失败'], { ...operation(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(loaded.embed(['结算失败'], { now: memoryNow, deadlineMs: nowMs })).rejects.toMatchObject({ name: 'TimeoutError' });
    nowMs += 10;
    await expect(loaded.embed(['结算失败'], { now: memoryNow, deadlineMs: nowMs - 1 })).rejects.toMatchObject({ name: 'TimeoutError' });
    nowMs = Date.parse(memoryNow);
  });
});
