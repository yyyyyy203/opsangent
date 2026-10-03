import type { JsonValue } from './common.js';
import type { NormalizedLogRecord } from './storage.js';

export function redactLogRecord(record: NormalizedLogRecord): NormalizedLogRecord {
  return {
    ...record,
    ...(record.service === undefined ? {} : { service: redactText(record.service) }),
    ...(record.level === undefined ? {} : { level: redactText(record.level) }),
    ...(record.message === undefined ? {} : { message: redactText(record.message) }),
    ...(record.exception === undefined ? {} : { exception: redactText(record.exception) }),
    ...(record.traceId === undefined ? {} : { traceId: redactText(record.traceId) }),
    ...(record.fields === undefined ? {} : { fields: redactFields(record.fields) }),
  };
}

function redactFields(fields: Record<string, JsonValue>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/authorization|cookie|password|passwd|secret|token|api[-_]?key/i.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = redactValue(value);
    }
  }
  return output;
}

function redactValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i.test(key)
        ? '[REDACTED]'
        : redactValue(item);
    }
    return output;
  }
  return value;
}

function redactText(value: string): string {
  return /\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}/i.test(value) ? '[REDACTED]' : value;
}
