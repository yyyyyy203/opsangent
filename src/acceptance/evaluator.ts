import type {
  AgentEventEnvelopeV2,
  PublicEvidenceView,
  PublicRunDetail,
  RunUsageSummary,
  SourceSubagentResult,
} from '../contracts/index.js';
import { summarizeRunUsage } from '../contracts/run-usage.js';
import { assessSettlementMetrics, settlementMetricsLabProfile } from '../profiles/settlement.js';
import type { ExportDiagnosticCode } from '../observability/export-diagnostics.js';
import { readSourceReports } from './source-reports.js';
import { collectAcceptanceFailures } from './failure-summary.js';
import { agentErrorCodeV2Schema } from '../contracts/event-v2/common.js';
import { isModelFailureCategory } from '../model/model-failure.js';
import { parseAcceptanceDiagnostics } from './diagnostics.js';
import type {
  AcceptanceInput,
  AcceptanceReport,
  ManualReview,
  TraceVerification,
} from './types.js';

const SOURCES = ['metrics', 'logs'] as const;
const SOURCE_TOOL_NAMES = ['metrics_subagent', 'logs_subagent'] as const;
const TERMINAL_EVENTS = new Set(['RUN_FINISHED', 'RUN_FAILED', 'RUN_CANCELLED', 'RUN_TIMED_OUT']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const EXPORT_DIAGNOSTIC_CODES: readonly ExportDiagnosticCode[] = [
  'TRACE_QUEUE_FULL', 'TRACE_NETWORK_ERROR', 'TRACE_REQUEST_TIMEOUT', 'TRACE_FLUSH_TIMEOUT',
  'TRACE_HTTP_ERROR', 'TRACE_LOCAL_AUDIT_REJECTED',
  'TRACE_PARENT_MISSING', 'TRACE_PAYLOAD_DROPPED',
];

const EXPECTED_COUNTS: Readonly<Record<AcceptanceInput['caseId'], { total: number; failed: number; status: string }>> = {
  normal: { total: 100, failed: 0, status: 'healthy' },
  settlement_failure: { total: 100, failed: 15, status: 'breached' },
  low_sample: { total: 10, failed: 8, status: 'insufficient_data' },
  logs_offline: { total: 100, failed: 15, status: 'breached' },
  capture_window_mismatch: { total: 100, failed: 15, status: 'breached' },
};

export function evaluateAcceptance(input: AcceptanceInput): AcceptanceReport {
  const failures = collectAcceptanceFailures(input.events, new Set([input.parent.runId, ...input.children.map((child) => child.runId)]));
  const eventReports = readSourceReports(input.events);
  const sourceStarts = input.events.filter((event): event is Extract<AgentEventEnvelopeV2, { type: 'TOOL_STARTED' }> => (
    event.type === 'TOOL_STARTED'
    && (event.payload.source === 'subagent' || event.payload.toolName.endsWith('_subagent'))
  ));
  const lifecycleStarts = input.events.filter((event): event is Extract<AgentEventEnvelopeV2, { type: 'SUBAGENT_STARTED' }> => (
    event.type === 'SUBAGENT_STARTED'
  ));
  const reportsMatch = sameSourceReports(input.reports, eventReports);
  const reportBySource = new Map(input.reports.map((report) => [report.source, report]));
  const metrics = reportBySource.get('metrics');
  const logs = reportBySource.get('logs');
  const metricEvidence = input.evidence.filter((evidence) => evidence.source === 'metric');
  const expectedWindow = {
    start: new Date(input.metricFact.start * 1_000).toISOString(),
    end: new Date(input.metricFact.end * 1_000).toISOString(),
  };

  const checks: AcceptanceReport['checks'] = [
    {
      code: 'SOURCE_ALLOWLIST',
      passed: reportsMatch
        && input.reports.every((report) => SOURCES.includes(report.source as (typeof SOURCES)[number]))
        && sourceStarts.every((event) => SOURCE_TOOL_NAMES.includes(event.payload.toolName as (typeof SOURCE_TOOL_NAMES)[number]))
        && lifecycleStarts.every((event) => SOURCES.includes(event.payload.subagentType as (typeof SOURCES)[number])),
    },
    {
      code: 'SOURCE_CALL_LIMIT',
      passed: SOURCES.every((source) => sourceStarts.filter((event) => event.type === 'TOOL_STARTED'
        && event.payload.toolName === `${source}_subagent`).length === 1)
        && SOURCES.every((source) => lifecycleStarts.filter((event) => event.type === 'SUBAGENT_STARTED'
          && event.payload.subagentType === source).length === 1)
        && input.reports.length === SOURCES.length,
    },
    {
      code: 'METRIC_FACT_VALID',
      passed: isMetricFactValid(input, metrics),
    },
    {
      code: 'SOURCE_WINDOW_VALID',
      passed: isSourceWindowValid(input, metrics, logs, metricEvidence, expectedWindow),
    },
    {
      code: 'MISSING_EVIDENCE_VISIBLE',
      passed: isMissingEvidenceVisible(input.parent, input.reports),
    },
    {
      code: 'EVIDENCE_OWNERSHIP',
      passed: isEvidenceOwnershipValid(input.parent, input.children, input.evidence, input.reports),
    },
    {
      code: 'TERMINAL_COMPLETE',
      passed: isTerminalComplete(input.parent, input.children, input.events),
    },
    {
      code: 'SCENARIO_OUTCOME_VALID',
      passed: isScenarioOutcomeValid(input, failures),
    },
    {
      code: 'SOURCE_FINGERPRINT_VALID',
      passed: isValidFingerprint(input.sourceFingerprint),
    },
    {
      code: 'MODEL_HTTP_BUDGET',
      passed: isBudgetValid(input.budget) && (input.outputBudget === undefined || safeOutputBudget(input.outputBudget) !== undefined),
    },
    {
      code: 'USAGE_CONSISTENT',
      passed: isUsageConsistent(input.parent, input.children, input.events),
    },
    {
      code: 'PUBLIC_DATA_SAFE',
      passed: input.boundaryChecks.publicDataSafe === true && input.evidence.every((item) => item.retrievable === false),
    },
    {
      code: 'TRACE_EXPORT_SAFE',
      passed: input.boundaryChecks.traceExportSafe === true
        && input.exportDiagnostics.pending === 0 && input.exportDiagnostics.dropped === 0,
    },
  ];

  const report: AcceptanceReport = {
    schemaVersion: 2,
    caseId: input.caseId,
    codeRevision: safeCodeRevision(input.codeRevision),
    sourceFingerprint: isValidFingerprint(input.sourceFingerprint) ? input.sourceFingerprint : 'unverified',
    profileRevision: safeIdentifier(input.profileRevision, 'unverified'),
    snapshotId: safeIdentifier(input.snapshotId, 'unverified'),
    runId: safeIdentifier(input.parent.runId, 'unavailable'),
    childRunIds: input.children.map((child) => safeIdentifier(child.runId, 'unavailable')),
    checks,
    ...(failures.length > 0 ? { failures } : {}),
    budget: safeBudget(input.budget),
    ...(safeOutputBudget(input.outputBudget) === undefined ? {} : { outputBudget: safeOutputBudget(input.outputBudget)! }),
    usage: summarizeTreeUsage(input.parent, input.children, input.events),
    exportDiagnostics: safeExportDiagnostics(input.exportDiagnostics),
    ...(input.diagnostics === undefined ? {} : { diagnostics: parseAcceptanceDiagnostics(input.diagnostics) }),
    traceVerification: safeTraceVerification(input.traceVerification),
    manualReview: safeManualReview(input.manualReview),
    verdict: calculateVerdict(checks, input.traceVerification, input.manualReview),
  };
  return report;
}

export function applyManualReview(report: AcceptanceReport, review: ManualReview): AcceptanceReport {
  const normalizedReview = safeManualReview(review);
  const runIds = new Set([report.runId, ...report.childRunIds]);
  const failures = report.failures?.filter((failure) => runIds.has(failure.runId)
    && agentErrorCodeV2Schema.safeParse(failure.code).success).slice(0, 100).map((failure) => ({
    runId: safeIdentifier(failure.runId, 'unavailable'), code: failure.code,
    ...(isModelFailureCategory(failure.category) ? { category: failure.category } : {}),
  }));
  const reviewedChecks: AcceptanceReport['checks'] = report.checks.map((check) => ({ code: check.code,
    passed: check.passed === true && check.status !== 'failed' && check.status !== 'not_run',
    ...(check.status === 'passed' || check.status === 'failed' || check.status === 'not_run' ? { status: check.status } : {}),
  }));
  if (!reviewedChecks.some((check) => check.code === 'SCENARIO_OUTCOME_VALID')) {
    // Legacy reports cannot prove this newly-added hard gate. Approval must not infer a pass.
    reviewedChecks.push({ code: 'SCENARIO_OUTCOME_VALID', passed: false, status: 'not_run' });
  }
  if (!reviewedChecks.some((check) => check.code === 'SOURCE_FINGERPRINT_VALID')) {
    reviewedChecks.push({ code: 'SOURCE_FINGERPRINT_VALID', passed: false, status: 'not_run' });
  }
  return {
    schemaVersion: 2,
    caseId: report.caseId,
    codeRevision: safeCodeRevision(report.codeRevision),
    ...(isValidFingerprint(report.sourceFingerprint) ? { sourceFingerprint: report.sourceFingerprint } : {}),
    profileRevision: safeIdentifier(report.profileRevision, 'unverified'),
    snapshotId: safeIdentifier(report.snapshotId, 'unverified'),
    runId: safeIdentifier(report.runId, 'unavailable'),
    childRunIds: report.childRunIds.map((id) => safeIdentifier(id, 'unavailable')),
    checks: reviewedChecks,
    ...(failures === undefined ? {} : { failures }),
    budget: safeBudget(report.budget),
    ...(safeOutputBudget(report.outputBudget) === undefined ? {} : { outputBudget: safeOutputBudget(report.outputBudget)! }),
    usage: safeUsage(report.usage),
    exportDiagnostics: safeExportDiagnostics(report.exportDiagnostics),
    ...(report.diagnostics === undefined ? {} : { diagnostics: parseAcceptanceDiagnostics(report.diagnostics) }),
    traceVerification: safeTraceVerification(report.traceVerification),
    manualReview: normalizedReview,
    verdict: calculateVerdict(reviewedChecks, report.traceVerification, normalizedReview),
  };
}

function isScenarioOutcomeValid(
  input: AcceptanceInput,
  failures: NonNullable<AcceptanceReport['failures']>,
): boolean {
  return input.parent.status === 'completed'
    && input.children.length === input.parent.childRunIds.length
    && input.children.every((child) => child.status === 'completed')
    // Truncated output is a terminal model failure, not a valid partial source result.
    && failures.every((failure) => failure.category !== 'output_truncated');
}

function isValidFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
}

