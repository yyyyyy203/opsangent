import { z } from 'zod';
import type { EmbeddingSpace, LocalEmbeddingPack } from './memory-vector.js';

export const MAX_EMBEDDING_PACK_BYTES = 32 * 1024 * 1024;
const identifier = z.string().min(1).max(256).refine((value) => value.trim().length > 0);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const embeddingSpaceSchema = z.object({
  provider: identifier,
  model: identifier,
  revision: identifier,
  dimensions: z.number().int().min(2).max(4096),
  normalization: z.literal('l2'),
  metric: z.literal('cosine'),
}).strict();
const entrySchema = z.object({
  textDigest: digest,
  vector: z.array(z.number().finite().refine((value) => Number.isFinite(Math.fround(value)))).min(2).max(4096),
}).strict();
const packSchema = z.object({
  schemaVersion: z.literal(1),
  space: embeddingSpaceSchema,
  provenance: z.enum(['real', 'synthetic']),
  generatorRevision: identifier,
  corpusDigest: digest,
  querySetDigest: digest,
  entries: z.array(entrySchema).max(2000),
}).strict().superRefine((value, context) => {
  const digests = new Set<string>();
  for (const entry of value.entries) {
    if (digests.has(entry.textDigest) || entry.vector.length !== value.space.dimensions
      || Math.hypot(...Float32Array.from(entry.vector)) === 0) {
      context.addIssue({ code: 'custom', message: 'Invalid embedding entry identity or dimensions.' });
    }
    digests.add(entry.textDigest);
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_EMBEDDING_PACK_BYTES) {
    context.addIssue({ code: 'custom', message: 'Embedding pack exceeds its byte budget.' });
  }
});

export function parseEmbeddingSpace(value: unknown): EmbeddingSpace {
  return structuredClone(embeddingSpaceSchema.parse(value));
}
export function parseLocalEmbeddingPack(value: unknown): LocalEmbeddingPack {
  return structuredClone(packSchema.parse(value));
}
