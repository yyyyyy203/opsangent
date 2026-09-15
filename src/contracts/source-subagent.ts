import type {
  EventFactoryV2Like,
  EventPublisherV2Like,
} from './event-publisher.js';
import type { IdGenerator } from './common.js';
import type {
  Tool,
  ToolResponseChunk,
} from './tool.js';

export type SourceSubagentType = 'metrics' | 'logs' | 'traces';
export type SourceSubagentStatus = 'complete' | 'partial' | 'unavailable';
export type SourceFindingKind = 'observation' | 'inference';

export interface SourceFinding {
  kind: SourceFindingKind;
  statement: string;
  evidenceIds: string[];
}

export interface SourceSubagentRequest {
  profileId: string;
  service: string;
  start: string;
  end: string;
  question: string;
  evidenceIds: string[];
}

export interface SourceSubagentResult {
  source: SourceSubagentType;
  status: SourceSubagentStatus;
  summary: string;
  findings: SourceFinding[];
  evidenceIds: string[];
  businessTraceIds: string[];
  missingEvidence: string[];
  coverage: number;
  toolCallsUsed: number;
  durationMs: number;
}

export interface SourceSubagentExecution {
  parentRunId: string;
  parentToolCallId: string;
  parentStepId: string;
  childRunId: string;
  profileId: string;
  profileRevision?: string;
  sessionId?: string;
  replyId?: string;
  streamId?: string;
  deadline?: number;
  signal: AbortSignal;
  toolCallBudget?: { remaining: number };
  networkAttemptBudget?: { remaining: number };
  remainingToolCalls?: number;
}

export interface SourceSubagentRunner {
  run(
    request: SourceSubagentRequest,
    execution: SourceSubagentExecution,
  ): AsyncGenerator<ToolResponseChunk, SourceSubagentResult>;
}

export interface SourceSubagentRetryPolicy {
  maxAttempts: number;
  shouldRetry: (error: unknown) => boolean;
  delayMs: (attempt: number) => number;
  sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface SubagentLifecyclePorts {
  factory: EventFactoryV2Like;
  publisher: EventPublisherV2Like;
  ids: IdGenerator;
  correlationId: (runId: string) => string;
}

export interface SourceSubagentDescriptor {
  publicToolName: string;
  subagentType: SourceSubagentType;
  description: string;
  inputSchema: Tool['inputSchema'];
  runner: SourceSubagentRunner;
  childRunId: (execution: Omit<SourceSubagentExecution, 'childRunId'>) => string;
  maxAttempts?: number;
  retry?: SourceSubagentRetryPolicy;
  lifecycle?: SubagentLifecyclePorts;
  /** Host-side ownership check for evidence IDs supplied as investigation hints. */
  validateEvidenceIds?: (evidenceIds: readonly string[], input: {
    parentRunId: string;
    profileId: string;
  }) => Promise<void>;
}

export function canonicalSourceToolName(source: SourceSubagentType): string {
  switch (source) {
    case 'metrics': return 'metrics_subagent';
    case 'logs': return 'logs_subagent';
    case 'traces': return 'traces_subagent';
  }
}
