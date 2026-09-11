import type { Finding } from './guard.js';
import { checkpointChecksum } from './stable-json.js';
import type { RiskSeverity } from './tool.js';

export interface ChangeFreezePeriod {
  id: string;
  startsAt: string;
  endsAt: string;
  reason?: string;
}

export interface ImpactPolicy {
  unavailable: {
    S0: 'deny';
    S1: 'deny';
    S2: 'confirm';
    S3: 'confirm';
  };
}

export interface ResolvedProfileSnapshot {
  profileId: string;
  revision: string;
  digest: string;
  serviceName: string;
  serviceLevel: 'S0' | 'S1' | 'S2' | 'S3';
  timezone: string;
  allowedActions: string[];
  forbiddenActions: string[];
  changeFreezePeriods: ChangeFreezePeriod[];
  impactPolicy: ImpactPolicy;
  policyVersion: string;
  capturedAt: string;
  source: 'legacy_checkpoint' | 'resolved';
}

export type ImpactSurfaceAssessment =
  | {
      status: 'available';
      capturedAt: string;
      expiresAt: string;
      affectedUsers: number;
      errorRate: number;
      baselineErrorRate: number;
      currentQps: number;
      peakQps: number;
      downstreamHealthy: boolean;
      quality: 'complete' | 'partial';
      evidenceIds: string[];
    }
  | {
      status: 'unavailable' | 'stale';
      reasonCode: string;
      capturedAt?: string;
      evidenceIds: string[];
    };

export interface RiskDecision {
  disposition: 'allow' | 'confirm' | 'deny';
  severity: RiskSeverity;
  requireConfirmation: boolean;
  findings: Finding[];
  policyVersion: string;
}

export interface ToolBatchGovernanceSnapshot {
  profileRevision: string;
  profileDigest: string;
  impact: ImpactSurfaceAssessment;
  decisions: Array<{
    toolCallId: string;
    inputDigest: string;
    decision: RiskDecision;
  }>;
  evaluatedAt: string;
}

export interface LoopSample {
  signature: string;
  toolName: string;
  stage: 'triage' | 'evidence_collection' | 'hypothesis' | 'risk_gate' | 'action' | 'verification' | 'postmortem';
  status: 'success' | 'failed' | 'timeout' | 'skipped';
  stepId: string;
  recordedAt: string;
}

export interface LoopState {
  history: LoopSample[];
  lastSignature?: string;
  consecutiveCount: number;
  level: 'none' | 'warn' | 'hard' | 'force_break';
  blockedSignatures: string[];
}

export interface CompressionState {
  summaryVersion: number;
  lastLevel: 'none' | 'L0' | 'L1' | 'L2';
  sourceMessageIds: string[];
  protectedMessageIds: string[];
  offloadedEvidenceIds: string[];
  lastCompressedAt?: string;
}

export interface RunGovernanceState {
  schemaVersion: 1;
  profile: ResolvedProfileSnapshot;
  loop: LoopState;
  compression: CompressionState;
}

const LEGACY_IMPACT_POLICY: ImpactPolicy = {
  unavailable: { S0: 'deny', S1: 'deny', S2: 'confirm', S3: 'confirm' },
};

/** Creates the conservative state used for a new Run or a pre-governance checkpoint migration. */
export function createInitialRunGovernanceState(input: {
  profileId: string;
  capturedAt: string;
}): RunGovernanceState {
  const profile = {
    profileId: input.profileId,
    revision: 'legacy/v1',
    serviceName: input.profileId,
    source: 'legacy_checkpoint' as const,
  };
  return {
    schemaVersion: 1,
    profile: {
      ...profile,
      digest: checkpointChecksum({
        kind: 'legacy_profile_snapshot',
        schemaVersion: 1,
        profileId: input.profileId,
        source: 'legacy_checkpoint',
      }),
      serviceLevel: 'S0',
      timezone: 'UTC',
      allowedActions: [],
      forbiddenActions: [],
      changeFreezePeriods: [],
      impactPolicy: structuredClone(LEGACY_IMPACT_POLICY),
      policyVersion: 'legacy/v1',
      capturedAt: input.capturedAt,
    },
    loop: {
      history: [],
      consecutiveCount: 0,
      level: 'none',
      blockedSignatures: [],
    },
    compression: {
      summaryVersion: 0,
      lastLevel: 'none',
      sourceMessageIds: [],
      protectedMessageIds: [],
      offloadedEvidenceIds: [],
    },
  };
}
