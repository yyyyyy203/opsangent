import { z } from 'zod';
import type { JsonValue } from '../common.js';
import type { AgentErrorCode } from '../errors.js';

export type EventVisibilityV2 = 'public' | 'audit' | 'internal';
export type EventDurabilityV2 = 'durable' | 'transient';
export type EventStageV2 = 'triage' | 'evidence_collection' | 'hypothesis' | 'risk_gate' | 'action' | 'verification' | 'postmortem';
export type BudgetTypeV2 = 'iterations' | 'tokens' | 'time' | 'evidence' | 'cost' | 'tool_calls';
export const identifierV2Schema = z.string().min(1);
export const timestampV2Schema = z.string().datetime({ offset: true });
export const eventVisibilitySchema = z.enum(['public', 'audit', 'internal']);
export const eventDurabilitySchema = z.enum(['durable', 'transient']);
export const eventStageSchema = z.enum(['triage', 'evidence_collection', 'hypothesis', 'risk_gate', 'action', 'verification', 'postmortem']);
export const budgetTypeSchema = z.enum(['iterations', 'tokens', 'time', 'evidence', 'cost', 'tool_calls']);
const agentErrorCodesV2 = [
  'ABORTED', 'BUDGET_EXCEEDED', 'CONFIRMATION_EXPIRED', 'INVALID_INPUT', 'LOOP_DETECTED', 'MODEL_ERROR',
  'STORAGE_ERROR', 'TOOL_ERROR', 'TOOL_NOT_FOUND', 'TOOL_ARGUMENTS_PARSE_FAILED', 'TOOL_ARGUMENTS_SCHEMA_INVALID',
  'TOOL_ARGUMENTS_SEMANTIC_INVALID', 'POLICY_DENIED', 'MCP_NETWORK_ERROR', 'MCP_TIMEOUT', 'MCP_RATE_LIMITED',
  'MCP_SERVER_ERROR', 'MCP_AUTH_ERROR', 'MCP_PROTOCOL_ERROR', 'CIRCUIT_OPEN', 'USER_REJECTED',
] as const satisfies readonly AgentErrorCode[];
export const agentErrorCodeV2Schema = z.enum(agentErrorCodesV2);
export const jsonValueV2Schema = z.custom<JsonValue>((value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => jsonValueV2Schema.safeParse(item).success);
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value).every((item) => jsonValueV2Schema.safeParse(item).success);
}, 'Expected a JSON value');
export const jsonRecordV2Schema = z.record(jsonValueV2Schema);
export interface EventErrorPayloadV2 {
  code: AgentErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, JsonValue>;
}
export const eventErrorPayloadV2Schema = z.object({
  code: agentErrorCodeV2Schema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: jsonRecordV2Schema.optional(),
}).strict();

export interface AgentEventEnvelopeBaseV2<T extends string, P = unknown> {
  schemaVersion: 2; eventId: string; sequence: number; type: T; payload: P; runId: string;
  sessionId?: string; replyId?: string; streamId?: string; stepId?: string; attemptId?: string; toolCallId?: string; parentRunId?: string;
  correlationId: string; causationId?: string; timestamp: string; visibility: EventVisibilityV2; durability: EventDurabilityV2;
}
export type UnsequencedAgentEventBaseV2<T extends string, P = unknown> = Omit<AgentEventEnvelopeBaseV2<T, P>, 'eventId' | 'sequence'>;
export const agentEventEnvelopeV2Schema = z.object({
  schemaVersion: z.literal(2), eventId: identifierV2Schema, sequence: z.number().int().nonnegative(), type: identifierV2Schema,
  payload: z.unknown(), runId: identifierV2Schema, sessionId: identifierV2Schema.optional(), replyId: identifierV2Schema.optional(),
  streamId: identifierV2Schema.optional(), stepId: identifierV2Schema.optional(), attemptId: identifierV2Schema.optional(), toolCallId: identifierV2Schema.optional(),
  parentRunId: identifierV2Schema.optional(), correlationId: identifierV2Schema, causationId: identifierV2Schema.optional(), timestamp: timestampV2Schema,
  visibility: eventVisibilitySchema, durability: eventDurabilitySchema,
}).strict();
