import { z } from 'zod';
import type { AgentContext } from './context.js';
import type { AgentMessage, ContextSummary } from './message.js';

const identifier = z.string().min(1).max(256);
const summaryText = z.string().max(4_096);
const boundedTextList = z.array(summaryText).max(128);
const boundedIdentifierList = z.array(identifier).max(512);

export const structuredHistorySummarySchema = z.object({
  confirmedFacts: boundedTextList,
  hypotheses: boundedTextList,
  missingEvidence: boundedTextList,
  pendingActionIds: boundedIdentifierList,
  executedActionIds: boundedIdentifierList,
  unresolvedRisks: boundedTextList,
  sourceMessageIds: boundedIdentifierList,
  keyToolCalls: boundedIdentifierList,
  evidenceIds: boundedIdentifierList,
  confirmationIds: boundedIdentifierList,
  riskRuleIds: boundedIdentifierList,
  summaryVersion: z.number().int().positive(),
}).strict();

export type StructuredHistorySummary = z.infer<typeof structuredHistorySummarySchema>;

export function parseStructuredHistorySummary(input: unknown): StructuredHistorySummary {
  return structuredHistorySummarySchema.parse(input);
}

export interface HistorySummaryInput {
  runId: string;
  context: AgentContext;
  sourceMessageIds: readonly string[];
  messages: readonly AgentMessage[];
  previousSummary?: ContextSummary;
  allowedMessageIds: readonly string[];
  allowedToolCallIds: readonly string[];
  allowedEvidenceIds: readonly string[];
  allowedConfirmationIds: readonly string[];
  allowedRiskRuleIds: readonly string[];
}

export interface CompressionTrace {
  sourceMessageIds: string[];
  protectedMessageIds: string[];
  keyToolCalls: string[];
  evidenceIds: string[];
  summaryVersion: number;
  beforeBytes?: number;
  afterBytes?: number;
  savedBytes?: number;
  offloadedEvidenceIds?: string[];
}

export type CompressionValidationStatus = 'valid' | 'repaired' | 'summary_fallback' | 'failed';
export type CompressionRepairType = 'restore_tool_result' | 'restore_evidence_ref' | 'rebuild_summary';

export interface CompressionValidationResult {
  status: CompressionValidationStatus;
  valid: boolean;
  repairable?: boolean;
  reasonCode?: string;
  affectedIds?: string[];
  repairType?: CompressionRepairType;
  repairedContext?: AgentContext;
}