function isMetricFactValid(input: AcceptanceInput, report: SourceSubagentResult | undefined): boolean {
  const expected = EXPECTED_COUNTS[input.caseId];
  const fact = input.metricFact;
  if (report === undefined || report.source !== 'metrics' || report.status !== 'complete'
    || report.evidenceIds.length !== 1 || fact.service !== settlementMetricsLabProfile.service
    || fact.environment !== settlementMetricsLabProfile.environment || fact.total !== expected.total
    || fact.failed !== expected.failed || fact.threshold !== settlementMetricsLabProfile.threshold
    || fact.minSamples !== settlementMetricsLabProfile.minSamples || !Number.isSafeInteger(fact.start)
    || !Number.isSafeInteger(fact.end) || fact.start >= fact.end
    || fact.end - fact.start !== settlementMetricsLabProfile.windowSeconds) return false;
  try {
    const assessed = assessSettlementMetrics({ total: fact.total, failed: fact.failed }, settlementMetricsLabProfile);
    return fact.status === expected.status && fact.status === assessed.status && fact.failureRate === assessed.failureRate;
  } catch {
    return false;
  }
}

function isSourceWindowValid(
  input: AcceptanceInput,
  metrics: SourceSubagentResult | undefined,
  logs: SourceSubagentResult | undefined,
  metricEvidence: readonly PublicEvidenceView[],
  expectedWindow: { start: string; end: string },
): boolean {
  if (metrics === undefined || metrics.status !== 'complete' || metricEvidence.length !== 1
    || !sameWindow(metricEvidence[0]?.timeRange, expectedWindow)
    || !sameStrings(metrics.evidenceIds, metricEvidence.map((item) => item.evidenceId))) return false;
  if (logs === undefined) return false;
  const logEvidence = input.evidence.filter((evidence) => evidence.source === 'log');
  if (input.caseId === 'logs_offline') {
    return logs.status === 'unavailable' && logs.evidenceIds.length === 0 && logEvidence.length === 0
      && logs.missingEvidence.includes('logs_capture_unavailable');
  }
  if (logEvidence.length !== 1 || !sameStrings(logs.evidenceIds, logEvidence.map((item) => item.evidenceId))) return false;
  const logWindowMatches = sameWindow(logEvidence[0]?.timeRange, expectedWindow);
  if (input.caseId === 'capture_window_mismatch') {
    return !logWindowMatches && logs.status === 'partial' && logs.missingEvidence.includes('capture_window_mismatch');
  }
  return logWindowMatches && !logs.missingEvidence.includes('capture_window_mismatch');
}

