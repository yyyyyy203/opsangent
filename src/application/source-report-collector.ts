import type {
  SourceFinding,
  SourceSubagentResult,
  SourceSubagentStatus,
  SourceSubagentType,
  ToolResponse,
} from '../contracts/index.js';

const DEFAULT_MAX_SUMMARY_BYTES = 16 * 1024;
const DEFAULT_MAX_ITEMS = 20;
const MAX_STATEMENT_CHARS = 4_096;
const MAX_TRACE_ID_CHARS = 256;

export interface SourceReportCandidate {
  summary: string;
  findings: SourceFinding[];
  businessTraceIds: string[];
  missingEvidence: string[];
}

export interface SourceReportCollector {
  observeToolResult(toolName: string, response: ToolResponse): void;
  acceptReport(candidate: SourceReportCandidate): void;
  finalize(input: {
    source: SourceSubagentType;
    startedAt: number;
    finishedAt: number;
    parentRunId: string;
    childRunId: string;
  }): SourceSubagentResult;
}

interface CaptureFact {
  status: 'committed' | 'partial';
  coverage: number;
  missingEvidence: string[];
}

export interface SourceReportCollectorOptions {
  maxSummaryBytes?: number;
  maxItems?: number;
  knownEvidenceIds?: readonly string[];
}

export class DefaultSourceReportCollector implements SourceReportCollector {
  private readonly maxSummaryBytes: number;
  private readonly maxItems: number;
  private readonly evidenceIds = new Set<string>();
  private readonly captureFacts = new Map<string, CaptureFact>();
  private accepted?: SourceReportCandidate;
  private toolCallsUsed = 0;

