import { z } from 'zod';
import type { JsonValue } from '../common.js';

export type { JsonValue } from '../common.js';

export type MessageRoleV2 = 'system' | 'user' | 'assistant' | 'tool';
export type MessageStatusV2 = 'streaming' | 'completed' | 'failed' | 'interrupted';
export type MessageVisibilityV2 = 'model' | 'user' | 'audit';

export const identifierSchema = z.string().min(1);
export const timestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => Number.isFinite(Date.parse(value)),
  'Expected a valid ISO-8601 timestamp',
);

export const messageRoleV2Schema = z.enum(['system', 'user', 'assistant', 'tool']);
export const messageStatusV2Schema = z.enum(['streaming', 'completed', 'failed', 'interrupted']);
export const messageVisibilityV2Schema = z.enum(['model', 'user', 'audit']);

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueAt(value, new Set<object>());
}

function isJsonValueAt(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  if (Array.isArray(value)) {
    ancestors.add(value);
    const valid = value.every((item) => isJsonValueAt(item, ancestors));
    ancestors.delete(value);
    return valid;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((item) => isJsonValueAt(item, ancestors));
  ancestors.delete(value);
  return valid;
}

export function isJsonMetadata(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && isJsonValue(value);
}

export const jsonValueSchema = z.custom<JsonValue>(isJsonValue, 'Expected a JSON-serializable value');
export const jsonMetadataSchema = z.custom<Record<string, JsonValue>>(
  isJsonMetadata,
  'Expected JSON-serializable metadata',
);
