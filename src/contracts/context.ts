import type { AgentError } from './errors.js';
import type { SerializableInterrupt } from './hitl.js';
import type { AgentMessage } from './message.js';
import type { ToolCall, ToolExecutionResult } from './tool.js';

export type RunStatus = 'running' | 'awaiting_confirmation' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type DiagnosisStage = 'triage' | 'evidence_collection' | 'hypothesis' | 'risk_gate' | 'action' | 'verification' | 'postmortem';

export interface BudgetState {
  startedAt: string;
  maxIterations: number;
  iteration: number;
  maxToolCalls: number;
  toolCallsUsed: number;
  maxDurationMs: number;
}

/** Persisted execution plan for a Tool batch that has not reached a durable terminal state. */
export interface PendingToolBatch {
  batchId: string;
  stepId: string;
  calls: ToolCall[];
  completedResults: ToolExecutionResult[];
  state: 'admitted' | 'executing' | 'awaiting_confirmation' | 'awaiting_external';
  createdAt: string;
}

export interface AgentContext {
  runId: string;
  sessionId?: string;
  replyId?: string;
  streamId?: string;
  status: RunStatus;
  stage: DiagnosisStage;
  profileId: string;
  messages: AgentMessage[];
  pendingToolCalls: ToolCall[];
  /** Additive durable representation; legacy pendingToolCalls remains during migration. */
  pendingToolBatch?: PendingToolBatch;
  pendingInterrupt?: SerializableInterrupt;
  confirmedToolCallIds: string[];
  rejectedToolCallIds: string[];
  executedActions: ToolExecutionResult[];
  evidenceIds: string[];
  missingEvidence: string[];
  budget: BudgetState;
  contextVersion: number;
  /** Conservative V1: one model correction opportunity per tool per Run. */
  toolCorrections?: Record<string, { firstCallId: string; failures: number }>;
  admittedToolCallIds?: string[];
  networkAttemptBudget?: { remaining: number };
  failure?: AgentError;
}
