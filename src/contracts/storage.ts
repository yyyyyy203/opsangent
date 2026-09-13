import type { AgentContext } from './context.js';
import type { JsonValue } from './common.js';
import type { GovernanceEffect } from './hooks.js';
import type { PendingAgentEventV2 } from './event-store.js';
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

export type DurableExecutionTransition =
  | { kind: 'completed'; record: ToolExecutionRecord; result: ToolExecutionResult }
  | { kind: 'uncertain'; record: ToolExecutionRecord; reasonCode: string };

/** Couples a checkpoint/execution transition with the durable facts that describe it. */
export interface DurableTransitionUnitOfWork {
  commit(input: {
    expectedRevision: number | null;
    context: AgentContext;
    execution?: DurableExecutionTransition;
    outboxEvents: readonly PendingAgentEventV2[];
    /** Observer effects are committed with the same transition when supported. */
    governanceEffects?: readonly GovernanceEffect[];
  }): Promise<StoredRunCheckpoint>;
}

export interface DurableOutboxRecord {
  event: PendingAgentEventV2;
  enqueuedAt: string;
  publishedAt?: string;
}

/** Durable post-commit event queue. Publishers must mark entries only after EventStore append succeeds. */
export interface DurableEventOutbox {
  enqueue(input: {
    events: readonly PendingAgentEventV2[];
    createdAt: string;
  }): Promise<readonly DurableOutboxRecord[]>;
  listPending(input: { runId?: string; limit: number }): Promise<readonly DurableOutboxRecord[]>;
  markPublished(input: { eventId: string; publishedAt: string }): Promise<void>;
}

