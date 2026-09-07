import { z } from 'zod';
import type { AgentError, AgentErrorCode } from '../errors.js';
import type { JsonValue } from '../common.js';
import type { Finding } from '../guard.js';
import type { ToolCall, ToolExecutionResult, ToolResponseBlock, RiskSeverity } from '../tool.js';
import {
  identifierSchema,
  jsonMetadataSchema,
  jsonValueSchema,
  timestampSchema,
} from '../message-v2/common.js';

export type AdmissionGate = 'tool_existence' | 'json_parse' | 'schema_validation' | 'semantic_validation';
export type AdmissionOutcome = 'passed' | 'repaired' | 'degraded' | 'rejected';
export type ExecutionDecision = 'approved' | 'rejected' | 'expired' | 'cancelled';
export type DiagnosisOutcome = 'confirmed' | 'partial' | 'inconclusive';
export type Confidence = 'low' | 'medium' | 'high';

export interface ToolCallAdmissionUpdatedPayload {
  gate: AdmissionGate;
  outcome: AdmissionOutcome;
  attempt: number;
  errorCode?: AgentErrorCode;
}
export interface ToolCallRepairStartedPayload { repairStrategy: string; correctionChainId: string }
export interface ToolCallRepairCompletedPayload { strategy: string; changedPaths: string[]; attempt: number }
export interface ToolCallRepairFailedPayload { strategy: string; error: AgentError; nextAction: string }
export interface ToolCallRejectedPayload { toolName: string; gate: AdmissionGate; error: AgentError }
export interface ToolCallCreatedPayload { call: ToolCall; displayLabel?: string }
export interface ToolStartedPayload { toolName: string; source: string; attempt: number; deadline?: string }
export interface ToolProgressPayload { progress: number; displaySummary: string }
export interface ToolOutputDeltaPayload { blockId: string; textDelta?: string; artifactProgress?: JsonValue }
export interface ToolRetryScheduledPayload { attempt: number; reasonCode: string; delayMs: number }
export interface ToolResultPayload { result: ToolExecutionResult; durationMs: number; evidenceIds: string[] }
export interface ToolFailedPayload { error: AgentError; attempt: number; retryable: boolean }
export interface ToolCancelledPayload { actor: string; reason: string; partialArtifactIds: string[] }

export interface RiskEvaluatedPayload { findings: Finding[]; mergedRisk: RiskSeverity; policyVersion: string }
export interface ConfirmationRequestedPayload {
  confirmationId: string; toolCallIds: string[]; riskSummary: string; expiresAt: string;
}
export interface ConfirmationResolvedPayload {
  decision: ExecutionDecision; actor: string; toolCallIds: string[]; decidedAt: string;
}
export interface ConfirmationExpiredPayload { confirmationId: string; toolCallIds: string[]; expiredAt: string }
export interface ExternalExecutionRequestedPayload {
  requestId: string; toolCallId: string; interactionPayload: Record<string, JsonValue>; expiresAt: string;
}
export interface ExternalExecutionResolvedPayload {
  requestId: string; resultBlock: ToolResponseBlock; externalExecutionType: string;
}
export interface ExternalExecutionUncertainPayload {
  requestId: string; reason: string; requiredVerification: string;
}

export interface EvidenceCollectionStartedPayload { source: string; queryWindow: string; planItemId: string }
export interface EvidenceCollectedPayload { evidenceIds: string[]; coverage: number; source: string; summary: string }
export interface EvidenceCollectionFailedPayload { source: string; error: AgentError; missingEvidence: string[] }
export interface HypothesisUpdatedPayload {
  candidates: Array<{ summary: string; confidence: Confidence }>;
  evidenceIds: string[];
  missingEvidence: string[];
}
export interface DiagnosisCompletedPayload {
  outcome: DiagnosisOutcome; reportId: string; evidenceIds: string[]; limitations: string[];
}
export interface ActionProposedPayload {
  actionId: string; toolCallId: string; risk: RiskSeverity; expectedEffect: string;
}
export interface ActionExecutedPayload {
  actionId: string; result: JsonValue; idempotencyKey: string; uncertainty: boolean;
}
export interface ActionVerificationStartedPayload { actionId: string; verificationPlan: string }
export interface ActionVerificationCompletedPayload { actionId: string; observedEffect: string; evidenceIds: string[] }
export interface ActionVerificationFailedPayload { actionId: string; error: AgentError; requiredFollowup: string }

