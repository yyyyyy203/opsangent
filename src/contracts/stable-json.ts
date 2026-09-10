import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue } from './common.js';

/** Stable JSON representation used for durable identity and integrity checks. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function checkpointChecksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
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
