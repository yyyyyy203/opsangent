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
        return sanitizeRecord({ profile: event.payload.profile, trigger: event.payload.trigger, deadline: event.payload.deadline, versionSnapshot: {} });
      case 'STEP_STARTED':
        return sanitizeRecord({ iteration: event.payload.iteration, stage: event.payload.stage, budgetSnapshot: pickNumbers(event.payload.budgetSnapshot) });
      case 'REASONING_STARTED':
        return sanitizeRecord({ stage: event.payload.stage, objective: safeText(event.payload.objective) });
      case 'MESSAGE_STARTED':
        return sanitizeRecord({ messageId: event.payload.messageId, role: event.payload.role, status: event.payload.status });
      case 'CONTENT_BLOCK_STARTED':
        return sanitizeRecord({ messageId: event.payload.messageId, blockId: event.payload.blockId, blockType: event.payload.blockType, index: event.payload.index });
      case 'CONTENT_BLOCK_DELTA':
        return sanitizeRecord({ messageId: event.payload.messageId, blockId: event.payload.blockId, delta: safeText(event.payload.delta), index: event.payload.index });
      case 'CONTENT_BLOCK_COMPLETED':
        return sanitizeRecord({ messageId: event.payload.messageId, blockId: event.payload.blockId, blockSummary: safeText(event.payload.blockSummary), index: event.payload.index });
      case 'MESSAGE_COMPLETED':
        return sanitizeRecord({ messageId: event.payload.messageId, ...(event.payload.usage === undefined ? {} : { usage: event.payload.usage as unknown as JsonObject }), completedAt: event.payload.completedAt });
      case 'MESSAGE_FAILED':
        return sanitizeRecord({ messageId: event.payload.messageId, error: { code: event.payload.error.code, message: safeText(event.payload.error.message), retryable: event.payload.error.retryable } });
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
      case 'TOOL_STARTED':
        return sanitizeRecord({ toolName: event.payload.toolName, source: event.payload.source, attempt: event.payload.attempt, ...(event.payload.deadline === undefined ? {} : { deadline: event.payload.deadline }) });
      case 'TOOL_PROGRESS':
        return sanitizeRecord({ progress: event.payload.progress, displaySummary: safeText(event.payload.displaySummary) });
      case 'EVIDENCE_COLLECTED':
        return sanitizeRecord({ evidenceIds: event.payload.evidenceIds, coverage: event.payload.coverage, source: event.payload.source, summary: safeText(event.payload.summary) });
      case 'EVIDENCE_COLLECTION_STARTED':
        return sanitizeRecord({ source: event.payload.source, queryWindow: safeText(event.payload.queryWindow), planItemId: event.payload.planItemId });
      case 'DIAGNOSIS_COMPLETED':
        return sanitizeRecord({ outcome: event.payload.outcome, reportId: event.payload.reportId, evidenceIds: event.payload.evidenceIds, limitations: event.payload.limitations.map(safeText) });
      default:
        return {};
    }
  }
}

function safeText(value: string): string {
  return FORBIDDEN_VALUE.test(value) || INTERNAL_ADDRESS.test(value) ? '[REDACTED]' : value.slice(0, 500);
}

function pickNumbers(value: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === 'number' && Number.isFinite(item)) output[key] = item;
  return output;
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