export interface ExecutionEventPayloadMap {
  TOOL_CALL_ADMISSION_UPDATED: ToolCallAdmissionUpdatedPayload;
  TOOL_CALL_REPAIR_STARTED: ToolCallRepairStartedPayload;
  TOOL_CALL_REPAIR_COMPLETED: ToolCallRepairCompletedPayload;
  TOOL_CALL_REPAIR_FAILED: ToolCallRepairFailedPayload;
  TOOL_CALL_REJECTED: ToolCallRejectedPayload;
  TOOL_CALL_CREATED: ToolCallCreatedPayload;
  TOOL_STARTED: ToolStartedPayload;
  TOOL_PROGRESS: ToolProgressPayload;
  TOOL_OUTPUT_DELTA: ToolOutputDeltaPayload;
  TOOL_RETRY_SCHEDULED: ToolRetryScheduledPayload;
  TOOL_RESULT: ToolResultPayload;
  TOOL_FAILED: ToolFailedPayload;
  TOOL_CANCELLED: ToolCancelledPayload;
  RISK_EVALUATED: RiskEvaluatedPayload;
  CONFIRMATION_REQUESTED: ConfirmationRequestedPayload;
  CONFIRMATION_RESOLVED: ConfirmationResolvedPayload;
  CONFIRMATION_EXPIRED: ConfirmationExpiredPayload;
  EXTERNAL_EXECUTION_REQUESTED: ExternalExecutionRequestedPayload;
  EXTERNAL_EXECUTION_RESOLVED: ExternalExecutionResolvedPayload;
  EXTERNAL_EXECUTION_UNCERTAIN: ExternalExecutionUncertainPayload;
  EVIDENCE_COLLECTION_STARTED: EvidenceCollectionStartedPayload;
  EVIDENCE_COLLECTED: EvidenceCollectedPayload;
  EVIDENCE_COLLECTION_FAILED: EvidenceCollectionFailedPayload;
  HYPOTHESIS_UPDATED: HypothesisUpdatedPayload;
  DIAGNOSIS_COMPLETED: DiagnosisCompletedPayload;
  ACTION_PROPOSED: ActionProposedPayload;
  ACTION_EXECUTED: ActionExecutedPayload;
  ACTION_VERIFICATION_STARTED: ActionVerificationStartedPayload;
  ACTION_VERIFICATION_COMPLETED: ActionVerificationCompletedPayload;
  ACTION_VERIFICATION_FAILED: ActionVerificationFailedPayload;
}

