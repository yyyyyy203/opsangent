import type { ToolCall, ToolExecutionResult, RawToolCall } from './tool.js';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'raw_tool_call'; call: RawToolCall }
  | { type: 'tool_result'; result: ToolExecutionResult }
  | { type: 'context_summary'; summary: ContextSummary };

export interface ContextSummary {
  confirmedFacts: string[];
  hypotheses: string[];
  missingEvidence: string[];
  pendingActionIds: string[];
  executedActionIds: string[];
  unresolvedRisks: string[];
  sourceMessageIds?: string[];
  keyToolCalls?: string[];
  evidenceIds?: string[];
  confirmationIds?: string[];
  riskRuleIds?: string[];
  summaryVersion?: number;
}

export interface AgentMessage {
  id: string;
  role: MessageRole;
  blocks: MessageBlock[];
  createdAt: string;
}
