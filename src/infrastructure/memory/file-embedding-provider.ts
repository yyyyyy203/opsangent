import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Clock } from '../../contracts/common.js';
import type { MemoryOperation } from '../../contracts/diagnostic-memory.js';
import type { EmbeddingProvider, EmbeddingSpace, LocalEmbeddingPack } from '../../contracts/memory-vector.js';
import { MAX_EMBEDDING_PACK_BYTES, parseEmbeddingSpace, parseLocalEmbeddingPack } from '../../contracts/memory-vector-schema.js';
import { embeddingSpaceKey, memoryEmbeddingTextDigest, normalizeMemoryEmbeddingText, normalizeMemoryVector } from '../../memory/vector/embedding-space.js';
import { VectorExperimentError } from '../../memory/vector/vector-error.js';

/** Offline adapter; neither missing vectors nor invalid packs trigger remote generation. */
export class FileEmbeddingProvider implements EmbeddingProvider {
  public readonly space: EmbeddingSpace;
  public readonly provenance: LocalEmbeddingPack['provenance'];
  public readonly generatorRevision: string;
  private readonly vectors = new Map<string, Float32Array>();

  private constructor(pack: LocalEmbeddingPack, private readonly clock: Clock, public readonly packSha256: string) {
    this.space = Object.freeze(structuredClone(pack.space));
    this.provenance = pack.provenance;
    this.generatorRevision = pack.generatorRevision;
    for (const entry of pack.entries) {
      this.vectors.set(entry.textDigest, normalizeMemoryVector(Float32Array.from(entry.vector), this.space.dimensions));
    }
  }

  public static async load(input: {
    path: string; expectedSpace: EmbeddingSpace; corpusDigest: string; querySetDigest: string; clock: Clock;
  }): Promise<FileEmbeddingProvider> {
    try {
      if (!isAbsolute(input.path)) throw new VectorExperimentError('VECTOR_PACK_INVALID');
      const expectedSpace = parseEmbeddingSpace(input.expectedSpace);
      const handle = await open(input.path, 'r');
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_EMBEDDING_PACK_BYTES) throw new VectorExperimentError('VECTOR_PACK_INVALID');
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const buffer = Buffer.allocUnsafe(64 * 1024);
          const read = await handle.read(buffer, 0, buffer.length, null);
          if (read.bytesRead === 0) break;
          total += read.bytesRead;
          // Recheck while reading so concurrent file growth cannot bypass the initial stat bound.
          if (total > MAX_EMBEDDING_PACK_BYTES) throw new VectorExperimentError('VECTOR_PACK_INVALID');
          chunks.push(buffer.subarray(0, read.bytesRead));
        }
        bytes = Buffer.concat(chunks, total);
      } finally { await handle.close(); }
      const pack = parseLocalEmbeddingPack(JSON.parse(bytes.toString('utf8')) as unknown);
      if (embeddingSpaceKey(pack.space) !== embeddingSpaceKey(expectedSpace)
        || pack.corpusDigest !== input.corpusDigest || pack.querySetDigest !== input.querySetDigest) {
        throw new VectorExperimentError('VECTOR_SPACE_MISMATCH');
      }
      return new FileEmbeddingProvider(pack, input.clock, createHash('sha256').update(bytes).digest('hex'));
    } catch (error) {
      if (error instanceof VectorExperimentError) throw error;
      throw new VectorExperimentError('VECTOR_PACK_INVALID');
    }
  }

  public embed(texts: readonly string[], operation: MemoryOperation): Promise<readonly Float32Array[]> {
    return Promise.resolve().then(() => {
      this.checkBudget(operation);
      const candidateTexts: unknown = texts;
      if (!isUnknownArray(candidateTexts) || candidateTexts.length > 16) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      const results: Float32Array[] = [];
      for (let index = 0; index < candidateTexts.length; index += 1) {
        this.checkBudget(operation);
        const text: unknown = candidateTexts[index];
        if (!Object.hasOwn(candidateTexts, index)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
        if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 2 * 1024) {
          throw new VectorExperimentError('VECTOR_INPUT_INVALID');
        }
        const normalized = normalizeMemoryEmbeddingText(text);
        if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > 2 * 1024) {
          throw new VectorExperimentError('VECTOR_INPUT_INVALID');
        }
        const vector = this.vectors.get(memoryEmbeddingTextDigest(normalized));
        if (vector === undefined) throw new VectorExperimentError('VECTOR_EMBEDDING_MISSING');
        results.push(vector.slice());
      }
      this.checkBudget(operation);
      return results;
    });
  }

  private checkBudget(operation: MemoryOperation): void {
    operation.signal?.throwIfAborted();
    if (!Number.isFinite(operation.deadlineMs)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
    if (this.clock.now().getTime() >= operation.deadlineMs) throw new DOMException('Embedding deadline exceeded.', 'TimeoutError');
  }
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
