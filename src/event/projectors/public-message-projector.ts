import { createHash } from 'node:crypto';
import type { AgentError } from '../../contracts/errors.js';
import type {
  AgentMessageV2,
  ContextSummaryMessageBlockV2,
  MessageBlockV2,
  ToolResultMessageBlockV2,
} from '../../contracts/message-v2/index.js';
import type { ContextSummary } from '../../contracts/message.js';
import type { JsonValue } from '../../contracts/common.js';
import type { ToolExecutionResult } from '../../contracts/tool.js';
import { projectGeneralMissingEvidenceCodes } from '../../contracts/missing-evidence.js';

const FORBIDDEN_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|system[-_]?prompt|raw[-_]?arguments)/i;
const FORBIDDEN_VALUE = /\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}/i;
const INTERNAL_ADDRESS = /(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w.-]*\.internal)(?::\d+)?(?:\/\S*)?/i;

/**
 * Projects persisted V2 messages into the user-facing transport shape.
 * This is deliberately stricter than the internal MessageStore shape: tool
 * responses, raw arguments, artifact locations and block metadata stay private.
 */
export class PublicMessageProjectorV2 {
  public project(message: AgentMessageV2): AgentMessageV2 | null {
    if (message.visibility === 'audit') return null;
    const blocks = message.blocks.flatMap((block) => {
      const projected = projectBlock(block);
      return projected === null ? [] : [projected];
    });
    return {
      schemaVersion: 2,
      id: safeIdentifier(message.id),
      runId: safeIdentifier(message.runId),
      ...(message.sessionId === undefined ? {} : { sessionId: safeIdentifier(message.sessionId) }),
      ...(message.replyId === undefined ? {} : { replyId: safeIdentifier(message.replyId) }),
      ...(message.stepId === undefined ? {} : { stepId: safeIdentifier(message.stepId) }),
      ...(message.parentMessageId === undefined ? {} : { parentMessageId: safeIdentifier(message.parentMessageId) }),
      role: message.role,
      status: message.status,
      visibility: message.visibility,
      blocks,
      createdAt: message.createdAt,
      ...(message.completedAt === undefined ? {} : { completedAt: message.completedAt }),
    };
  }
}

function projectBlock(block: MessageBlockV2): MessageBlockV2 | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', blockId: safeIdentifier(block.blockId), text: safeText(block.text) };
    case 'reasoning_summary':
      return { type: 'reasoning_summary', blockId: safeIdentifier(block.blockId), summary: safeText(block.summary) };
    case 'tool_call':
      return { type: 'tool_call', blockId: safeIdentifier(block.blockId), call: { id: safeIdentifier(block.call.id), name: safeIdentifier(block.call.name), input: {} } };
    case 'raw_tool_call':
      return null;
    case 'tool_result':
      return projectToolResult(block);
    case 'evidence_ref':
      return {
        type: 'evidence_ref',
        blockId: safeIdentifier(block.blockId),
        evidenceId: safeIdentifier(block.evidenceId),
        summary: safeText(block.summary),
        source: safeText(block.source),
        retrievable: block.retrievable,
      };
    case 'artifact_ref':
    case 'image_ref':
      return null;
    case 'context_summary':
      return projectContextSummary(block);
    case 'confirmation_request':
      return {
        type: 'confirmation_request', blockId: safeIdentifier(block.blockId), confirmationId: safeIdentifier(block.confirmationId),
        toolCallIds: block.toolCallIds.map(safeIdentifier), riskSummary: safeText(block.riskSummary), expiresAt: block.expiresAt,
      };
    case 'confirmation_result':
      return {
        type: 'confirmation_result', blockId: safeIdentifier(block.blockId), confirmationId: safeIdentifier(block.confirmationId),
        decision: block.decision, actor: safeText(block.actor), toolCallIds: block.toolCallIds.map(safeIdentifier), decidedAt: block.decidedAt,
      };
    case 'diagnosis':
      return {
        type: 'diagnosis', blockId: safeIdentifier(block.blockId), outcome: block.outcome,
        rootCauseCandidates: block.rootCauseCandidates.map((candidate) => ({ summary: safeText(candidate.summary), confidence: candidate.confidence })),
        evidenceIds: block.evidenceIds.map(safeIdentifier), missingEvidence: projectGeneralMissingEvidenceCodes(block.missingEvidence), limitations: block.limitations.map(safeText),
      };
    case 'action_proposal':
      return {
        type: 'action_proposal', blockId: safeIdentifier(block.blockId), actionId: safeIdentifier(block.actionId), toolCallId: safeIdentifier(block.toolCallId),
        risk: block.risk, expectedEffect: safeText(block.expectedEffect), verificationPlan: safeText(block.verificationPlan),
      };
    case 'action_result':
      return {
        type: 'action_result', blockId: safeIdentifier(block.blockId), actionId: safeIdentifier(block.actionId), toolCallId: safeIdentifier(block.toolCallId),
        result: sanitizeJson(block.result), idempotencyKey: safeIdentifier(block.idempotencyKey),
        verificationEvidenceIds: block.verificationEvidenceIds.map(safeIdentifier), uncertainty: block.uncertainty,
      };
    case 'error':
      return { type: 'error', blockId: safeIdentifier(block.blockId), error: projectError(block.error) };
  }
}

