import type { AgentContext } from './context.js';
import type { ToolCall, ToolExecutionResult, ToolKind } from './tool.js';

export interface CheckpointStore {
  load(runId: string): Promise<AgentContext | null>;
  save(context: AgentContext): Promise<void>;
  hasExecuted(call: ToolCall): Promise<boolean>;
  recordExecuted(call: ToolCall, result: ToolExecutionResult): Promise<void>;
}

export interface StoredRunCheckpoint {
  context: AgentContext;
  revision: number;
  savedAt: string;
  checksum: string;
}

/** Compare-and-set persistence contract used by durable runtimes. */
export interface VersionedCheckpointStore {
  load(runId: string): Promise<StoredRunCheckpoint | null>;
  save(context: AgentContext, expectedRevision: number | null): Promise<StoredRunCheckpoint>;
}

export class CheckpointConflictError extends Error {
  public readonly category = 'checkpoint_conflict';

  public constructor(
    public readonly runId: string,
    public readonly expectedRevision: number | null,
    public readonly actualRevision: number | null,
  ) {
    super(`checkpoint revision conflict for ${runId}`);
    this.name = 'CheckpointConflictError';
  }
}

export interface ToolExecutionRecord {
  toolCallId: string;
  runId: string;
  stepId: string;
  toolName: string;
  toolKind: ToolKind;
  inputDigest: string;
  state: 'prepared' | 'succeeded' | 'failed' | 'uncertain';
  result?: ToolExecutionResult;
  reasonCode?: string;
  preparedAt: string;
  finishedAt?: string;
}

export interface ToolExecutionJournal {
  prepare(record: ToolExecutionRecord): Promise<ToolExecutionRecord>;
  get(toolCallId: string): Promise<ToolExecutionRecord | null>;
}

export interface AgentStateUnitOfWork {
  commitToolResult(input: {
    expectedRevision: number;
    context: AgentContext;
    execution: ToolExecutionRecord;
    result: ToolExecutionResult;
  }): Promise<StoredRunCheckpoint>;
  markToolUncertain(input: {
    expectedRevision: number;
    context: AgentContext;
    execution: ToolExecutionRecord;
    reasonCode: string;
  }): Promise<StoredRunCheckpoint>;
}

/** Injected durable control-plane ports used by the Harness without infrastructure coupling. */
export interface DurableRunState {
  checkpoints: VersionedCheckpointStore;
  executions: ToolExecutionJournal;
  stateUnitOfWork: AgentStateUnitOfWork;
}

export interface EvidenceRecord {
  evidenceId: string;
  runId: string;
  source: 'metric' | 'log' | 'trace' | 'change';
  summary: Record<string, unknown>;
  raw: unknown;
  businessTraceIds: string[];
  capturedAt: string;
  toolCallId?: string;
  captureKey?: string;
  schemaVersion?: number;
  rawSha256?: string;
}

export interface EvidenceStore {
  save(record: EvidenceRecord): Promise<void>;
  get(evidenceId: string): Promise<EvidenceRecord | null>;
}

export interface EvidencePage {
  items: EvidenceRecord[];
  nextCursor?: string;
}

export interface EvidenceQueryStore {
  listByRun(runId: string, options?: { cursor?: string; limit?: number }): Promise<EvidencePage>;
}