const agentErrorCodeSchema = z.enum([
  'ABORTED', 'BUDGET_EXCEEDED', 'CONFIRMATION_EXPIRED', 'INVALID_INPUT', 'LOOP_DETECTED', 'MODEL_ERROR', 'STORAGE_ERROR',
  'TOOL_ERROR', 'TOOL_NOT_FOUND', 'TOOL_ARGUMENTS_PARSE_FAILED', 'TOOL_ARGUMENTS_SCHEMA_INVALID',
  'TOOL_ARGUMENTS_SEMANTIC_INVALID', 'POLICY_DENIED', 'MCP_NETWORK_ERROR', 'MCP_TIMEOUT', 'MCP_RATE_LIMITED',
  'MCP_SERVER_ERROR', 'MCP_AUTH_ERROR', 'MCP_PROTOCOL_ERROR', 'CIRCUIT_OPEN', 'USER_REJECTED',
]);
const agentErrorSchema = z.object({ code: agentErrorCodeSchema, message: z.string(), retryable: z.boolean(), details: jsonMetadataSchema.optional() }).strict();
const toolCallSchema = z.object({ id: identifierSchema, name: identifierSchema, input: jsonMetadataSchema }).strict();
const toolResponseBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('json'), value: jsonValueSchema }).strict(),
  z.object({ type: z.literal('evidence_ref'), evidenceId: identifierSchema }).strict(),
  z.object({ type: z.literal('artifact'), uri: z.string(), mediaType: z.string().optional() }).strict(),
]);
const toolExecutionResultSchema = z.object({
  toolCallId: identifierSchema, toolName: identifierSchema,
  status: z.enum(['success', 'failed', 'timeout', 'aborted', 'interrupted', 'awaiting_external', 'skipped']),
  response: z.object({
    blocks: z.array(toolResponseBlockSchema), evidenceIds: z.array(identifierSchema).optional(),
    metadata: jsonMetadataSchema.optional(), isError: z.boolean().optional(),
  }).strict().optional(),
  error: agentErrorSchema.optional(), startedAt: timestampSchema, finishedAt: timestampSchema.optional(),
}).strict();
const findingSchema = z.object({
  ruleId: identifierSchema, severity: z.enum(['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  description: z.string(), toolName: identifierSchema, metadata: jsonMetadataSchema.optional(),
}).strict();
export const executionEventPayloadSchemaMap = {
  TOOL_CALL_ADMISSION_UPDATED: z.object({ gate: z.enum(['tool_existence', 'json_parse', 'schema_validation', 'semantic_validation']), outcome: z.enum(['passed', 'repaired', 'degraded', 'rejected']), attempt: z.number().int().positive(), errorCode: agentErrorCodeSchema.optional() }).strict(),
  TOOL_CALL_REPAIR_STARTED: z.object({ repairStrategy: z.string().min(1), correctionChainId: identifierSchema }).strict(),
  TOOL_CALL_REPAIR_COMPLETED: z.object({ strategy: z.string().min(1), changedPaths: z.array(z.string()), attempt: z.number().int().positive() }).strict(),
  TOOL_CALL_REPAIR_FAILED: z.object({ strategy: z.string().min(1), error: agentErrorSchema, nextAction: z.string().min(1) }).strict(),
  TOOL_CALL_REJECTED: z.object({ toolName: identifierSchema, gate: z.enum(['tool_existence', 'json_parse', 'schema_validation', 'semantic_validation']), error: agentErrorSchema }).strict(),
  TOOL_CALL_CREATED: z.object({ call: toolCallSchema, displayLabel: z.string().optional() }).strict(),
  TOOL_STARTED: z.object({ toolName: identifierSchema, source: identifierSchema, attempt: z.number().int().positive(), deadline: timestampSchema.optional() }).strict(),
  TOOL_PROGRESS: z.object({ progress: z.number().min(0).max(1), displaySummary: z.string() }).strict(),
  TOOL_OUTPUT_DELTA: z.object({ blockId: identifierSchema, textDelta: z.string().optional(), artifactProgress: jsonValueSchema.optional() }).strict(),
  TOOL_RETRY_SCHEDULED: z.object({ attempt: z.number().int().positive(), reasonCode: identifierSchema, delayMs: z.number().int().nonnegative() }).strict(),
  TOOL_RESULT: z.object({ result: toolExecutionResultSchema, durationMs: z.number().nonnegative(), evidenceIds: z.array(identifierSchema) }).strict(),
  TOOL_FAILED: z.object({ error: agentErrorSchema, attempt: z.number().int().positive(), retryable: z.boolean() }).strict(),
  TOOL_CANCELLED: z.object({ actor: identifierSchema, reason: z.string().min(1), partialArtifactIds: z.array(identifierSchema) }).strict(),
  RISK_EVALUATED: z.object({ findings: z.array(findingSchema), mergedRisk: z.enum(['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), policyVersion: identifierSchema }).strict(),
  CONFIRMATION_REQUESTED: z.object({ confirmationId: identifierSchema, toolCallIds: z.array(identifierSchema).min(1), riskSummary: z.string(), expiresAt: timestampSchema }).strict(),
  CONFIRMATION_RESOLVED: z.object({ decision: z.enum(['approved', 'rejected', 'expired', 'cancelled']), actor: identifierSchema, toolCallIds: z.array(identifierSchema).min(1), decidedAt: timestampSchema }).strict(),
  CONFIRMATION_EXPIRED: z.object({ confirmationId: identifierSchema, toolCallIds: z.array(identifierSchema).min(1), expiredAt: timestampSchema }).strict(),
  EXTERNAL_EXECUTION_REQUESTED: z.object({ requestId: identifierSchema, toolCallId: identifierSchema, interactionPayload: jsonMetadataSchema, expiresAt: timestampSchema }).strict(),
  EXTERNAL_EXECUTION_RESOLVED: z.object({ requestId: identifierSchema, resultBlock: toolResponseBlockSchema, externalExecutionType: identifierSchema }).strict(),
  EXTERNAL_EXECUTION_UNCERTAIN: z.object({ requestId: identifierSchema, reason: z.string().min(1), requiredVerification: z.string().min(1) }).strict(),
  EVIDENCE_COLLECTION_STARTED: z.object({ source: identifierSchema, queryWindow: z.string().min(1), planItemId: identifierSchema }).strict(),
  EVIDENCE_COLLECTED: z.object({ evidenceIds: z.array(identifierSchema).min(1), coverage: z.number().min(0).max(1), source: identifierSchema, summary: z.string() }).strict(),
  EVIDENCE_COLLECTION_FAILED: z.object({ source: identifierSchema, error: agentErrorSchema, missingEvidence: z.array(z.string()) }).strict(),
  HYPOTHESIS_UPDATED: z.object({ candidates: z.array(z.object({ summary: z.string(), confidence: z.enum(['low', 'medium', 'high']) }).strict()), evidenceIds: z.array(identifierSchema), missingEvidence: z.array(z.string()) }).strict(),
  DIAGNOSIS_COMPLETED: z.object({ outcome: z.enum(['confirmed', 'partial', 'inconclusive']), reportId: identifierSchema, evidenceIds: z.array(identifierSchema), limitations: z.array(z.string()) }).strict(),
  ACTION_PROPOSED: z.object({ actionId: identifierSchema, toolCallId: identifierSchema, risk: z.enum(['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), expectedEffect: z.string() }).strict(),
  ACTION_EXECUTED: z.object({ actionId: identifierSchema, result: jsonValueSchema, idempotencyKey: identifierSchema, uncertainty: z.boolean() }).strict(),
  ACTION_VERIFICATION_STARTED: z.object({ actionId: identifierSchema, verificationPlan: z.string() }).strict(),
  ACTION_VERIFICATION_COMPLETED: z.object({ actionId: identifierSchema, observedEffect: z.string(), evidenceIds: z.array(identifierSchema) }).strict(),
  ACTION_VERIFICATION_FAILED: z.object({ actionId: identifierSchema, error: agentErrorSchema, requiredFollowup: z.string().min(1) }).strict(),
} as const;

export type ExecutionEventPayloadSchemaMap = typeof executionEventPayloadSchemaMap;
export const executionEventPayloadSchemas = executionEventPayloadSchemaMap;
