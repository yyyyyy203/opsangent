import { z } from 'zod';
import type { AgentMessageV2, MessageBlockV2 } from './index.js';
import {
  identifierSchema,
  isJsonValue,
  jsonMetadataSchema,
  jsonValueSchema,
  messageRoleV2Schema,
  messageStatusV2Schema,
  messageVisibilityV2Schema,
  optionalJsonMetadataSchema,
  timestampSchema,
} from './common.js';

const agentErrorCodeSchema = z.enum([
  'ABORTED', 'BUDGET_EXCEEDED', 'CONFIRMATION_EXPIRED', 'INVALID_INPUT', 'LOOP_DETECTED', 'MODEL_ERROR', 'STORAGE_ERROR',
  'TOOL_ERROR', 'TOOL_NOT_FOUND', 'TOOL_ARGUMENTS_PARSE_FAILED', 'TOOL_ARGUMENTS_SCHEMA_INVALID',
  'TOOL_ARGUMENTS_SEMANTIC_INVALID', 'POLICY_DENIED', 'MCP_NETWORK_ERROR', 'MCP_TIMEOUT', 'MCP_RATE_LIMITED',
  'MCP_SERVER_ERROR', 'MCP_AUTH_ERROR', 'MCP_PROTOCOL_ERROR', 'CIRCUIT_OPEN', 'USER_REJECTED',
]);

const agentErrorSchema = z.object({
  code: agentErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  details: optionalJsonMetadataSchema,
}).strict();

const toolCallSchema = z.object({
  id: identifierSchema,
  name: identifierSchema,
  input: jsonMetadataSchema,
}).strict();

const rawToolCallSchema = z.object({
  id: identifierSchema,
  name: identifierSchema,
  arguments: z.string(),
}).strict();

const toolResponseBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('json'), value: jsonValueSchema }).strict(),
  z.object({ type: z.literal('evidence_ref'), evidenceId: identifierSchema }).strict(),
  z.object({ type: z.literal('artifact'), uri: z.string(), mediaType: z.string().optional() }).strict(),
]);

const toolResponseSchema = z.object({
  blocks: z.array(toolResponseBlockSchema),
  evidenceIds: z.array(identifierSchema).optional(),
  metadata: optionalJsonMetadataSchema,
  isError: z.boolean().optional(),
}).strict();

