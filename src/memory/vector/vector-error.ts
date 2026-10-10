import type { VectorExperimentErrorCode } from '../../contracts/memory-vector.js';
const messages: Readonly<Record<VectorExperimentErrorCode, string>> = {
  VECTOR_INPUT_INVALID: 'Vector input is invalid.',
  VECTOR_SPACE_MISMATCH: 'Vector space is incompatible.',
  VECTOR_PACK_INVALID: 'Embedding pack is invalid.',
  VECTOR_EMBEDDING_MISSING: 'Embedding is unavailable.',
  VECTOR_INDEX_UNAVAILABLE: 'Vector index is unavailable.',
  VECTOR_CAPACITY_EXCEEDED: 'Vector capacity is exceeded.',
};
export class VectorExperimentError extends Error {
  public constructor(public readonly code: VectorExperimentErrorCode) { super(messages[code]); this.name = 'VectorExperimentError'; }
}