function isMissingEvidenceVisible(parent: PublicRunDetail, reports: readonly SourceSubagentResult[]): boolean {
  const visible = new Set(parent.missingEvidence);
  return reports.every((report) => {
    if (report.status === 'complete' && report.missingEvidence.length === 0) return true;
    return report.missingEvidence.length > 0 && report.missingEvidence.every((code) => visible.has(code));
  });
}

function isEvidenceOwnershipValid(
  parent: PublicRunDetail,
  children: readonly PublicRunDetail[],
  evidence: readonly PublicEvidenceView[],
  reports: readonly SourceSubagentResult[],
): boolean {
  const childBySource = new Map<string, PublicRunDetail>();
  const sourceByRunId = new Map<string, string>();
  for (const report of reports) {
    const child = children.find((candidate) => candidate.parentRunId === parent.runId
      && parent.childRunIds.includes(candidate.runId)
      && evidence.some((item) => item.runId === candidate.runId && report.evidenceIds.includes(item.evidenceId)));
    if (child !== undefined) childBySource.set(report.source, child);
  }
  for (const item of evidence) {
    const source = item.source === 'metric' ? 'metrics' : item.source === 'log' ? 'logs' : undefined;
    if (source !== undefined) sourceByRunId.set(item.runId, source);
  }
  if (new Set(evidence.map((item) => item.evidenceId)).size !== evidence.length) return false;
  return reports.every((report) => {
    const child = childBySource.get(report.source);
    if (child === undefined) return report.status === 'unavailable' && report.evidenceIds.length === 0;
    const childEvidenceIds = new Set(child.evidenceIds);
    return report.evidenceIds.every((evidenceId) => {
      const item = evidence.find((candidate) => candidate.evidenceId === evidenceId);
      return item !== undefined && item.runId === child.runId && childEvidenceIds.has(evidenceId)
        && parent.evidenceIds.includes(evidenceId) && sourceByRunId.get(item.runId) === report.source;
    });
  });
}

