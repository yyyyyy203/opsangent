import type { AgentEventEnvelopeV2, JsonValue } from '../../contracts/index.js';
import { parseAgentEventV2 } from '../../contracts/event-v2/schema.js';
import type { EventProjectorV2 } from '../v2/event-publisher.js';

export interface AuditRecordV2 {
  eventId: string; sequence: number; type: string; runId: string; correlationId: string; timestamp: string;
  payloadSummary: Record<string, JsonValue>; stepId?: string; attemptId?: string; toolCallId?: string; parentRunId?: string;
}

const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|system[-_]?prompt|raw[-_]?arguments)/i;
const SECRET_VALUE = /\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}/i;
const INTERNAL_ADDRESS = /(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w.-]*\.internal)(?::\d+)?(?:\/\S*)?/i;

export class AuditProjectorV2 implements EventProjectorV2 {
  public readonly name = 'audit';
  public readonly records: AuditRecordV2[] = [];

  public project(input: AgentEventEnvelopeV2): void {
    const event = parseAgentEventV2(input);
    this.records.push({
      eventId: event.eventId, sequence: event.sequence, type: event.type, runId: event.runId,
      correlationId: event.correlationId, timestamp: event.timestamp,
      payloadSummary: summarize(event.type, event.payload as unknown as JsonValue),
      ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
      ...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId }),
    });
  }
}

function summarize(type: string, value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || (typeof item === 'string' && (SECRET_VALUE.test(item) || INTERNAL_ADDRESS.test(item)))) continue;
    if (type === 'MODEL_CALL_STARTED' && key === 'inputSummary') continue;
    if (type === 'TOOL_CALL_CREATED' && key === 'call') {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const call = item as Record<string, JsonValue>;
        output.call = { id: call.id ?? '', name: call.name ?? '' };
      }
      continue;
    }
    if (type === 'TOOL_RESULT' && key === 'result') {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) output.result = pick(item, ['toolCallId', 'toolName', 'status', 'startedAt', 'finishedAt', 'error']);
      continue;
    }
    if (type === 'CONTEXT_COMPRESSION_FAILED' && key === 'error') {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const error = item as Record<string, JsonValue>;
        output.error = {
          code: typeof error.code === 'string' ? error.code : 'STORAGE_ERROR',
          retryable: error.retryable === true,
          ...(error.details === undefined ? {} : { details: safeDetails(error.details) }),
        };
      }
      continue;
    }
    output[key] = safeValue(item);
  }
  return output;
}

function pick(value: Record<string, JsonValue>, keys: string[]): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const key of keys) {
    const item = value[key];
    if (item === undefined || SECRET_KEY.test(key)) continue;
    output[key] = safeValue(item);
  }
  return output;
}

function safeValue(value: JsonValue): JsonValue {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return SECRET_VALUE.test(value) || INTERNAL_ADDRESS.test(value) ? '[REDACTED]' : value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map(safeValue);
  return {};
}

function safeDetails(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      output[key] = safeValue(item);
    }
  }
  return output;
}
