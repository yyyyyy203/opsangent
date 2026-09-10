import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../contracts/common.js';
import type { PendingToolBatch } from '../contracts/context.js';

const timestamp = z.string().datetime({ offset: true });
const toolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.unknown()),
}).strict();
const toolResult = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(['success', 'failed', 'timeout', 'aborted', 'interrupted', 'awaiting_external', 'skipped']),
  response: z.object({
    blocks: z.array(z.unknown()),
    evidenceIds: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.unknown()).optional(),
    isError: z.boolean().optional(),
  }).strict().optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.unknown()).optional(),
  }).strict().optional(),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
}).strict();

const pendingToolBatch = z.object({
  batchId: z.string().min(1),
  stepId: z.string().min(1),
  calls: z.array(toolCall).min(1),
  completedResults: z.array(toolResult),
  state: z.enum(['admitted', 'executing', 'awaiting_confirmation', 'awaiting_external']),
  createdAt: timestamp,
}).strict();

/** Produces stable JSON for checksums without accepting lossy JSON values. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function checkpointChecksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function parsePendingToolBatch(value: unknown): PendingToolBatch {
  const parsed = pendingToolBatch.parse(value);
  const callIds = new Set(parsed.calls.map((call) => call.id));
  if (callIds.size !== parsed.calls.length) throw new Error('pending batch contains duplicate tool call IDs');
  const completedIds = new Set<string>();
  for (const result of parsed.completedResults) {
    if (!callIds.has(result.toolCallId)) throw new Error('pending batch completed result does not belong to its calls');
    if (completedIds.has(result.toolCallId)) throw new Error('pending batch contains duplicate completed results');
    completedIds.add(result.toolCallId);
  }
  return structuredClone(parsed) as PendingToolBatch;
}

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value !== 'object') throw new TypeError(`canonical JSON does not support ${typeof value}`);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical JSON only supports plain objects');
  const record = value as Record<string, unknown>;
  const normalized: JsonObject = {};
  for (const key of Object.keys(record).sort()) {
    const property = record[key];
    if (property === undefined) throw new TypeError(`canonical JSON does not support undefined property ${key}`);
    normalized[key] = canonicalize(property);
  }
  return normalized;
}