/** Injected durable control-plane ports used by the Harness without infrastructure coupling. */
export interface DurableRunState {
  checkpoints: VersionedCheckpointStore;
  executions: ToolExecutionJournal;
  stateUnitOfWork: AgentStateUnitOfWork;
  transitions: DurableTransitionUnitOfWork;
  outbox: DurableEventOutbox;
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

export type StreamingEvidenceSource = 'log' | 'trace';
export type EvidenceManifestState = 'pending' | 'committed' | 'partial' | 'failed' | 'deleting';

export interface NormalizedLogRecord {
  timestamp: string;
  service?: string;
  level?: string;
  message?: string;
  exception?: string;
  traceId?: string;
  fields?: Record<string, JsonValue>;
}

export interface EvidenceSourcePage {
  records: readonly NormalizedLogRecord[];
  encodedBytes: number;
  nextCursor?: string;
  sourceSnapshotId?: string;
}

export interface EvidenceCaptureBudget {
  maxSourceBytes: number;
  maxRecords: number;
  maxDurationMs: number;
  maxModelSummaryBytes: number;
  maxSamples: number;
}

export interface EvidenceCount {
  value: string;
  count: number;
}

/** Deterministic, bounded and model-safe aggregation of a streaming capture. */
export interface EvidenceSummary {
  recordCount: number;
  sourceBytes: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  levels: readonly EvidenceCount[];
  services: readonly EvidenceCount[];
  exceptionSignatures: readonly EvidenceCount[];
  traceIds: readonly string[];
  samples: readonly NormalizedLogRecord[];
}

/** Internal Blob reference. storageKey must never cross the model/public boundary. */
export interface EvidenceChunkRef {
  manifestId: string;
  evidenceId: string;
  chunkIndex: number;
  storageKey: string;
  recordCount: number;
  sourceBytes: number;
  storedBytes: number;
  sha256: string;
  firstCapturedAt?: string;
  lastCapturedAt?: string;
  committedAt: string;
}

export interface EvidenceBlobDescriptor {
  manifestId: string;
  evidenceId: string;
  captureKey: string;
  compression: 'gzip_ndjson';
  sourceBytes: number;
  storedBytes: number;
  rawSha256: string;
  chunks: readonly EvidenceChunkRef[];
}

export interface BeginEvidenceBlobInput {
  manifestId: string;
  evidenceId: string;
  captureKey: string;
  source: StreamingEvidenceSource;
  chunkIndex: number;
  chunkTargetBytes: number;
  recordCount?: number;
  firstCapturedAt?: string;
  lastCapturedAt?: string;
}

export interface EvidenceBlobWriter {
  write(chunk: Uint8Array, options?: { signal?: AbortSignal }): Promise<void>;
  commit(): Promise<EvidenceBlobDescriptor>;
  abort(reasonCode: string): Promise<void>;
}

export interface EvidenceBlobStore {
  begin(input: BeginEvidenceBlobInput): Promise<EvidenceBlobWriter>;
  readChunk(ref: EvidenceChunkRef): AsyncIterable<Uint8Array>;
  delete(ref: EvidenceBlobDescriptor): Promise<void>;
}

export interface CreateEvidenceManifestInput {
  manifestId: string;
  evidenceId: string;
  runId: string;
  stepId: string;
  toolCallId: string;
  captureKey: string;
  source: StreamingEvidenceSource;
  queryDigest: string;
  timeRange: { start: string; end: string };
  compression: 'gzip_ndjson';
  redactionPolicyVersion: string;
  createdAt: string;
  retentionUntil?: string;
}

export interface RecordEvidenceManifestChunkInput {
  evidenceId: string;
  chunk: EvidenceChunkRef;
  nextCursor?: string;
  sourceSnapshotId?: string;
  updatedAt: string;
}

export interface CommitEvidenceManifestInput {
  evidenceId: string;
  descriptor: EvidenceBlobDescriptor;
  summary: EvidenceSummary;
  coverage: number;
  truncated: boolean;
  missingEvidence: readonly string[];
  updatedAt: string;
  committedAt: string;
}

export interface FailEvidenceManifestInput {
  evidenceId: string;
  reasonCode: string;
  updatedAt: string;
}

export interface EvidenceManifestSummary {
  manifestId: string;
  evidenceId: string;
  runId: string;
  stepId: string;
  toolCallId: string;
  captureKey: string;
  source: StreamingEvidenceSource;
  state: 'committed' | 'partial';
  queryDigest: string;
  timeRange: { start: string; end: string };
  recordCount: number;
  sourceBytes: number;
  storedBytes: number;
  chunkCount: number;
  rawSha256: string;
  compression: 'gzip_ndjson';
  coverage: number;
  truncated: boolean;
  missingEvidence: readonly string[];
  redactionPolicyVersion: string;
  createdAt: string;
  updatedAt: string;
  sourceSnapshotId?: string;
  nextCursor?: string;
  retentionUntil?: string;
  committedAt?: string;
}

/** Internal control-plane representation; its chunks are never model-facing. */
export interface EvidenceManifest extends Omit<EvidenceManifestSummary, 'state'> {
  state: EvidenceManifestState;
  chunks: readonly EvidenceChunkRef[];
  summary?: EvidenceSummary;
  failureReasonCode?: string;
}

export interface EvidenceManifestStore {
  createPending(input: CreateEvidenceManifestInput): Promise<EvidenceManifest>;
  recordChunk(input: RecordEvidenceManifestChunkInput): Promise<EvidenceManifest>;
  commit(input: CommitEvidenceManifestInput): Promise<EvidenceManifest>;
  markFailed(input: FailEvidenceManifestInput): Promise<EvidenceManifest>;
  get(evidenceId: string): Promise<EvidenceManifest | null>;
  getVisible(evidenceId: string): Promise<EvidenceManifestSummary | null>;
}

export interface StreamingEvidenceCaptureRequest {
  evidenceId: string;
  runId: string;
  stepId: string;
  toolCallId: string;
  captureKey: string;
  source: StreamingEvidenceSource;
  queryDigest: string;
  timeRange: { start: string; end: string };
  pages: AsyncIterable<EvidenceSourcePage>;
  budget: EvidenceCaptureBudget;
}

export interface EvidenceCaptureResult {
  evidenceId: string;
  summary: EvidenceSummary;
  manifest: EvidenceManifestSummary;
  coverage: number;
  truncated: boolean;
  missingEvidence: readonly string[];
}

export interface StreamingEvidenceRecorder {
  capture(
    request: StreamingEvidenceCaptureRequest,
    options?: { signal?: AbortSignal },
  ): Promise<EvidenceCaptureResult>;
}

export function assertEvidenceCaptureBudget(budget: EvidenceCaptureBudget): void {
  assertPositiveSafeInteger(budget.maxSourceBytes, 'maxSourceBytes');
  assertPositiveSafeInteger(budget.maxRecords, 'maxRecords');
  assertPositiveSafeInteger(budget.maxDurationMs, 'maxDurationMs');
  assertPositiveSafeInteger(budget.maxModelSummaryBytes, 'maxModelSummaryBytes');
  if (!Number.isSafeInteger(budget.maxSamples) || budget.maxSamples < 0) {
    throw new RangeError('maxSamples must be a non-negative safe integer');
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(name + ' must be a positive safe integer');
}
