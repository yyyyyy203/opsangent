import { z } from 'zod';
import type { JsonValue } from '../common.js';
import { jsonMetadataSchema, timestampSchema } from '../message-v2/common.js';

type Identifier = string;
type ErrorCode =
  | 'MODEL_ERROR' | 'STORAGE_ERROR' | 'MCP_NETWORK_ERROR' | 'MCP_TIMEOUT' | 'MCP_RATE_LIMITED'
  | 'MCP_SERVER_ERROR' | 'MCP_AUTH_ERROR' | 'MCP_PROTOCOL_ERROR' | 'CIRCUIT_OPEN' | 'TIMEOUT' | 'UNAVAILABLE';

export type SubagentStage = 'triage' | 'evidence_collection' | 'hypothesis' | 'risk_gate' | 'action' | 'verification' | 'postmortem';
export type BudgetType = 'tokens' | 'milliseconds' | 'tool_calls' | 'evidence';
export type SubagentStatus = 'completed' | 'failed' | 'partial' | 'cancelled';
export type FallbackMode = 'reduced_scope' | 'cached' | 'readonly' | 'snapshot' | 'empty';
export type ErrorPayload = { code: ErrorCode; message: string; retryable: boolean; details?: Record<string, JsonValue> };

export interface SubsystemEventPayloadMap {
  LOOP_DETECTED: {
    level: 'warn' | 'hard' | 'force_break';
    repeatCount: number;
    toolName: Identifier;
    signatureDigest: Identifier;
    action: 'hint_injected' | 'signature_blocked' | 'run_terminated';
    stage: SubagentStage;
  };
  SUBAGENT_STARTED: {
    subagentType: Identifier; childRunId: Identifier; parentRunId: Identifier;
    budget: { type: BudgetType; limit: number; used: number };
  };
  SUBAGENT_PROGRESS: { childRunId: Identifier; stage: SubagentStage; displaySummary: string };
  SUBAGENT_RETRY_SCHEDULED: { childRunId: Identifier; attempt: number; reasonCode: Identifier };
  SUBAGENT_FALLBACK_ACTIVATED: { childRunId: Identifier; fallbackMode: FallbackMode; reasonCode: Identifier };
  SUBAGENT_COMPLETED: { childRunId: Identifier; status: SubagentStatus; evidenceIds: Identifier[]; coverage: number };
  SUBAGENT_FAILED: { childRunId: Identifier; error: ErrorPayload; partialEvidenceIds: Identifier[] };
  MCP_CONNECTION_STARTED: { serverId: Identifier; transport: 'stdio' | 'streamable_http' | 'sse'; attempt: number };
  MCP_CONNECTION_COMPLETED: { serverId: Identifier; capabilitySnapshotVersion: Identifier; durationMs: number };
  MCP_CONNECTION_FAILED: { serverId: Identifier; error: ErrorPayload; retryable: boolean };
  MCP_CONNECTION_DEGRADED: { serverId: Identifier; unavailableCapabilities: Identifier[]; fallback: FallbackMode };
  DATASOURCE_RETRY_SCHEDULED: { sourceId: Identifier; attempt: number; reasonCode: Identifier; delayMs: number };
  DATASOURCE_CIRCUIT_OPENED: { sourceId: Identifier; failureWindow: { failures: number; windowMs: number }; openUntil: string };
  DATASOURCE_CIRCUIT_HALF_OPENED: { sourceId: Identifier; probePolicy: 'single_probe' | 'limited_probe' };
  DATASOURCE_CIRCUIT_CLOSED: { sourceId: Identifier; recoveryEvidence: Identifier[] };
  DATASOURCE_FALLBACK_ACTIVATED: { sourceId: Identifier; fallbackSource?: Identifier; fallbackMode: FallbackMode; limitations: string[] };
  CONTEXT_COMPRESSION_STARTED: { level: 'L0' | 'L1' | 'L2'; reason: Identifier; beforeSize: number };
  CONTEXT_COMPRESSED: { level: 'L0' | 'L1' | 'L2'; before: number; after: number; offloadedEvidenceIds: Identifier[]; savedTokens: number };
  CONTEXT_COMPRESSION_FAILED: { level: 'L0' | 'L1' | 'L2'; error: ErrorPayload; fallbackPolicy: 'retain_previous' | 'defer' | 'abort' };
  CONTEXT_INTEGRITY_REPAIRED: { repairType: 'restore_tool_result' | 'restore_evidence_ref' | 'rebuild_summary'; affectedIds: Identifier[]; validationResult: 'valid' | 'invalid' };
  MEMORY_RETRIEVAL_STARTED: { scopes: Array<'working' | 'episodic' | 'semantic' | 'procedural'>; filters: Record<string, JsonValue>; limit: number };
  MEMORY_RETRIEVAL_COMPLETED: { hitCount: number; memoryIds: Identifier[]; durationMs: number };
  MEMORY_RETRIEVAL_FAILED: { error: ErrorPayload; fallbackPolicy: 'empty' | 'working_only' | 'abort' };
  MEMORY_UPDATE_SCHEDULED: { candidateType: 'experience' | 'episodic' | 'semantic' | 'procedural'; sourceRunId: Identifier };
  MEMORY_UPDATE_COMPLETED: { memoryId: Identifier; status: 'observation' | 'approved' | 'rejected'; eligibility: 'eligible' | 'not_eligible' };
  MEMORY_UPDATE_FAILED: { error: ErrorPayload; candidateId: Identifier };
  EXPERIENCE_CANDIDATE_CREATED: { candidateId: Identifier; evidenceIds: Identifier[]; qualityStatus: 'sufficient' | 'insufficient' | 'failed' };
  EXPERIENCE_REVIEWED: { candidateId: Identifier; decision: 'approved' | 'rejected'; reviewer: Identifier };
}