function projectToolResult(block: ToolResultMessageBlockV2): ToolResultMessageBlockV2 {
  const result: ToolExecutionResult = {
    toolCallId: safeIdentifier(block.result.toolCallId),
    toolName: safeIdentifier(block.result.toolName),
    status: block.result.status,
    ...(block.result.error === undefined ? {} : { error: projectError(block.result.error) }),
    startedAt: block.result.startedAt,
    ...(block.result.finishedAt === undefined ? {} : { finishedAt: block.result.finishedAt }),
  };
  return {
    type: 'tool_result', blockId: safeIdentifier(block.blockId), result,
    attempt: { attemptId: safeIdentifier(block.attempt.attemptId), number: block.attempt.number },
    evidenceIds: block.evidenceIds.map(safeIdentifier),
  };
}

function projectContextSummary(block: ContextSummaryMessageBlockV2): ContextSummaryMessageBlockV2 {
  const summary: ContextSummary = block.summary;
  return {
    type: 'context_summary',
    blockId: safeIdentifier(block.blockId),
    summary: {
      confirmedFacts: summary.confirmedFacts.map(safeText),
      hypotheses: summary.hypotheses.map(safeText),
      missingEvidence: projectGeneralMissingEvidenceCodes(summary.missingEvidence),
      pendingActionIds: summary.pendingActionIds.map(safeIdentifier),
      executedActionIds: summary.executedActionIds.map(safeIdentifier),
      unresolvedRisks: summary.unresolvedRisks.map(safeText),
      ...(summary.sourceMessageIds === undefined ? {} : { sourceMessageIds: summary.sourceMessageIds.map(safeIdentifier) }),
      ...(summary.keyToolCalls === undefined ? {} : { keyToolCalls: summary.keyToolCalls.map(safeIdentifier) }),
      ...(summary.evidenceIds === undefined ? {} : { evidenceIds: summary.evidenceIds.map(safeIdentifier) }),
      ...(summary.confirmationIds === undefined ? {} : { confirmationIds: summary.confirmationIds.map(safeIdentifier) }),
      ...(summary.riskRuleIds === undefined ? {} : { riskRuleIds: summary.riskRuleIds.map(safeIdentifier) }),
      ...(summary.summaryVersion === undefined ? {} : { summaryVersion: summary.summaryVersion }),
    },
  };
}

function projectError(error: AgentError): AgentError {
  return {
    code: error.code,
    message: safeText(error.message),
    retryable: error.retryable,
  };
}

function safeText(value: string): string {
  return FORBIDDEN_VALUE.test(value) || INTERNAL_ADDRESS.test(value) ? '[REDACTED]' : value.slice(0, 4_000);
}

function safeIdentifier(value: string): string {
  return FORBIDDEN_VALUE.test(value) || INTERNAL_ADDRESS.test(value)
    ? `redacted-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
    : value.length > 256
      ? `identifier-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
      : value;
}

function sanitizeJson(value: JsonValue): JsonValue {
  if (typeof value === 'string') return safeText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(sanitizeJson);
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    output[key] = sanitizeJson(item);
  }
  return output;
}
