import type { AgentErrorCode } from './errors.js';
import type { RunUsageSummary } from './run-usage.js';
import type { AgentContext, DiagnosisStage, RunStatus } from './context.js';
import type { JsonObject, JsonValue } from './common.js';
import type { EvidenceManifestSummary, EvidenceRecord } from './storage.js';

export interface PublicRunSummary {
  runId: string;
  profileId: string;
  status: RunStatus;
  stage: DiagnosisStage;
  revision?: number;
  contextVersion: number;
  createdAt: string;
  updatedAt: string;
  parentRunId?: string;
}

export interface PublicRunDetail extends PublicRunSummary {
  evidenceIds: readonly string[];
  missingEvidence: readonly string[];
  childRunIds: readonly string[];
  usage?: RunUsageSummary;
  failure?: {
    code: AgentErrorCode;
    message: string;
    retryable: boolean;
  };
}

export interface RunListOptions {
  profileId?: string;
  status?: RunStatus;
  cursor?: string;
  limit?: number;
}

export interface PublicRunPage {
  items: readonly PublicRunSummary[];
  nextCursor?: string;
}

export type PublicEvidenceState = 'available' | 'committed' | 'partial';

export interface PublicEvidenceView {
  evidenceId: string;
  runId: string;
  source: EvidenceRecord['source'];
  state: PublicEvidenceState;
  capturedAt: string;
  summary: JsonObject;
  coverage?: number;
  truncated?: boolean;
  recordCount?: number;
  sourceBytes?: number;
  storedBytes?: number;
  chunkCount?: number;
  timeRange?: { start: string; end: string };
  rawSha256?: string;
  traceIdCount: number;
  retrievable: boolean;
}

export interface EvidenceListOptions {
  cursor?: string;
  limit?: number;
}

export interface PublicEvidencePage {
  items: readonly PublicEvidenceView[];
  nextCursor?: string;
}

export interface InspectionQueryService {
  listRuns(options?: RunListOptions): Promise<PublicRunPage>;
  getRun(runId: string): Promise<PublicRunDetail | null>;
  listEvidence(runId: string, options?: EvidenceListOptions): Promise<PublicEvidencePage>;
  getEvidence(runId: string, evidenceId: string): Promise<PublicEvidenceView | null>;
}

const SUBAGENT_SOURCE_BY_TOOL: Readonly<Record<string, 'metrics' | 'logs' | 'traces'>> = {
  metrics_subagent: 'metrics',
  logs_subagent: 'logs',
  traces_subagent: 'traces',
};
const SHARED_SOURCE_FAILURE_CODES = [
  'ABORTED', 'BUDGET_EXCEEDED', 'CONFIRMATION_EXPIRED', 'INVALID_INPUT', 'LOOP_DETECTED', 'MODEL_ERROR',
  'STORAGE_ERROR', 'TOOL_ERROR', 'TOOL_NOT_FOUND', 'TOOL_ARGUMENTS_PARSE_FAILED', 'TOOL_ARGUMENTS_SCHEMA_INVALID',
  'TOOL_ARGUMENTS_SEMANTIC_INVALID', 'POLICY_DENIED', 'MCP_NETWORK_ERROR', 'MCP_TIMEOUT', 'MCP_RATE_LIMITED',
  'MCP_SERVER_ERROR', 'MCP_AUTH_ERROR', 'MCP_PROTOCOL_ERROR', 'CIRCUIT_OPEN', 'TIMEOUT', 'UNAVAILABLE',
  'USER_REJECTED', 'child_run_failed', 'child_run_cancelled', 'child_run_interrupted',
] as const;
const SAFE_SOURCE_MISSING_EVIDENCE_CODES: Readonly<Record<'metrics' | 'logs' | 'traces', ReadonlySet<string>>> = {
  metrics: new Set([...SHARED_SOURCE_FAILURE_CODES, 'metrics', 'traces', 'source_report', 'multiple_metric_snapshots', 'metric_evidence_partial', 'window_outside_request_tolerance']),
  logs: new Set([
    ...SHARED_SOURCE_FAILURE_CODES, 'logs', 'traces', 'source_report', 'logs_capture_unavailable', 'no_log_records',
    'multiple_log_snapshots', 'conflicting_capture_result', 'capture_window_unverified', 'capture_window_mismatch',
    'log_capture_partial', 'log_capture_incomplete', 'log_capture_truncated', 'capture_service_mismatch',
    'aggregate_snapshot_mismatch', 'conflicting_aggregate_results', 'ELK_CAPTURE_RECORD_BUDGET_EXCEEDED',
    'ELK_CAPTURE_DURATION_BUDGET_EXCEEDED', 'ELK_CAPTURE_BYTE_BUDGET_EXCEEDED', 'ELK_SOURCE_FAILED',
  ]),
  traces: new Set([...SHARED_SOURCE_FAILURE_CODES, 'traces', 'trace_source_unavailable', 'trace_evidence_partial']),
};
const SAFE_SUMMARY_MISSING_EVIDENCE_CODES = new Set<string>(
  Object.values(SAFE_SOURCE_MISSING_EVIDENCE_CODES).flatMap((codes) => [...codes]),
);

