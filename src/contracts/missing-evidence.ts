import type { SourceSubagentType } from './source-kind.js';

export const UNCLASSIFIED_EVIDENCE_GAP = 'unclassified_evidence_gap' as const;

const SHARED_SOURCE_FAILURE_CODES = [
  'ABORTED', 'BUDGET_EXCEEDED', 'CONFIRMATION_EXPIRED', 'INVALID_INPUT', 'LOOP_DETECTED', 'MODEL_ERROR',
  'STORAGE_ERROR', 'TOOL_ERROR', 'TOOL_NOT_FOUND', 'TOOL_ARGUMENTS_PARSE_FAILED', 'TOOL_ARGUMENTS_SCHEMA_INVALID',
  'TOOL_ARGUMENTS_SEMANTIC_INVALID', 'POLICY_DENIED', 'MCP_NETWORK_ERROR', 'MCP_TIMEOUT', 'MCP_RATE_LIMITED',
  'MCP_SERVER_ERROR', 'MCP_AUTH_ERROR', 'MCP_PROTOCOL_ERROR', 'CIRCUIT_OPEN', 'TIMEOUT', 'UNAVAILABLE',
  'USER_REJECTED', 'child_run_failed', 'child_run_cancelled', 'child_run_interrupted',
] as const;

const SOURCE_MISSING_EVIDENCE_CODES: Readonly<Record<SourceSubagentType, ReadonlySet<string>>> = {
  metrics: new Set([
    ...SHARED_SOURCE_FAILURE_CODES, 'metrics', 'traces', 'source_report', 'multiple_metric_snapshots',
    'metric_evidence_partial', 'window_outside_request_tolerance',
  ]),
  logs: new Set([
    ...SHARED_SOURCE_FAILURE_CODES, 'logs', 'traces', 'source_report', 'logs_capture_unavailable', 'no_log_records',
    'multiple_log_snapshots', 'conflicting_capture_result', 'capture_window_unverified', 'capture_window_mismatch',
    'log_capture_partial', 'log_capture_incomplete', 'log_capture_truncated', 'capture_service_mismatch',
    'aggregate_snapshot_mismatch', 'conflicting_aggregate_results', 'ELK_CAPTURE_RECORD_BUDGET_EXCEEDED',
    'ELK_CAPTURE_DURATION_BUDGET_EXCEEDED', 'ELK_CAPTURE_BYTE_BUDGET_EXCEEDED', 'ELK_SOURCE_FAILED',
  ]),
  traces: new Set([...SHARED_SOURCE_FAILURE_CODES, 'traces', 'trace_source_unavailable', 'trace_evidence_partial']),
};

const ALL_MISSING_EVIDENCE_CODES = new Set<string>([
  UNCLASSIFIED_EVIDENCE_GAP,
  ...Object.values(SOURCE_MISSING_EVIDENCE_CODES).flatMap((codes) => [...codes]),
]);

/** Converts source-owned descriptions to bounded public machine codes without exposing unknown text. */
export function projectSourceMissingEvidenceCodes(
  source: SourceSubagentType,
  values: readonly string[],
  maxItems = 20,
): string[] {
  const allowed = SOURCE_MISSING_EVIDENCE_CODES[source];
  return project(values, allowed, maxItems);
}

/** Projects a legacy report and validates its optional machine-code projection. */
export function normalizeSourceReportMissingEvidenceCodes(
  source: SourceSubagentType,
  descriptions: readonly string[],
  declaredCodes?: readonly string[],
): string[] {
  const expected = projectSourceMissingEvidenceCodes(source, descriptions);
  if (declaredCodes === undefined || sourceMissingEvidenceCodesAreConsistent(source, descriptions, declaredCodes)) {
    return expected;
  }
  return projectSourceMissingEvidenceCodes(source, [...expected, UNCLASSIFIED_EVIDENCE_GAP]);
}

/** Converts Run-level missing evidence to globally safe codes. */
export function projectGeneralMissingEvidenceCodes(values: readonly string[], maxItems = 100): string[] {
  return project(values, ALL_MISSING_EVIDENCE_CODES, maxItems);
}

/**
 * Checks an additive code projection against its legacy description field.
 * Older persisted reports have no code field and remain valid.
 */
export function sourceMissingEvidenceCodesAreConsistent(
  source: SourceSubagentType,
  descriptions: readonly string[],
  codes: readonly string[],
): boolean {
  const expected = projectSourceMissingEvidenceCodes(source, descriptions);
  const projectedCodes = projectSourceMissingEvidenceCodes(source, codes);
  return sameSet(expected, projectedCodes);
}

function project(values: readonly string[], allowed: ReadonlySet<string>, maxItems: number): string[] {
  const limit = Number.isSafeInteger(maxItems) && maxItems > 0 ? maxItems : 20;
  const known: string[] = [];
  const seen = new Set<string>();
  let hasUnknown = false;

  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (allowed.has(value)) {
      if (value === UNCLASSIFIED_EVIDENCE_GAP) hasUnknown = true;
      else if (!seen.has(value)) {
        seen.add(value);
        known.push(value);
      }
    } else {
      hasUnknown = true;
    }
  }

  if (!hasUnknown) return known.slice(0, limit);
  return [...known.slice(0, Math.max(0, limit - 1)), UNCLASSIFIED_EVIDENCE_GAP];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const expected = new Set(left);
  return expected.size === right.length && right.every((value) => expected.has(value));
}
