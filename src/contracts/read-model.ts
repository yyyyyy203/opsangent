import type { AgentErrorCode } from './errors.js';
import type { RunUsageSummary } from './run-usage.js';
import type { DiagnosisStage, RunStatus } from './context.js';
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

const FORBIDDEN_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|system[-_]?prompt|raw[-_]?arguments|storage[-_]?key)/i;
const FORBIDDEN_VALUE = /\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}/i;
const INTERNAL_ADDRESS = /(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w.-]*\.internal)(?::\d+)?(?:\/\S*)?/i;