/** Project deterministic Run findings plus safe machine codes from structured source ToolResults. */
export function publicRunMissingEvidence(context: AgentContext): string[] {
  const missingEvidence = context.missingEvidence.map((item) => item.slice(0, 500));
  const seen = new Set(missingEvidence);
  for (const message of context.messages) {
    for (const block of message.blocks) {
      if (block.type === 'context_summary') {
        for (const item of block.summary.missingEvidence.slice(0, 20)) {
          if (typeof item !== 'string') continue;
          const safeCode = safeMissingEvidenceCode(item, SAFE_SUMMARY_MISSING_EVIDENCE_CODES);
          if (safeCode === undefined || seen.has(safeCode)) continue;
          seen.add(safeCode);
          missingEvidence.push(safeCode);
        }
        continue;
      }
      if (block.type !== 'tool_result') continue;
      const expectedSource = SUBAGENT_SOURCE_BY_TOOL[block.result.toolName];
      if (expectedSource === undefined) continue;
      for (const responseBlock of block.result.response?.blocks ?? []) {
        if (responseBlock.type !== 'json' || !isRecord(responseBlock.value)) continue;
        const value = responseBlock.value;
        if (value.source !== expectedSource || !isSourceSubagentStatus(value.status)
          || !Array.isArray(value.missingEvidence)) continue;
        for (const item of value.missingEvidence.slice(0, 20)) {
          if (typeof item !== 'string') continue;
          const safeCode = safeMissingEvidenceCode(item, SAFE_SOURCE_MISSING_EVIDENCE_CODES[expectedSource]);
          if (safeCode === undefined || seen.has(safeCode)) continue;
          seen.add(safeCode);
          missingEvidence.push(safeCode);
        }
      }
    }
  }
  return missingEvidence;
}

/** Safe public projection for bounded evidence metadata; raw payloads are never returned. */
export function publicEvidenceFromRecord(record: EvidenceRecord): PublicEvidenceView {
  return {
    evidenceId: record.evidenceId,
    runId: record.runId,
    source: record.source,
    state: 'available',
    capturedAt: record.capturedAt,
    summary: publicSummary(record.summary),
    ...(record.rawSha256 === undefined ? {} : { rawSha256: record.rawSha256 }),
    traceIdCount: record.businessTraceIds.length,
    retrievable: false,
  };
}

/** Safe public projection for committed/partial large evidence manifests. */
export function publicEvidenceFromManifest(manifest: EvidenceManifestSummary): PublicEvidenceView {
  const summary = publicSummary(manifestSummaryWithoutSamples(manifest));
  return {
    evidenceId: manifest.evidenceId,
    runId: manifest.runId,
    source: manifest.source,
    state: manifest.state,
    capturedAt: manifest.timeRange.start,
    summary,
    coverage: manifest.coverage,
    truncated: manifest.truncated,
    recordCount: manifest.recordCount,
    sourceBytes: manifest.sourceBytes,
    storedBytes: manifest.storedBytes,
    chunkCount: manifest.chunkCount,
    timeRange: { ...manifest.timeRange },
    rawSha256: manifest.rawSha256,
    traceIdCount: 0,
    retrievable: false,
  };
}

function manifestSummaryWithoutSamples(manifest: EvidenceManifestSummary): JsonObject {
  return {
    recordCount: manifest.recordCount,
    sourceBytes: manifest.sourceBytes,
    storedBytes: manifest.storedBytes,
    coverage: manifest.coverage,
    truncated: manifest.truncated,
    missingEvidence: [...manifest.missingEvidence],
    ...(manifest.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: manifest.sourceSnapshotId }),
  };
}

function publicSummary(value: unknown): JsonObject {
  const sanitized = sanitizeJson(value, 0);
  return sanitized !== null && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {};
}

function sanitizeJson(value: unknown, depth: number): JsonValue {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return safeText(value);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeJson(item, depth + 1));
  if (typeof value === 'object') {
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) continue;
      output[key.slice(0, 100)] = sanitizeJson(item, depth + 1);
    }
    return output;
  }
  return '[UNSUPPORTED]';
}

function safeText(value: string): string {
  return FORBIDDEN_VALUE.test(value) || INTERNAL_ADDRESS.test(value) ? '[REDACTED]' : value.slice(0, 2_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSourceSubagentStatus(value: unknown): value is 'complete' | 'partial' | 'unavailable' {
  return value === 'complete' || value === 'partial' || value === 'unavailable';
}

function safeMissingEvidenceCode(value: string, allowedCodes: ReadonlySet<string>): string | undefined {
  return allowedCodes.has(value) ? value : undefined;
}

const FORBIDDEN_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|system[-_]?prompt|raw[-_]?arguments|storage[-_]?key)/i;
const FORBIDDEN_VALUE = /\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}/i;
const INTERNAL_ADDRESS = /(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w.-]*\.internal)(?::\d+)?(?:\/\S*)?/i;
