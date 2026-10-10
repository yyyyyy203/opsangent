import type { MemoryOperation, MemoryScope, MemorySelection } from './diagnostic-memory.js';

/** Exact provider space identity; a model revision/dimension change creates a new index space. */
export interface EmbeddingSpace {
  provider: string;
  model: string;
  revision: string;
  dimensions: number;
  normalization: 'l2';
  metric: 'cosine';
}
export interface EmbeddingProvider {
  readonly space: EmbeddingSpace;
  embed(texts: readonly string[], operation: MemoryOperation): Promise<readonly Float32Array[]>;
}
export interface MemoryVectorDocument extends MemorySelection {
  scope: MemoryScope;
  kind: 'episodic';
  sourceRunId: string;
  text: string;
}
export interface MemoryVectorEntry extends MemorySelection {
  scope: MemoryScope;
  kind: 'episodic';
  space: EmbeddingSpace;
  vector: Float32Array;
}
export interface MemoryVectorHit extends MemorySelection { score: number }
export interface MemoryVectorSearch {
  scope: MemoryScope;
  space: EmbeddingSpace;
  vector: Float32Array;
  eligible: readonly MemorySelection[];
  limit: number;
}
export interface VectorIndex {
  upsert(entries: readonly MemoryVectorEntry[], operation: MemoryOperation): Promise<void>;
  search(input: MemoryVectorSearch, operation: MemoryOperation): Promise<readonly MemoryVectorHit[]>;
  remove(input: { scope: MemoryScope; space: EmbeddingSpace; memoryIds: readonly string[] }, operation: MemoryOperation): Promise<void>;
  close(): Promise<void>;
}
export interface MemoryExperimentCorpus {
  read(input: { scope: MemoryScope; excludeRunIds: readonly string[] }, operation: MemoryOperation): Promise<readonly MemoryVectorDocument[]>;
}
export type VectorExperimentErrorCode =
  | 'VECTOR_INPUT_INVALID' | 'VECTOR_SPACE_MISMATCH' | 'VECTOR_PACK_INVALID'
  | 'VECTOR_EMBEDDING_MISSING' | 'VECTOR_INDEX_UNAVAILABLE' | 'VECTOR_CAPACITY_EXCEEDED';
export interface ShadowRetrievalResult {
  requestedMode: 'bm25' | 'vector' | 'hybrid';
  usedMode: 'bm25' | 'vector' | 'hybrid';
  hits: readonly MemorySelection[];
  fallbackReason?: VectorExperimentErrorCode;
}
export interface MemoryVectorMeasurements {
  nowMs(): number;
  rssBytes(): number;
  indexBytes(): Promise<number>;
}
/** Contains hashes and vectors only, never source text or endpoint credentials. */
export interface LocalEmbeddingPack {
  schemaVersion: 1;
  space: EmbeddingSpace;
  provenance: 'real' | 'synthetic';
  generatorRevision: string;
  corpusDigest: string;
  querySetDigest: string;
  entries: readonly { textDigest: string; vector: readonly number[] }[];
}