function isTerminalComplete(
  parent: PublicRunDetail,
  children: readonly PublicRunDetail[],
  events: readonly AgentEventEnvelopeV2[],
): boolean {
  if (!TERMINAL_STATUSES.has(parent.status) || parent.childRunIds.length !== children.length
    || new Set(parent.childRunIds).size !== parent.childRunIds.length) return false;
  const runs = [parent, ...children];
  if (!parent.childRunIds.every((id) => children.some((child) => child.runId === id && child.parentRunId === parent.runId))) return false;
  return runs.every((run) => TERMINAL_STATUSES.has(run.status)
    && events.filter((event) => event.runId === run.runId && TERMINAL_EVENTS.has(event.type)).length === 1);
}

function isBudgetValid(budget: AcceptanceInput['budget']): boolean {
  return Number.isSafeInteger(budget.limit) && budget.limit >= 1 && budget.limit <= 10
    && Number.isSafeInteger(budget.attempted) && budget.attempted >= 0
    && Number.isSafeInteger(budget.sent) && budget.sent >= 0 && budget.sent <= budget.limit
    && Number.isSafeInteger(budget.rejected) && budget.rejected >= 0
    && budget.attempted === budget.sent + budget.rejected;
}

function isUsageConsistent(
  parent: PublicRunDetail,
  children: readonly PublicRunDetail[],
  events: readonly AgentEventEnvelopeV2[],
): boolean {
  const runs = [parent, ...children];
  return runs.every((run) => run.usage !== undefined
    && stableJson(run.usage) === stableJson(summarizeRunUsage(events.filter((event) => event.runId === run.runId))));
}

function summarizeTreeUsage(
  parent: PublicRunDetail,
  children: readonly PublicRunDetail[],
  events: readonly AgentEventEnvelopeV2[],
): RunUsageSummary {
  const runIds = new Set([parent.runId, ...children.map((child) => child.runId)]);
  const uniqueEvents = new Map<string, AgentEventEnvelopeV2>();
  for (const event of events) if (runIds.has(event.runId)) uniqueEvents.set(event.eventId, event);
  return safeUsage(summarizeRunUsage([...uniqueEvents.values()]));
}

