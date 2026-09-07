import type { AgentError } from '../errors.js';
import type { ContextSummary } from '../message.js';
import type { RiskSeverity, RawToolCall, ToolCall, ToolExecutionResult } from '../tool.js';
import type { JsonValue } from './common.js';

export interface MessageBlockBaseV2 {
  blockId: string;
  metadata?: Record<string, JsonValue>;
}

export interface TextMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'text';
  text: string;
}

export interface ReasoningSummaryMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'reasoning_summary';
  summary: string;
}

export interface ToolCallMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'tool_call';
  call: ToolCall;
}

export interface RawToolCallMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'raw_tool_call';
  call: RawToolCall;
}

export interface ToolAttemptSummaryV2 {
  attemptId: string;
  number: number;
}

export interface ToolResultMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'tool_result';
  result: ToolExecutionResult;
  attempt: ToolAttemptSummaryV2;
  evidenceIds: string[];
}

export interface EvidenceRefMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'evidence_ref';
  evidenceId: string;
  summary: string;
  source: string;
  retrievable: boolean;
}

export type ArtifactAccessPolicyV2 = 'model' | 'user' | 'audit';

export interface ArtifactRefMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'artifact_ref';
  artifactId: string;
  uri: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  accessPolicy: ArtifactAccessPolicyV2;
}

export interface ImageRefMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'image_ref';
  imageId: string;
  uri: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  accessPolicy: ArtifactAccessPolicyV2;
}

export interface ContextSummaryMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'context_summary';
  summary: ContextSummary;
}

export interface ConfirmationRequestMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'confirmation_request';
  confirmationId: string;
  toolCallIds: string[];
  riskSummary: string;
  expiresAt: string;
}

export type ConfirmationDecisionV2 = 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface ConfirmationResultMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'confirmation_result';
  confirmationId: string;
  decision: ConfirmationDecisionV2;
  actor: string;
  toolCallIds: string[];
  decidedAt: string;
}

export type DiagnosisOutcomeV2 = 'confirmed' | 'partial' | 'inconclusive';
export type DiagnosisConfidenceV2 = 'low' | 'medium' | 'high';

export interface RootCauseCandidateV2 {
  summary: string;
  confidence: DiagnosisConfidenceV2;
}

export interface DiagnosisMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'diagnosis';
  outcome: DiagnosisOutcomeV2;
  rootCauseCandidates: RootCauseCandidateV2[];
  evidenceIds: string[];
  missingEvidence: string[];
  limitations: string[];
}

export interface ActionProposalMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'action_proposal';
  actionId: string;
  toolCallId: string;
  risk: RiskSeverity;
  expectedEffect: string;
  verificationPlan: string;
}

export interface ActionResultMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'action_result';
  actionId: string;
  toolCallId: string;
  result: JsonValue;
  idempotencyKey: string;
  verificationEvidenceIds: string[];
  uncertainty: boolean;
}

export interface ErrorMessageBlockV2 extends MessageBlockBaseV2 {
  type: 'error';
  error: AgentError;
}

export type MessageBlockV2 =
  | TextMessageBlockV2
  | ReasoningSummaryMessageBlockV2
  | ToolCallMessageBlockV2
  | RawToolCallMessageBlockV2
  | ToolResultMessageBlockV2
  | EvidenceRefMessageBlockV2
  | ArtifactRefMessageBlockV2
  | ImageRefMessageBlockV2
  | ContextSummaryMessageBlockV2
  | ConfirmationRequestMessageBlockV2
  | ConfirmationResultMessageBlockV2
  | DiagnosisMessageBlockV2
  | ActionProposalMessageBlockV2
  | ActionResultMessageBlockV2
  | ErrorMessageBlockV2;
