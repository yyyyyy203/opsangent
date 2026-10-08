import type {
  AgentEventEnvelopeV2,
  PublicEvidenceView,
  PublicRunDetail,
  RunUsageSummary,
  SourceSubagentResult,
} from '../contracts/index.js';
import type { SettlementMetricFact } from '../profiles/settlement.js';
import type { SmokeBudgetSnapshot } from '../model/smoke-request-budget.js';
import type { SmokeOutputBudgetSnapshot } from '../model/smoke-output-budget.js';
import type { ExportDiagnostics } from '../observability/export-diagnostics.js';
import type { AgentErrorCode } from '../contracts/errors.js';
import type { ModelFailureCategory } from '../model/model-failure.js';
import type { AcceptanceDiagnostics } from './diagnostics.js';

export type AcceptanceCaseId =
  | 'normal'
  | 'settlement_failure'
  | 'low_sample'
  | 'logs_offline'
  | 'capture_window_mismatch';

export type TraceVerification = {
  status: 'verified' | 'failed' | 'unavailable';
  checkedSpanCount: number;
};

export type ManualReview =
  | { status: 'pending' }
  | { status: 'approved' | 'rejected'; unsupportedClaimCount: number };

export type AcceptanceCheckCode =
  | 'SOURCE_ALLOWLIST'
  | 'SOURCE_CALL_LIMIT'
  | 'METRIC_FACT_VALID'
  | 'SOURCE_WINDOW_VALID'
  | 'MISSING_EVIDENCE_VISIBLE'
  | 'EVIDENCE_OWNERSHIP'
  | 'TERMINAL_COMPLETE'
  | 'SCENARIO_OUTCOME_VALID'
  | 'SOURCE_FINGERPRINT_VALID'
  | 'MODEL_HTTP_BUDGET'
  | 'USAGE_CONSISTENT'
  | 'PUBLIC_DATA_SAFE'
  | 'TRACE_EXPORT_SAFE';

export interface AcceptanceSnapshot {
  parent: PublicRunDetail;
  children: readonly PublicRunDetail[];
  evidence: readonly PublicEvidenceView[];
  events: readonly AgentEventEnvelopeV2[];
}

export interface AcceptanceInput extends AcceptanceSnapshot {
  diagnostics?: AcceptanceDiagnostics;
  caseId: AcceptanceCaseId;
  codeRevision: string;
  sourceFingerprint: string;
  profileRevision: string;
  snapshotId: string;
  reports: readonly SourceSubagentResult[];
  metricFact: SettlementMetricFact;
  budget: SmokeBudgetSnapshot;
  outputBudget?: SmokeOutputBudgetSnapshot;
  exportDiagnostics: ExportDiagnostics;
  traceVerification: TraceVerification;
  manualReview: ManualReview;
  boundaryChecks: { publicDataSafe: boolean; traceExportSafe: boolean };
}

export interface AcceptanceReport {
  diagnostics?: AcceptanceDiagnostics;
  /** Version 2 adds a deterministic scenario-outcome gate; version 1 is read-only legacy input. */
  schemaVersion: 1 | 2;
  caseId: AcceptanceCaseId;
  codeRevision: string;
  /** SHA-256 of source/build inputs; absent only on V1 history converted to a failed V2 report. */
  sourceFingerprint?: string;
  profileRevision: string;
  snapshotId: string;
  runId: string;
  childRunIds: string[];
  checks: { code: AcceptanceCheckCode; passed: boolean; status?: 'passed' | 'failed' | 'not_run' }[];
  /** Only allowlisted codes and identifiers, never provider messages or raw evidence. */
  failures?: { runId: string; code: AgentErrorCode; category?: ModelFailureCategory }[];
  budget: SmokeBudgetSnapshot;
  outputBudget?: SmokeOutputBudgetSnapshot;
  usage: RunUsageSummary;
  exportDiagnostics: ExportDiagnostics;
  traceVerification: TraceVerification;
  manualReview: ManualReview;
  verdict: 'passed' | 'failed' | 'review_required';
}