  public constructor(options: SourceReportCollectorOptions = {}) {
    this.maxSummaryBytes = options.maxSummaryBytes ?? DEFAULT_MAX_SUMMARY_BYTES;
    this.maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    if (!Number.isSafeInteger(this.maxSummaryBytes) || this.maxSummaryBytes <= 0) {
      throw new RangeError('maxSummaryBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxItems) || this.maxItems <= 0) {
      throw new RangeError('maxItems must be a positive safe integer');
    }
    for (const evidenceId of options.knownEvidenceIds ?? []) {
      if (isIdentifier(evidenceId) && this.evidenceIds.size < this.maxItems) this.evidenceIds.add(evidenceId);
    }
  }

  public observeToolResult(toolName: string, response: ToolResponse): void {
    if (toolName.length === 0) throw new Error('toolName is required');
    this.toolCallsUsed += 1;
    if (response.isError === true) return;

    for (const evidenceId of response.evidenceIds ?? []) {
      if (isIdentifier(evidenceId)) this.evidenceIds.add(evidenceId);
    }
    for (const block of response.blocks) {
      if (block.type !== 'json' || !isRecord(block.value)) continue;
      const evidenceId = typeof block.value.evidenceId === 'string' ? block.value.evidenceId : undefined;
      if (evidenceId === undefined || !this.evidenceIds.has(evidenceId)) continue;
      const status = block.value.status === 'partial' || block.value.status === 'committed'
        ? block.value.status
        : undefined;
      const coverage = typeof block.value.coverage === 'number' && Number.isFinite(block.value.coverage)
        ? Math.min(1, Math.max(0, block.value.coverage))
        : undefined;
      if (status === undefined && coverage === undefined) continue;
      const previous = this.captureFacts.get(evidenceId);
      this.captureFacts.set(evidenceId, {
        status: status ?? previous?.status ?? 'committed',
        coverage: coverage ?? previous?.coverage ?? 1,
        missingEvidence: uniqueStrings([
          ...(previous?.missingEvidence ?? []),
          ...boundedStrings(block.value.missingEvidence, this.maxItems),
        ], this.maxItems),
      });
    }
  }

  public acceptReport(candidate: SourceReportCandidate): void {
    if (!isRecord(candidate) || typeof candidate.summary !== 'string') {
      throw new SourceReportValidationError('report summary is required');
    }
    if (!Array.isArray(candidate.findings) || !Array.isArray(candidate.businessTraceIds)
      || !Array.isArray(candidate.missingEvidence)) {
      throw new SourceReportValidationError('report arrays are required');
    }
    const findings = candidate.findings.slice(0, this.maxItems).map((finding) => this.normalizeFinding(finding));
    const cited = findings.flatMap((finding) => finding.evidenceIds);
    for (const evidenceId of cited) {
      if (!this.evidenceIds.has(evidenceId)) throw new SourceReportValidationError(`unknown evidence reference: ${evidenceId}`);
    }
    this.accepted = {
      summary: truncateUtf8(candidate.summary, this.maxSummaryBytes),
      findings,
      businessTraceIds: uniqueStrings(
        candidate.businessTraceIds.filter((value): value is string => typeof value === 'string')
          .map((value) => value.slice(0, MAX_TRACE_ID_CHARS)),
        this.maxItems,
      ),
      missingEvidence: uniqueStrings(boundedStrings(candidate.missingEvidence, this.maxItems), this.maxItems),
    };
  }

  public finalize(input: {
    source: SourceSubagentType;
    startedAt: number;
    finishedAt: number;
    parentRunId: string;
    childRunId: string;
  }): SourceSubagentResult {
    if (input.parentRunId.length === 0 || input.childRunId.length === 0) throw new Error('source run identities are required');
    const evidenceIds = [...this.evidenceIds].slice(0, this.maxItems);
    const facts = evidenceIds.map((evidenceId) => this.captureFacts.get(evidenceId));
    const coverage = evidenceIds.length === 0
      ? 0
      : Math.min(...facts.map((fact) => fact?.coverage ?? 1));
    const missingEvidence = uniqueStrings([
      ...facts.flatMap((fact) => fact?.missingEvidence ?? []),
      ...(this.accepted?.missingEvidence ?? []),
    ], this.maxItems);
    const hasPartialCapture = facts.some((fact) => fact?.status === 'partial');
    const status: SourceSubagentStatus = evidenceIds.length === 0
      ? 'unavailable'
      : this.accepted === undefined || hasPartialCapture || missingEvidence.length > 0
        ? 'partial'
        : 'complete';
    return {
      source: input.source,
      status,
      summary: this.accepted?.summary ?? '没有形成可验证的来源报告。',
      findings: this.accepted?.findings ?? [],
      evidenceIds,
      businessTraceIds: this.accepted?.businessTraceIds ?? [],
      missingEvidence,
      coverage,
      toolCallsUsed: this.toolCallsUsed,
      durationMs: Math.max(0, input.finishedAt - input.startedAt),
    };
  }

  private normalizeFinding(value: SourceFinding): SourceFinding {
    if (!isRecord(value) || (value.kind !== 'observation' && value.kind !== 'inference')
      || typeof value.statement !== 'string' || !Array.isArray(value.evidenceIds)) {
      throw new SourceReportValidationError('invalid source finding');
    }
    return {
      kind: value.kind,
      statement: value.statement.slice(0, MAX_STATEMENT_CHARS),
      evidenceIds: uniqueStrings(
        value.evidenceIds.filter((evidenceId): evidenceId is string => typeof evidenceId === 'string'),
        this.maxItems,
      ),
    };
  }
}

export class SourceReportValidationError extends Error {
  public readonly code = 'POLICY_DENIED';

  public constructor(message: string) {
    super(message);
    this.name = 'SourceReportValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TRACE_ID_CHARS;
}

function boundedStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    .map((item) => truncateUtf8(item, MAX_STATEMENT_CHARS))
    .slice(0, limit);
}

function uniqueStrings(values: readonly string[], limit: number): string[] {
  return [...new Set(values)].slice(0, limit);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  for (const character of Array.from(value)) {
    const next = result + character;
    if (Buffer.byteLength(next, 'utf8') > maxBytes) break;
    result = next;
  }
  return result;
}
