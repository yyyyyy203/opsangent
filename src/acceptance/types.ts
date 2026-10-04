import type {
  AgentEventEnvelopeV2,
  PublicEvidenceView,
  PublicRunDetail,
  RunUsageSummary,
  SourceSubagentResult,
} from '../contracts/index.js';
import type { SettlementMetricFact } from '../profiles/settlement.js';
import type { SmokeBudgetSnapshot } from '../model/smoke-request-budget.js';
import type { ExportDiagnostics } from '../observability/export-diagnostics.js';

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
  caseId: AcceptanceCaseId;
  codeRevision: string;
  profileRevision: string;
  snapshotId: string;
  reports: readonly SourceSubagentResult[];
  metricFact: SettlementMetricFact;
  budget: SmokeBudgetSnapshot;
  exportDiagnostics: ExportDiagnostics;
  traceVerification: TraceVerification;
  manualReview: ManualReview;
  boundaryChecks: { publicDataSafe: boolean; traceExportSafe: boolean };
}

export interface AcceptanceReport {
  schemaVersion: 1;
  caseId: AcceptanceCaseId;
  codeRevision: string;
  profileRevision: string;
  snapshotId: string;
  runId: string;
  childRunIds: string[];
  checks: { code: AcceptanceCheckCode; passed: boolean }[];
  budget: SmokeBudgetSnapshot;
  usage: RunUsageSummary;
  exportDiagnostics: ExportDiagnostics;
  traceVerification: TraceVerification;
  manualReview: ManualReview;
  verdict: 'passed' | 'failed' | 'review_required';
}
