import { createHash } from 'node:crypto';
import type { EmbeddingSpace } from '../../contracts/memory-vector.js';
import { parseEmbeddingSpace } from '../../contracts/memory-vector-schema.js';
import { canonicalJson } from '../../contracts/stable-json.js';
import { VectorExperimentError } from './vector-error.js';

export function embeddingSpaceKey(space: EmbeddingSpace): string {
  return canonicalJson(parseEmbeddingSpace(space));
}
export function normalizeMemoryEmbeddingText(text: string): string {
  if (typeof text !== 'string') throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  return text.normalize('NFKC').replace(/\r\n/gu, '\n').trim();
}
export function memoryEmbeddingTextDigest(text: string): string {
  return createHash('sha256').update(normalizeMemoryEmbeddingText(text), 'utf8').digest('hex');
}
export function normalizeMemoryVector(vector: Float32Array, dimensions: number): Float32Array {
  if (!(vector instanceof Float32Array) || !Number.isInteger(dimensions) || dimensions < 2 || dimensions > 4096
    || vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  }
  const magnitude = Math.hypot(...vector);
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  const result = Float32Array.from(vector, (value) => value / magnitude);
  if (result.some((value) => !Number.isFinite(value)) || Math.hypot(...result) === 0) {
    throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  }
  return result;
}