const id = z.string().min(1);
const error = z.object({
  code: z.enum(['MODEL_ERROR', 'STORAGE_ERROR', 'MCP_NETWORK_ERROR', 'MCP_TIMEOUT', 'MCP_RATE_LIMITED', 'MCP_SERVER_ERROR', 'MCP_AUTH_ERROR', 'MCP_PROTOCOL_ERROR', 'CIRCUIT_OPEN', 'TIMEOUT', 'UNAVAILABLE']),
  message: z.string(), retryable: z.boolean(), details: jsonMetadataSchema.optional(),
}).strict();
const budget = z.object({ type: z.enum(['tokens', 'milliseconds', 'tool_calls', 'evidence']), limit: z.number().finite().nonnegative(), used: z.number().finite().nonnegative() }).strict();
const commonStage = z.enum(['triage', 'evidence_collection', 'hypothesis', 'risk_gate', 'action', 'verification', 'postmortem']);
const fallback = z.enum(['reduced_scope', 'cached', 'readonly', 'snapshot', 'empty']);
const level = z.enum(['L0', 'L1', 'L2']);

export const subsystemEventPayloadSchemaMap = {
  LOOP_DETECTED: z.object({
    level: z.enum(['warn', 'hard', 'force_break']),
    repeatCount: z.number().int().positive(),
    toolName: id,
    signatureDigest: id,
    action: z.enum(['hint_injected', 'signature_blocked', 'run_terminated']),
    stage: commonStage,
  }).strict(),
  SUBAGENT_STARTED: z.object({ subagentType: id, childRunId: id, parentRunId: id, budget }).strict(),
  SUBAGENT_PROGRESS: z.object({ childRunId: id, stage: commonStage, displaySummary: z.string() }).strict(),
  SUBAGENT_RETRY_SCHEDULED: z.object({ childRunId: id, attempt: z.number().int().positive(), reasonCode: id }).strict(),
  SUBAGENT_FALLBACK_ACTIVATED: z.object({ childRunId: id, fallbackMode: fallback, reasonCode: id }).strict(),
  SUBAGENT_COMPLETED: z.object({ childRunId: id, status: z.enum(['completed', 'failed', 'partial', 'cancelled']), evidenceIds: z.array(id), coverage: z.number().finite().min(0).max(1) }).strict(),
  SUBAGENT_FAILED: z.object({ childRunId: id, error, partialEvidenceIds: z.array(id) }).strict(),
  MCP_CONNECTION_STARTED: z.object({ serverId: id, transport: z.enum(['stdio', 'streamable_http', 'sse']), attempt: z.number().int().positive() }).strict(),
  MCP_CONNECTION_COMPLETED: z.object({ serverId: id, capabilitySnapshotVersion: id, durationMs: z.number().int().nonnegative() }).strict(),
  MCP_CONNECTION_FAILED: z.object({ serverId: id, error, retryable: z.boolean() }).strict(),
  MCP_CONNECTION_DEGRADED: z.object({ serverId: id, unavailableCapabilities: z.array(id), fallback }).strict(),
  DATASOURCE_RETRY_SCHEDULED: z.object({ sourceId: id, attempt: z.number().int().positive(), reasonCode: id, delayMs: z.number().int().nonnegative() }).strict(),
  DATASOURCE_CIRCUIT_OPENED: z.object({ sourceId: id, failureWindow: z.object({ failures: z.number().int().nonnegative(), windowMs: z.number().int().nonnegative() }).strict(), openUntil: timestampSchema }).strict(),
  DATASOURCE_CIRCUIT_HALF_OPENED: z.object({ sourceId: id, probePolicy: z.enum(['single_probe', 'limited_probe']) }).strict(),
  DATASOURCE_CIRCUIT_CLOSED: z.object({ sourceId: id, recoveryEvidence: z.array(id) }).strict(),
  DATASOURCE_FALLBACK_ACTIVATED: z.object({ sourceId: id, fallbackSource: id.optional(), fallbackMode: fallback, limitations: z.array(z.string()) }).strict(),
  CONTEXT_COMPRESSION_STARTED: z.object({ level, reason: id, beforeSize: z.number().int().nonnegative() }).strict(),
  CONTEXT_COMPRESSED: z.object({ level, before: z.number().int().nonnegative(), after: z.number().int().nonnegative(), offloadedEvidenceIds: z.array(id), savedTokens: z.number().int().nonnegative() }).strict(),
  CONTEXT_COMPRESSION_FAILED: z.object({ level, error, fallbackPolicy: z.enum(['retain_previous', 'defer', 'abort']) }).strict(),
  CONTEXT_INTEGRITY_REPAIRED: z.object({ repairType: z.enum(['restore_tool_result', 'restore_evidence_ref', 'rebuild_summary']), affectedIds: z.array(id), validationResult: z.enum(['valid', 'invalid']) }).strict(),
  MEMORY_RETRIEVAL_STARTED: z.object({ scopes: z.array(z.enum(['working', 'episodic', 'semantic', 'procedural'])), filters: jsonMetadataSchema, limit: z.number().int().positive() }).strict(),
  MEMORY_RETRIEVAL_COMPLETED: z.object({ hitCount: z.number().int().nonnegative(), memoryIds: z.array(id), durationMs: z.number().int().nonnegative() }).strict(),
  MEMORY_RETRIEVAL_FAILED: z.object({ error, fallbackPolicy: z.enum(['empty', 'working_only', 'abort']) }).strict(),
  MEMORY_UPDATE_SCHEDULED: z.object({ candidateType: z.enum(['experience', 'episodic', 'semantic', 'procedural']), sourceRunId: id }).strict(),
  MEMORY_UPDATE_COMPLETED: z.object({ memoryId: id, status: z.enum(['observation', 'approved', 'rejected']), eligibility: z.enum(['eligible', 'not_eligible']) }).strict(),
  MEMORY_UPDATE_FAILED: z.object({ error, candidateId: id }).strict(),
  EXPERIENCE_CANDIDATE_CREATED: z.object({ candidateId: id, evidenceIds: z.array(id), qualityStatus: z.enum(['sufficient', 'insufficient', 'failed']) }).strict(),
  EXPERIENCE_REVIEWED: z.object({ candidateId: id, decision: z.enum(['approved', 'rejected']), reviewer: id }).strict(),
} as const;
