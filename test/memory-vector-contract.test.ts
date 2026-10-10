import { describe, expect, it } from 'vitest';
import { parseEmbeddingSpace, parseLocalEmbeddingPack } from '../src/contracts/memory-vector-schema.js';
import { embeddingSpaceKey, memoryEmbeddingTextDigest, normalizeMemoryEmbeddingText, normalizeMemoryVector } from '../src/memory/vector/embedding-space.js';
import { VectorExperimentError } from '../src/memory/vector/vector-error.js';
import { embeddingPack, embeddingSpace } from './fixtures/memory-vector.js';

describe('versioned memory vector contracts', () => {
  it('strictly validates dimensions, source, metric, normalization and unknown fields', () => {
    expect(parseEmbeddingSpace(embeddingSpace())).toEqual(embeddingSpace());
    for (const dimensions of [1, 4097, 3.5, NaN]) {
      expect(() => parseEmbeddingSpace({ ...embeddingSpace(), dimensions })).toThrow();
    }
    for (const patch of [{ provider: '' }, { revision: '' }, { metric: 'dot' }, { normalization: 'none' }, { raw: 'private' }]) {
      expect(() => parseEmbeddingSpace({ ...embeddingSpace(), ...patch })).toThrow();
    }
  });
  it('binds every space identity field, independent of property order', () => {
    const space = embeddingSpace();
    expect(embeddingSpaceKey({ metric: space.metric, dimensions: space.dimensions, revision: space.revision,
      provider: space.provider, model: space.model, normalization: space.normalization })).toBe(embeddingSpaceKey(space));
    for (const patch of [{ provider: 'other' }, { model: 'other' }, { revision: 'r2' }, { dimensions: 4 }]) {
      expect(embeddingSpaceKey({ ...space, ...patch })).not.toBe(embeddingSpaceKey(space));
    }
  });
  it('normalizes NFKC and CRLF but preserves case and Chinese text', () => {
    expect(normalizeMemoryEmbeddingText('  Ａ结算\r\nB  ')).toBe('A结算\nB');
    expect(memoryEmbeddingTextDigest('  Ａ结算\r\nB  ')).toBe(memoryEmbeddingTextDigest('A结算\nB'));
    expect(memoryEmbeddingTextDigest('A结算')).not.toBe(memoryEmbeddingTextDigest('a结算'));
    expect(memoryEmbeddingTextDigest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('returns a normalized independent float32 copy', () => {
    const input = new Float32Array([3, 4, 0]);
    const normalized = normalizeMemoryVector(input, 3);
    expect(normalized).not.toBe(input);
    expect([...input]).toEqual([3, 4, 0]);
    expect(normalized[0]).toBeCloseTo(0.6, 6);
    expect(normalized[1]).toBeCloseTo(0.8, 6);
    expect(Math.hypot(...normalized)).toBeCloseTo(1, 6);
  });
  it('rejects zero, nonfinite, overflow and mismatched vectors', () => {
    for (const input of [new Float32Array(3), new Float32Array([NaN, 1, 0]),
      new Float32Array([Infinity, 0, 1]), new Float32Array([1e40, 1, 0]), new Float32Array([1, 2])]) {
      expect(() => normalizeMemoryVector(input, 3)).toThrow(VectorExperimentError);
    }
  });
  it('validates a strict pack and never invents missing provenance or generator information', () => {
    expect(parseLocalEmbeddingPack(embeddingPack())).toEqual(embeddingPack());
    for (const patch of [{ provenance: undefined }, { generatorRevision: '' }, { corpusDigest: 'bad' },
      { querySetDigest: 'bad' }, { schemaVersion: 2 }, { rawText: 'private' }]) {
      expect(() => parseLocalEmbeddingPack({ ...embeddingPack(), ...patch })).toThrow();
    }
  });
  it('rejects duplicate digests, wrong dimensions, zero, invalid numbers and oversized entry counts', () => {
    const pack = embeddingPack();
    expect(() => parseLocalEmbeddingPack({ ...pack, entries: [pack.entries[0], pack.entries[0]] })).toThrow();
    for (const vector of [[0, 0, 0], [1, 2], [NaN, 1, 0], [Infinity, 1, 0], [1e40, 1, 0]]) {
      expect(() => parseLocalEmbeddingPack({ ...pack, entries: [{ textDigest: 'a'.repeat(64), vector }] })).toThrow();
    }
    expect(() => parseLocalEmbeddingPack({ ...pack, entries: Array.from({ length: 2001 }, (_, i) => ({
      textDigest: i.toString(16).padStart(64, '0'), vector: [1, 0, 0],
    })) })).toThrow();
  });
  it('exposes only stable safe vector error messages', () => {
    const error = new VectorExperimentError('VECTOR_PACK_INVALID');
    expect(error.code).toBe('VECTOR_PACK_INVALID');
    expect(error.message).not.toMatch(/raw|secret|path|token/i);
    expect('cause' in error).toBe(false);
  });
});
