import type { Clock } from './common.js';
import type { AgentContext } from './context.js';
import type { AgentMessage } from './message.js';
import type { PendingAgentEventV2 } from './event-store.js';
import type { AgentEventPayloadMap, AgentEventTypeV2 } from './event-v2/index.js';

export interface MemoryScopeBase {
  profileId: string;
  profileRevision: string;
  serviceId: string;
  faultType: string;
  targetFingerprint: string;
}
export type MemoryScope = MemoryScopeBase & (
  | { environment: 'simulation' | 'development' | 'staging';
      dataClass: 'simulated'; datasetId: string }
  | { environment: 'development' | 'staging' | 'production'; dataClass: 'live' }
);
export type MemoryQuality = 'sufficient' | 'insufficient' | 'failed';
export type MemoryStatus = 'observation' | 'approved' | 'rejected';
export type MemoryCaptureMode = 'manual' | 'automatic' | 'skip';
export interface MemoryPreferences {
  capture?: 'profile' | MemoryCaptureMode;
  recall?: 'profile' | 'enabled' | 'disabled';
}
export interface RunMemoryControl {
  schemaVersion: 1;
  scope: MemoryScope;
  profilePolicyRevision: string;
  capture: MemoryCaptureMode;
  recall: boolean;
}
export type DiagnosticMemoryConfig =
  | { enabled: false }
  | { enabled: true; profiles: readonly {
      scope: MemoryScope; profilePolicyRevision: string;
      captureDefault: MemoryCaptureMode; recallDefault: boolean;
      allowAutomaticCapture: boolean; allowRecall: boolean;
    }[]; requiredSources: readonly HistoricalEvidenceRef['source'][];
    modelWindowTokens: number; reservedOutputTokens: number };
export interface MemoryCapabilities {
  enabled: boolean;
  kind: 'episodic';
  reviewMode: 'local_operator';
  manualCapture: boolean;
  automaticCapture: boolean;
  recall: boolean;
  defaults: { capture: MemoryCaptureMode; recall: boolean };
  vectorExperiment: 'separate';
}
export interface MemoryPolicyPort {
  allows(control: RunMemoryControl, capability: 'capture' | 'recall'): boolean;
}

export interface HistoricalEvidenceRef {
  evidenceId: string;
  ownerRunId: string;
  source: 'metric' | 'log' | 'trace' | 'change';
  capturedAt: string;
  rawSha256: string;
}
export interface DiagnosticMemoryCase {
  schemaVersion: 1;
  id: string;
  revision: number;
  extractorVersion: 'episodic-v1';
  scope: MemoryScope;
  sourceRunId: string;
  sourceRunStatus: 'completed' | 'failed' | 'cancelled';
  capturedAt: string;
  validUntil: string;
  status: MemoryStatus;
  quality: MemoryQuality;
  summary: string;
  symptomCodes: readonly string[];
  limitations: readonly string[];
  evidenceRefs: readonly HistoricalEvidenceRef[];
  diagnosisOnly: true;
  eligibleForPromotion: boolean;
  digest: string;
}
export interface MemoryHint {
  memoryId: string;
  revision: number;
  digest: string;
  sourceRunId: string;
  capturedAt: string;
  validUntil: string;
  summary: string;
  limitations: readonly string[];
  evidenceRefs: readonly HistoricalEvidenceRef[];
  diagnosisOnly: true;
}
export interface MemorySelection {
  memoryId: string;
  revision: number;
  digest: string;
}
export interface RunMemoryState {
  schemaVersion: 1;
  scope: MemoryScope;
  selectionState: 'unselected' | 'selected';
  availability: 'ready' | 'empty' | 'unavailable';
  selections: readonly MemorySelection[];
  hints: readonly MemoryHint[];
  selectedAt?: string;
  validatedAt?: string;
  reasonCode?: MemoryErrorCode;
}
export type MemoryErrorCode =
  | 'MEMORY_SCOPE_INVALID' | 'MEMORY_DATA_INVALID'
  | 'MEMORY_REVISION_CONFLICT' | 'MEMORY_REQUEST_CONFLICT'
  | 'MEMORY_APPROVAL_DENIED' | 'MEMORY_EVIDENCE_UNAVAILABLE'
  | 'MEMORY_SOURCE_CONFLICT' | 'MEMORY_RUN_NOT_TERMINAL' | 'MEMORY_POLICY_DENIED'
  | 'MEMORY_CAPACITY_EXCEEDED' | 'MEMORY_LOOKUP_FAILED'
  | 'MEMORY_CAPTURE_FAILED' | 'MEMORY_DISABLED';
