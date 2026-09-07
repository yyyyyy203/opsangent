import type { AgentEventEnvelopeV2, JsonObject, JsonValue } from '../../contracts/index.js';
import { parseAgentEventV2 } from '../../contracts/event-v2/schema.js';

export interface PublicAgentEventV2 {
  schemaVersion: 2;
  eventId: string;
  sequence: number;
  type: string;
  runId: string;
  stepId?: string;
  correlationId: string;
  timestamp: string;
  durability: 'durable' | 'transient';
  payload: JsonObject;
}

const DROP = Symbol('drop');
const FORBIDDEN_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|system[-_]?prompt|raw[-_]?arguments)/i;
const FORBIDDEN_VALUE = /\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}/i;
const INTERNAL_ADDRESS = /(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w.-]*\.internal)(?::\d+)?(?:\/\S*)?/i;

export class PublicEventProjectorV2 {
  public project(input: AgentEventEnvelopeV2): PublicAgentEventV2 | null {
    const event = parseAgentEventV2(input);
    if (event.visibility !== 'public') return null;
    if (event.type === 'CONTENT_BLOCK_STARTED' && event.payload.blockType === 'raw_tool_call') return null;
    if (event.type === 'CONTENT_BLOCK_COMPLETED' && event.payload.block?.type === 'raw_tool_call') return null;
    if (event.type === 'CONTENT_BLOCK_DELTA'
      && (FORBIDDEN_VALUE.test(event.payload.delta) || INTERNAL_ADDRESS.test(event.payload.delta))) return null;

    const payload = this.publicPayload(event);
    if (payload === null) return null;
    return {
      schemaVersion: 2,
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      runId: event.runId,
      correlationId: event.correlationId,
      timestamp: event.timestamp,
      durability: event.durability,
      payload,
      ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    };
  }

  private publicPayload(event: AgentEventEnvelopeV2): JsonObject | null {
    switch (event.type) {
      case 'RUN_STARTED':
        return sanitizeRecord({ ...event.payload, versionSnapshot: {} });
      case 'TOOL_CALL_CREATED':
        return sanitizeRecord({
          ...event.payload,
          call: { id: event.payload.call.id, name: event.payload.call.name, input: {} },
        });
      case 'TOOL_RESULT': {
        const { result } = event.payload;
        return sanitizeRecord({
          durationMs: event.payload.durationMs,
          evidenceIds: event.payload.evidenceIds,
          result: {
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            status: result.status,
            ...(result.error === undefined ? {} : {
              error: { code: result.error.code, message: result.error.message, retryable: result.error.retryable },
            }),
            ...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
            ...(result.finishedAt === undefined ? {} : { finishedAt: result.finishedAt }),
          },
        });
      }
      case 'EXTERNAL_EXECUTION_REQUESTED':
        return sanitizeRecord({ ...event.payload, interactionPayload: {} });
      case 'ACTION_EXECUTED':
        return sanitizeRecord({
          actionId: event.payload.actionId,
          idempotencyKey: event.payload.idempotencyKey,
          uncertainty: event.payload.uncertainty,
        });
      case 'TOOL_OUTPUT_DELTA':
        if (event.payload.textDelta !== undefined
          && (FORBIDDEN_VALUE.test(event.payload.textDelta) || INTERNAL_ADDRESS.test(event.payload.textDelta))) return null;
        return sanitizeRecord({
          blockId: event.payload.blockId,
          ...(event.payload.textDelta === undefined ? {} : { textDelta: event.payload.textDelta }),
        });
      default:
        return sanitizeRecord(event.payload as unknown as JsonObject);
    }
  }
}

function sanitizeRecord(value: JsonObject): JsonObject {
  const sanitized = sanitizeValue(value);
  return sanitized === DROP || Array.isArray(sanitized) || sanitized === null || typeof sanitized !== 'object'
    ? {}
    : sanitized;
}

function sanitizeValue(value: JsonValue): JsonValue | typeof DROP {
  if (typeof value === 'string') {
    return FORBIDDEN_VALUE.test(value) || INTERNAL_ADDRESS.test(value) ? DROP : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.flatMap((item): JsonValue[] => {
      const sanitized = sanitizeValue(item);
      return sanitized === DROP ? [] : [sanitized];
    });
  }
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    const sanitized = sanitizeValue(item);
    if (sanitized !== DROP) output[key] = sanitized;
  }
  return output;
}
