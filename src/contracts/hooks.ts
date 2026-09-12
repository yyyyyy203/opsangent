import type { AgentErrorCode } from './errors.js';
import type { SerializableInterrupt } from './hitl.js';
import type { RiskSeverity, ToolExecutionStatus, ToolKind, ToolSource } from './tool.js';

/** The coarse boundary at which a tool lifecycle fact was produced. */
export type ToolLifecyclePhase = 'admission' | 'governance' | 'execution' | 'completion';

/** A safe, non-content representation of the final tool outcome. */
export interface ToolLifecycleResultSummary {
  status: ToolExecutionStatus;
  evidenceIds: string[];
  hasResponse: boolean;
  errorCode?: AgentErrorCode;
  retryable?: boolean;
}

/**
 * Observer input deliberately excludes raw input, response blocks and error
 * messages. It is suitable for audit, checkpoint and memory signal effects.
 */
export interface ToolLifecycleFact {
  schemaVersion: 1;
  runId: string;
  stepId: string;
  toolCallId: string;
  toolName: string;
  toolKind: ToolKind | 'unknown';
  source: ToolSource | 'unknown';
  phase: ToolLifecyclePhase;
  outcome: ToolExecutionStatus;
  inputDigest: string;
  risk: {
    disposition: 'allow' | 'confirm' | 'deny';
    severity: RiskSeverity;
    policyVersion: string;
    findingCount: number;
  };
  result: ToolLifecycleResultSummary;
  startedAt: string;
  finishedAt: string;
  interruptType?: string;
}

/** Redacted fact emitted by AuditHook; the V2 AuditProjector remains authoritative. */
export interface AuditFact {
  schemaVersion: 1;
  kind: 'tool_lifecycle';
  runId: string;
  stepId: string;
  toolCallId: string;
  toolName: string;
  phase: ToolLifecyclePhase;
  outcome: ToolExecutionStatus;
  inputDigest: string;
  riskSeverity: RiskSeverity;
  errorCode?: AgentErrorCode;
  evidenceIds: string[];
  observedAt: string;
}

export type CheckpointIntentReason = 'tool_terminal' | 'tool_interrupted' | 'tool_failed' | 'observer_failure';

/** A request for the Harness/UoW to persist state; it is not a Store command. */
export interface CheckpointIntent {
  schemaVersion: 1;
  kind: 'tool_lifecycle_checkpoint';
  reason: CheckpointIntentReason;
  runId: string;
  stepId: string;
  toolCallId: string;
  inputDigest: string;
  outcome: ToolExecutionStatus;
  requestedAt: string;
}

/** Observation-only input for the future MemoryFacade integration. */
export interface DiagnosisSignal {
  schemaVersion: 1;
  kind: 'tool_outcome';
  candidateStatus: 'observation';
  runId: string;
  stepId: string;
  toolCallId: string;
  toolName: string;
  phase: ToolLifecyclePhase;
  outcome: ToolExecutionStatus;
  riskSeverity: RiskSeverity;
  evidenceIds: string[];
  observedAt: string;
}

export type GovernanceEffect =
  | { type: 'audit'; fact: AuditFact }
  | { type: 'checkpoint'; intent: CheckpointIntent }
  | { type: 'memory_signal'; signal: DiagnosisSignal };

export interface ToolLifecycleObserver {
  readonly id: string;
  observe(fact: ToolLifecycleFact): Promise<readonly GovernanceEffect[]>;
}

export interface LifecycleObserverResult {
  effects: readonly GovernanceEffect[];
  failedObserverIds: readonly string[];
}

export type HookRegistryValidation =
  | { valid: true }
  | { valid: false; reason: 'unknown_hook' | 'expired' | 'invalid_interrupt_type' | 'invalid_tool_call' };

export interface HookRegistration {
  id: string;
  interruptTypes?: readonly string[];
}

export interface HookRegistryLike {
  has(id: string): boolean;
  validate(interrupt: SerializableInterrupt, now: Date): HookRegistryValidation;
}
