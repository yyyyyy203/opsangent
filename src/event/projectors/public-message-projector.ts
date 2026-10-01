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
      id: message.id,
      runId: message.runId,
      ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
      ...(message.replyId === undefined ? {} : { replyId: message.replyId }),
      ...(message.stepId === undefined ? {} : { stepId: message.stepId }),
      ...(message.parentMessageId === undefined ? {} : { parentMessageId: message.parentMessageId }),
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
      return { type: 'text', blockId: block.blockId, text: safeText(block.text) };
    case 'reasoning_summary':
      return { type: 'reasoning_summary', blockId: block.blockId, summary: safeText(block.summary) };
    case 'tool_call':
      return { type: 'tool_call', blockId: block.blockId, call: { id: block.call.id, name: block.call.name, input: {} } };
    case 'raw_tool_call':
      return null;
    case 'tool_result':
      return projectToolResult(block);
    case 'evidence_ref':
      return {
        type: 'evidence_ref',
        blockId: block.blockId,
        evidenceId: block.evidenceId,
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
        type: 'confirmation_request', blockId: block.blockId, confirmationId: block.confirmationId,
        toolCallIds: [...block.toolCallIds], riskSummary: safeText(block.riskSummary), expiresAt: block.expiresAt,
      };
    case 'confirmation_result':
      return {
        type: 'confirmation_result', blockId: block.blockId, confirmationId: block.confirmationId,
        decision: block.decision, actor: safeText(block.actor), toolCallIds: [...block.toolCallIds], decidedAt: block.decidedAt,
      };
    case 'diagnosis':
      return {
        type: 'diagnosis', blockId: block.blockId, outcome: block.outcome,
        rootCauseCandidates: block.rootCauseCandidates.map((candidate) => ({ summary: safeText(candidate.summary), confidence: candidate.confidence })),
        evidenceIds: [...block.evidenceIds], missingEvidence: block.missingEvidence.map(safeText), limitations: block.limitations.map(safeText),
      };
    case 'action_proposal':
      return {
        type: 'action_proposal', blockId: block.blockId, actionId: block.actionId, toolCallId: block.toolCallId,
        risk: block.risk, expectedEffect: safeText(block.expectedEffect), verificationPlan: safeText(block.verificationPlan),
      };
    case 'action_result':
      return {
        type: 'action_result', blockId: block.blockId, actionId: block.actionId, toolCallId: block.toolCallId,
        result: sanitizeJson(block.result), idempotencyKey: block.idempotencyKey,
        verificationEvidenceIds: [...block.verificationEvidenceIds], uncertainty: block.uncertainty,
      };
    case 'error':
      return { type: 'error', blockId: block.blockId, error: projectError(block.error) };
  }
}

function projectToolResult(block: ToolResultMessageBlockV2): ToolResultMessageBlockV2 {
  const result: ToolExecutionResult = {
    toolCallId: block.result.toolCallId,
    toolName: block.result.toolName,
    status: block.result.status,
    ...(block.result.error === undefined ? {} : { error: projectError(block.result.error) }),
    startedAt: block.result.startedAt,
    ...(block.result.finishedAt === undefined ? {} : { finishedAt: block.result.finishedAt }),
  };
  return {
    type: 'tool_result', blockId: block.blockId, result,
    attempt: { attemptId: block.attempt.attemptId, number: block.attempt.number },
    evidenceIds: [...block.evidenceIds],
  };
}

function projectContextSummary(block: ContextSummaryMessageBlockV2): ContextSummaryMessageBlockV2 {
  const summary: ContextSummary = block.summary;
  return {
    type: 'context_summary',
    blockId: block.blockId,
    summary: {
      confirmedFacts: summary.confirmedFacts.map(safeText),
      hypotheses: summary.hypotheses.map(safeText),
      missingEvidence: summary.missingEvidence.map(safeText),
      pendingActionIds: [...summary.pendingActionIds],
      executedActionIds: [...summary.executedActionIds],
      unresolvedRisks: summary.unresolvedRisks.map(safeText),
      ...(summary.sourceMessageIds === undefined ? {} : { sourceMessageIds: [...summary.sourceMessageIds] }),
      ...(summary.keyToolCalls === undefined ? {} : { keyToolCalls: [...summary.keyToolCalls] }),
      ...(summary.evidenceIds === undefined ? {} : { evidenceIds: [...summary.evidenceIds] }),
      ...(summary.confirmationIds === undefined ? {} : { confirmationIds: [...summary.confirmationIds] }),
      ...(summary.riskRuleIds === undefined ? {} : { riskRuleIds: [...summary.riskRuleIds] }),
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
