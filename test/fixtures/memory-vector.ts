import { createHash } from 'node:crypto';
import type { EmbeddingSpace, LocalEmbeddingPack } from '../../src/contracts/memory-vector.js';
export function embeddingSpace(): EmbeddingSpace {
  return { provider: 'fixture', model: 'synthetic-3d', revision: 'v1', dimensions: 3, normalization: 'l2', metric: 'cosine' };
}
export function embeddingPack(): LocalEmbeddingPack {
  return { schemaVersion: 1, space: embeddingSpace(), provenance: 'synthetic', generatorRevision: 'fixture-v1',
    corpusDigest: 'a'.repeat(64), querySetDigest: 'b'.repeat(64),
    entries: [{ textDigest: createHash('sha256').update('结算失败').digest('hex'), vector: [3, 4, 0] }] };
}