function sameSourceReports(left: readonly SourceSubagentResult[], right: readonly SourceSubagentResult[]): boolean {
  return stableJson([...left].sort((a, b) => a.source.localeCompare(b.source)))
    === stableJson([...right].sort((a, b) => a.source.localeCompare(b.source)));
}

function sameWindow(
  actual: PublicEvidenceView['timeRange'] | undefined,
  expected: { start: string; end: string },
): boolean {
  return actual?.start === expected.start && actual.end === expected.end;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function calculateVerdict(
  checks: readonly AcceptanceReport['checks'][number][],
  trace: TraceVerification,
  review: ManualReview,
): AcceptanceReport['verdict'] {
  if (checks.some((check) => check.passed !== true || check.status === 'failed' || check.status === 'not_run')
    || trace.status === 'failed' || review.status === 'rejected') return 'failed';
  if (review.status === 'approved' && review.unsupportedClaimCount !== 0) return 'failed';
  if (trace.status !== 'verified' || review.status !== 'approved') return 'review_required';
  return 'passed';
}

function safeManualReview(review: ManualReview): ManualReview {
  if (review.status === 'pending') return { status: 'pending' };
  if ((review.status === 'approved' || review.status === 'rejected')
    && Number.isSafeInteger(review.unsupportedClaimCount) && review.unsupportedClaimCount >= 0) {
    return { status: review.status, unsupportedClaimCount: review.unsupportedClaimCount };
  }
  return { status: 'pending' };
}

function safeTraceVerification(trace: TraceVerification): TraceVerification {
  const status = trace.status === 'verified' || trace.status === 'failed' || trace.status === 'unavailable'
    ? trace.status : 'unavailable';
  const checkedSpanCount = Number.isSafeInteger(trace.checkedSpanCount) && trace.checkedSpanCount >= 0
    ? trace.checkedSpanCount : 0;
  return { status, checkedSpanCount };
}

function safeBudget(budget: AcceptanceInput['budget']): AcceptanceInput['budget'] {
  return {
    limit: safeCount(budget.limit), attempted: safeCount(budget.attempted),
    sent: safeCount(budget.sent), rejected: safeCount(budget.rejected),
  };
}

function safeUsage(usage: RunUsageSummary): RunUsageSummary {
  const completeness = usage.completeness === 'complete' || usage.completeness === 'partial'
    || usage.completeness === 'unavailable' ? usage.completeness : 'unavailable';
  return {
    completeness,
    ...(isSafeCount(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
    ...(isSafeCount(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
    ...(isSafeCount(usage.cachedInputTokens) ? { cachedInputTokens: usage.cachedInputTokens } : {}),
  };
}

function safeOutputBudget(value: AcceptanceReport['outputBudget']): AcceptanceReport['outputBudget'] {
  if (value === undefined) return undefined;
  const keys = ['limit', 'reserved', 'settled', 'available', 'reservations', 'settlements', 'rejected'] as const;
  if (!keys.every((key) => isSafeCount(value[key])) || value.limit < 1 || value.limit > 5120
    || value.reserved + value.settled + value.available !== value.limit || value.settlements > value.reservations) return undefined;
  return { limit: value.limit, reserved: value.reserved, settled: value.settled, available: value.available,
    reservations: value.reservations, settlements: value.settlements, rejected: value.rejected };
}

function safeExportDiagnostics(diagnostics: AcceptanceInput['exportDiagnostics']): AcceptanceInput['exportDiagnostics'] {
  const counts: Partial<Record<ExportDiagnosticCode, number>> = {};
  for (const code of EXPORT_DIAGNOSTIC_CODES) {
    const count = diagnostics.counts[code];
    if (isSafeCount(count)) counts[code] = count;
  }
  return { pending: safeCount(diagnostics.pending), dropped: safeCount(diagnostics.dropped), counts };
}

function safeCodeRevision(value: string): string {
  return /^[a-f\d]{7,40}$/iu.test(value) ? value.toLowerCase() : 'unverified';
}

function safeIdentifier(value: string, fallback: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : fallback;
}

function safeCount(value: number): number {
  return isSafeCount(value) ? value : 0;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortJson(item)]));
}