const toolExecutionResultSchema = z.object({
  toolCallId: identifierSchema,
  toolName: identifierSchema,
  status: z.enum(['success', 'failed', 'timeout', 'aborted', 'interrupted', 'awaiting_external', 'skipped']),
  response: toolResponseSchema.optional(),
  error: agentErrorSchema.optional(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.optional(),
}).strict();

const contextSummarySchema = z.object({
  confirmedFacts: z.array(z.string()),
  hypotheses: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  pendingActionIds: z.array(z.string()),
  executedActionIds: z.array(z.string()),
  unresolvedRisks: z.array(z.string()),
}).strict();

const blockBaseSchema = z.object({
  blockId: identifierSchema,
  metadata: optionalJsonMetadataSchema,
});

const messageBlockV2Schema = z.discriminatedUnion('type', [
  blockBaseSchema.extend({ type: z.literal('text'), text: z.string() }).strict(),
  blockBaseSchema.extend({ type: z.literal('reasoning_summary'), summary: z.string() }).strict(),
  blockBaseSchema.extend({ type: z.literal('tool_call'), call: toolCallSchema }).strict(),
  blockBaseSchema.extend({ type: z.literal('raw_tool_call'), call: rawToolCallSchema }).strict(),
  blockBaseSchema.extend({
    type: z.literal('tool_result'),
    result: toolExecutionResultSchema,
    attempt: z.object({ attemptId: identifierSchema, number: z.number().int().positive() }).strict(),
    evidenceIds: z.array(identifierSchema),
  }).strict(),
  blockBaseSchema.extend({
    type: z.literal('evidence_ref'), evidenceId: identifierSchema, summary: z.string(), source: identifierSchema, retrievable: z.boolean(),
  }).strict(),
  blockBaseSchema.extend({
    type: z.literal('artifact_ref'), artifactId: identifierSchema, uri: z.string().min(1), mediaType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(), sha256: identifierSchema, accessPolicy: z.enum(['model', 'user', 'audit']),
  }).strict(),
  blockBaseSchema.extend({
    type: z.literal('image_ref'), imageId: identifierSchema, uri: z.string().min(1), mediaType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(), sha256: identifierSchema, accessPolicy: z.enum(['model', 'user', 'audit']),
  }).strict(),
  blockBaseSchema.extend({ type: z.literal('context_summary'), summary: contextSummarySchema }).strict(),
  blockBaseSchema.extend({
    type: z.literal('confirmation_request'), confirmationId: identifierSchema, toolCallIds: z.array(identifierSchema).min(1),
    riskSummary: z.string(), expiresAt: timestampSchema,
  }).strict(),
  blockBaseSchema.extend({
    type: z.literal('confirmation_result'), confirmationId: identifierSchema,
    decision: z.enum(['approved', 'rejected', 'expired', 'cancelled']), actor: identifierSchema,
    toolCallIds: z.array(identifierSchema).min(1), decidedAt: timestampSchema,
  }).strict(),
  blockBaseSchema.extend({
    type: z.literal('diagnosis'), outcome: z.enum(['confirmed', 'partial', 'inconclusive']),
    rootCauseCandidates: z.array(z.object({ summary: z.string(), confidence: z.enum(['low', 'medium', 'high']) }).strict()),
    evidenceIds: z.array(identifierSchema), missingEvidence: z.array(z.string()), limitations: z.array(z.string()),
  }).strict(),
  blockBaseSchema.extend({
    type: z.literal('action_proposal'), actionId: identifierSchema, toolCallId: identifierSchema,
    risk: z.enum(['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), expectedEffect: z.string(), verificationPlan: z.string(),
  }).strict(),
  blockBaseSchema.extend({
    type: z.literal('action_result'), actionId: identifierSchema, toolCallId: identifierSchema, result: jsonValueSchema,
    idempotencyKey: identifierSchema, verificationEvidenceIds: z.array(identifierSchema), uncertainty: z.boolean(),
  }).strict(),
  blockBaseSchema.extend({ type: z.literal('error'), error: agentErrorSchema }).strict(),
]);

export const agentMessageV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: identifierSchema,
  runId: identifierSchema,
  sessionId: identifierSchema.optional(),
  replyId: identifierSchema.optional(),
  stepId: identifierSchema.optional(),
  parentMessageId: identifierSchema.optional(),
  role: messageRoleV2Schema,
  status: messageStatusV2Schema,
  visibility: messageVisibilityV2Schema,
  blocks: z.array(messageBlockV2Schema),
  createdAt: timestampSchema,
  completedAt: timestampSchema.optional(),
  metadata: optionalJsonMetadataSchema,
}).strict().superRefine((message, context) => {
  const blockIds = new Set<string>();
  for (const [index, block] of message.blocks.entries()) {
    if (blockIds.has(block.blockId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['blocks', index, 'blockId'], message: 'blockId must be unique within a message' });
    }
    blockIds.add(block.blockId);
    if (block.type === 'raw_tool_call' && message.visibility !== 'audit') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['blocks', index], message: 'raw_tool_call requires audit message visibility' });
    }
  }
});

export function parseAgentMessageV2(input: unknown): AgentMessageV2 {
  const result = safeParseAgentMessageV2(input);
  if (!result.success) throw result.error;
  return result.data;
}

export function safeParseAgentMessageV2(
  input: unknown,
): z.SafeParseReturnType<unknown, AgentMessageV2> {
  if (!isJsonValue(input)) return unsafeMessageResult();
  try {
    return agentMessageV2Schema.safeParse(input) as z.SafeParseReturnType<unknown, AgentMessageV2>;
  } catch {
    return unsafeMessageResult();
  }
}

export function isMessageBlockV2(input: unknown): input is MessageBlockV2 {
  return messageBlockV2Schema.safeParse(input).success;
}

function unsafeMessageResult(): z.SafeParseReturnType<unknown, AgentMessageV2> {
  return {
    success: false,
    error: new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'Expected a JSON-safe AgentMessageV2 input',
    }]),
  };
}