export interface MemoryOperation {
  now: string;
  signal?: AbortSignal;
  deadlineMs: number;
  availableMemoryTokens?: number;
  clock?: Clock;
}
export interface MemorySearch {
  scope: MemoryScope;
  text: string;
  excludeRunIds: readonly string[];
  limit: number;
  now: string;
}
export interface MemoryQueryStore {
  get(id: string, scope: MemoryScope): Promise<DiagnosticMemoryCase | null>;
  getCapture(input: { runId: string; scope: MemoryScope }): Promise<MemoryCaptureTicket | null>;
  findCaptureResult(command: MemoryManualCaptureCommand): Promise<MemoryCaptureTicket | null>;
  findReviewResult(command: MemoryReviewCommand): Promise<DiagnosticMemoryCase | null>;
  list(input: { scope: MemoryScope; status?: MemoryStatus;
    afterId?: string; limit: number }): Promise<readonly DiagnosticMemoryCase[]>;
  search(input: MemorySearch): Promise<readonly DiagnosticMemoryCase[]>;
  revalidate(input: { scope: MemoryScope; selections: readonly MemorySelection[];
    now: string }): Promise<readonly DiagnosticMemoryCase[]>;
}
export interface MemoryRecallPort {
  prepare(input: { runId: string; text: string; state: RunMemoryState },
    operation: MemoryOperation): Promise<RunMemoryState>;
}
export interface MemoryHintRenderer {
  render(state: RunMemoryState, operation: MemoryOperation): AgentMessage | null;
}
export interface MemoryCaptureRequest {
  candidateId: string;
  sourceRunId: string;
  scope: MemoryScope;
  extractorVersion: 'episodic-v1';
  origin: 'automatic' | 'manual';
  requestId: string;
  sourceRunStatus: 'completed' | 'failed' | 'cancelled';
  sourceContextVersion: number;
  sourceCheckpointChecksum: string;
  requiredSources: readonly HistoricalEvidenceRef['source'][];
  requestedAt: string;
}
export interface MemoryCaptureIntent {
  request: MemoryCaptureRequest;
  scheduledEvent: PendingAgentEventV2<'MEMORY_UPDATE_SCHEDULED'>;
  rejectedEvent: PendingAgentEventV2<'MEMORY_UPDATE_FAILED'>;
  failedEvent: PendingAgentEventV2<'MEMORY_UPDATE_FAILED'>;
}
export interface MemoryJobClaim {
  request: MemoryCaptureRequest;
  attempt: number;
  ownerId: string;
  leaseUntil: string;
}
export interface MemoryCaptureTicket {
  sourceRunId: string;
  state: 'not_saved' | 'queued' | 'running' | 'saved' | 'failed' | 'unavailable';
  sourceCheckpointRevision?: number;
  candidateId?: string;
  memoryId?: string;
  reasonCode?: MemoryErrorCode;
}
export interface MemoryManualCaptureCommand {
  sourceRunId: string;
  scope: MemoryScope;
  expectedCheckpointRevision: number;
  requestId: string;
  actorId: string;
  requestedAt: string;
}
export interface MemoryCapturePort {
  capture(command: MemoryManualCaptureCommand,
    operation: MemoryOperation): Promise<MemoryCaptureTicket>;
}
export interface MemoryReviewCommand {
  memoryId: string;
  scope: MemoryScope;
  expectedRevision: number;
  requestId: string;
  decision: 'approved' | 'rejected';
  claimCheck: 'supported' | 'unsupported';
  actorId: string;
  reviewedAt: string;
}
export interface MemoryWriteUnitOfWork {
  enqueueManualCapture(input: { command: MemoryManualCaptureCommand;
    intent: MemoryCaptureIntent }): Promise<MemoryCaptureTicket>;
  claimNext(input: { ownerId: string; now: string; leaseUntil: string;
    maxAttempts: number }): Promise<MemoryJobClaim | null>;
  completeCapture(input: { claim: MemoryJobClaim; candidate: DiagnosticMemoryCase;
    now: string; events: readonly PendingAgentEventV2[] }): Promise<DiagnosticMemoryCase>;
  failCapture(input: { claim: MemoryJobClaim; now: string; code: MemoryErrorCode;
    events: readonly PendingAgentEventV2[] }): Promise<void>;
  review(input: { command: MemoryReviewCommand; now: string;
    events: readonly PendingAgentEventV2[] }): Promise<DiagnosticMemoryCase>;
}
export interface MemoryCaptureSource {
  inspect(runId: string, operation: MemoryOperation): Promise<{
    context: AgentContext; checkpointRevision: number;
    checkpointChecksum: string; isParent: boolean;
  } | null>;
  load(request: MemoryCaptureRequest, operation: MemoryOperation): Promise<{
    context: AgentContext;
    evidenceRefs: readonly HistoricalEvidenceRef[];
    requiredEvidenceComplete: boolean;
    limitations: readonly string[];
  }>;
}
/** Adapter over the host's single V2 event factory; memory does not own an event source. */
export interface MemoryEventFactory {
  create<T extends AgentEventTypeV2>(type: T, runId: string,
    payload: AgentEventPayloadMap[T]): PendingAgentEventV2<T>;
}
export interface MemoryMaintenance {
  prune(input: { now: string; limit: number }): Promise<{
    expiredObservations: number; signalsRemoved: number;
  }>;
}
export interface MemoryCaptureWorkerPort {
  drain(input: { limit: number; signal?: AbortSignal }): Promise<{
    completed: number; failed: number; pending: boolean;
  }>;
  close(): Promise<void>;
}
export interface MemoryReviewPort {
  review(command: MemoryReviewCommand,
    operation: MemoryOperation): Promise<DiagnosticMemoryCase>;
}
export interface MemoryEvidenceValidator {
  validate(input: { sourceRunId: string; refs: readonly HistoricalEvidenceRef[]; scope: MemoryScope },
    operation: MemoryOperation): Promise<boolean>;
}
export interface MemoryReviewServiceOptions {
  queries: MemoryQueryStore;
  writes: MemoryWriteUnitOfWork;
  evidence: MemoryEvidenceValidator;
  events: MemoryEventFactory;
  dispatch: () => Promise<void>;
}
export interface MemoryReadServicePort {
  capabilities(profileId: string): MemoryCapabilities;
  list(profileId: string, input: { status?: MemoryStatus; afterId?: string;
    limit: number }): Promise<readonly DiagnosticMemoryCase[]>;
  get(profileId: string, id: string): Promise<DiagnosticMemoryCase | null>;
  getRun(runId: string): Promise<RunMemoryState | null>;
  getCapture(runId: string): Promise<MemoryCaptureTicket>;
}
export interface DiagnosticMemoryRuntime {
  profiles: Extract<DiagnosticMemoryConfig, { enabled: true }>['profiles'];
  policy: MemoryPolicyPort;
  requiredSources: readonly HistoricalEvidenceRef['source'][];
  modelWindowTokens: number;
  reservedOutputTokens: number;
  recall: MemoryRecallPort;
  renderer: MemoryHintRenderer;
  worker: MemoryCaptureWorkerPort;
  capture: MemoryCapturePort;
  reviews: MemoryReviewPort;
  queries: MemoryReadServicePort;
  close(): Promise<void>;
}
