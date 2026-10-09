import type {
  SourceFinding,
  SourceSubagentRequest,
  SourceSubagentResult,
  ToolResponse,
} from '../contracts/index.js';
import { projectSourceMissingEvidenceCodes } from '../contracts/missing-evidence.js';
import { readSourceEvidenceObservation } from './source-evidence-observation.js';
import {
  DefaultSourceReportCollector,
  SourceReportValidationError,
  type SourceReportCandidate,
  type SourceReportCollector,
  type SourceReportFinalizeInput,
} from './source-report-collector.js';

const MAX_ITEMS = 20;
const MAX_TRACE_IDS = 100;
const MAX_LABEL_CHARS = 1_024;
const MAX_TEXT_BYTES = 16 * 1024;
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export interface LogsSourceReportCollectorOptions {
  request: SourceSubagentRequest;
}

interface CountFact {
  value: string;
  count: number;
}

interface LogCaptureFact {
  evidenceId: string;
  service: string;
  state: 'committed' | 'partial';
  recordCount: number;
  sourceBytes: number;
  coverage: number;
  truncated: boolean;
  missingEvidence: string[];
  levels: CountFact[];
  services: CountFact[];
  exceptionSignatures: CountFact[];
  traceIds: string[];
  timeRange?: { start: string; end: string };
  issues: string[];
}

interface LogAggregateFact {
  recordCount: number;
  levels: CountFact[];
  services: CountFact[];
  exceptionSignatures: CountFact[];
  traceIds: string[];
}

interface AcceptedReport {
  inferences: SourceFinding[];
  missingEvidence: string[];
}

/**
 * Turns observed Logs ToolResponses into source facts. Model-authored summaries and
 * observation findings are deliberately not promoted; only cited inferences survive.
 */
export class LogsSourceReportCollector implements SourceReportCollector {
  private readonly delegate: DefaultSourceReportCollector;
  private readonly requestStart: number;
  private readonly requestEnd: number;
  private readonly captures = new Map<string, LogCaptureFact>();
  private readonly aggregates = new Map<string, LogAggregateFact>();
  private readonly invalidAggregates = new Set<string>();
  private readonly observedEvidenceIds = new Set<string>();
  private accepted?: AcceptedReport;
  private readonly issues = new Set<string>();

  public constructor(private readonly options: LogsSourceReportCollectorOptions) {
    this.delegate = new DefaultSourceReportCollector({ knownEvidenceIds: options.request.evidenceIds });
    this.requestStart = parseTimestamp(options.request.start, 'request start');
    this.requestEnd = parseTimestamp(options.request.end, 'request end');
    if (this.requestStart >= this.requestEnd) throw new LogsSourceReportProtocolError('request window is invalid');
  }

  public observeToolResult(toolName: string, response: ToolResponse): void {
    this.delegate.observeToolResult(toolName, response);
    if (!toolName.startsWith('logs.') || response.isError === true) return;

    if (toolName === 'logs.capture') {
      const capture = parseCapture(response, this.options.request, this.requestStart, this.requestEnd);
      this.observedEvidenceIds.add(capture.evidenceId);
      for (const issue of capture.issues) this.issues.add(issue);
      const previous = this.captures.get(capture.evidenceId);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(capture)) {
        this.issues.add('conflicting_capture_result');
        return;
      }
      if (previous === undefined) this.captures.set(capture.evidenceId, capture);
      return;
    }

    for (const evidenceId of response.evidenceIds ?? []) {
      if (isIdentifier(evidenceId)) this.observedEvidenceIds.add(evidenceId);
    }
    if (toolName === 'logs.aggregate_evidence') this.observeAggregate(response);
  }

  public acceptReport(candidate: SourceReportCandidate): void {
    this.delegate.acceptReport(candidate);
    if (candidate.findings.length === 0) throw new SourceReportValidationError('logs report must cite observed evidence');

    const actualEvidenceIds = this.observedEvidenceIds;
    for (const finding of candidate.findings) {
      if (finding.evidenceIds.length === 0 || finding.evidenceIds.some((id) => !actualEvidenceIds.has(id))) {
        throw new LogsSourceReportPolicyError('logs report must cite evidence observed by this child Run');
      }
    }
    if (candidate.businessTraceIds.some((id) => !this.collectTraceIds().includes(id))) {
      throw new LogsSourceReportPolicyError('logs report contains an unobserved Trace ID');
    }

    this.accepted = {
      // Model-authored observations are untrusted prose. Deterministic observations are rendered below.
      inferences: candidate.findings.slice(0, MAX_ITEMS).filter((finding) => finding.kind === 'inference').map((finding) => ({
        kind: 'inference',
        statement: truncateUtf8(`未验证推断：${finding.statement}`, 4_096),
        evidenceIds: [...finding.evidenceIds],
      })),
      missingEvidence: unique(candidate.missingEvidence.slice(0, MAX_ITEMS)
        .map((item) => truncateUtf8(item, 4_096)), MAX_ITEMS),
    };
  }

  public finalize(input: SourceReportFinalizeInput): SourceSubagentResult {
    const generic = this.delegate.finalize(input); // also validates parent/child Run identity
    const captures = [...this.captures.values()];
    if (captures.length === 0) {
      return this.result(generic, 'unavailable', '未获得可验证的日志采集结果。', [], [], [], 0,
        ['logs_capture_unavailable', 'traces']);
    }
    if (captures.every((capture) => capture.recordCount === 0)) {
      const missingEvidence = new Set<string>(['no_log_records', 'traces']);
      for (const capture of captures) {
        for (const issue of capture.issues) missingEvidence.add(issue);
        for (const item of capture.missingEvidence) missingEvidence.add(item);
      }
      for (const issue of this.issues) missingEvidence.add(issue);
      for (const item of generic.missingEvidence) missingEvidence.add(item);
      const incomplete = captures.some((capture) => capture.state === 'partial' || capture.coverage < 1
        || capture.truncated || capture.issues.length > 0 || capture.missingEvidence.length > 0)
        || this.issues.size > 0 || generic.missingEvidence.length > 0;
      return this.result(generic, incomplete ? 'partial' : 'unavailable',
        incomplete ? '日志采集不完整，当前没有可用记录。' : '指定窗口内未采集到日志记录。', [],
        captures.map((capture) => capture.evidenceId), [], Math.min(...captures.map((capture) => capture.coverage)),
        [...missingEvidence].slice(0, MAX_ITEMS));
    }

    const missingEvidence = new Set<string>(['traces']);
    for (const value of generic.missingEvidence) missingEvidence.add(value);
    if (this.accepted === undefined) missingEvidence.add('source_report');
    if (captures.length > 1) missingEvidence.add('multiple_log_snapshots');
    for (const capture of captures) {
      for (const issue of capture.issues) missingEvidence.add(issue);
      for (const item of capture.missingEvidence) missingEvidence.add(item);
    }
    for (const issue of this.issues) missingEvidence.add(issue);
    for (const evidence of this.accepted?.missingEvidence ?? []) missingEvidence.add(evidence);

    const summaries = captures.map((capture) => renderCapture(capture, this.aggregates.get(capture.evidenceId)));
    const summary = truncateUtf8(
      `${summaries.join('\n')}\n缺少 Trace 取证，不能确认完整调用链或根因。`,
      MAX_TEXT_BYTES,
    );
    const findings: SourceFinding[] = captures.map((capture) => ({
      kind: 'observation',
      statement: truncateUtf8(renderCapture(capture, this.aggregates.get(capture.evidenceId)), 4_096),
      evidenceIds: [capture.evidenceId],
    }));
    findings.push(...(this.accepted?.inferences ?? []));
    const evidenceIds = unique([...this.observedEvidenceIds].filter((id) =>
      captures.some((capture) => capture.evidenceId === id) || this.options.request.evidenceIds.includes(id))
      .concat(captures.map((capture) => capture.evidenceId)), MAX_ITEMS);
    const traceIds = this.collectTraceIds();
    const coverage = Math.min(...captures.map((capture) => capture.coverage));
    const status = missingEvidence.size === 0 ? 'complete' : 'partial';

    return this.result(generic, status, summary, findings.slice(0, MAX_ITEMS), evidenceIds, traceIds, coverage,
      [...missingEvidence].slice(0, MAX_ITEMS));
  }

  private observeAggregate(response: ToolResponse): void {
    const fact = parseAggregate(response);
    const capture = this.captures.get(fact.evidenceId);
    if (capture === undefined) throw new LogsSourceReportProtocolError('aggregate must cite a captured evidence ID');
    if (fact.recordCount !== capture.recordCount
      || fact.services.some((entry) => entry.value !== this.options.request.service)
      || !countsAgree(fact.levels, capture.levels)
      || !countsAgree(fact.services, capture.services)
      || !countsAgree(fact.exceptionSignatures, capture.exceptionSignatures)) {
      this.issues.add('aggregate_snapshot_mismatch');
      return;
    }
    const previous = this.aggregates.get(fact.evidenceId);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(fact)) {
      this.aggregates.delete(fact.evidenceId);
      this.invalidAggregates.add(fact.evidenceId);
      this.issues.add('conflicting_aggregate_results');
      return;
    }
    if (!this.invalidAggregates.has(fact.evidenceId)) this.aggregates.set(fact.evidenceId, fact);
  }

  private collectTraceIds(): string[] {
    return unique([
      ...[...this.captures.values()].flatMap((capture) => capture.traceIds),
      ...[...this.aggregates.values()].flatMap((aggregate) => aggregate.traceIds),
    ], MAX_TRACE_IDS);
  }

  private result(
    generic: SourceSubagentResult,
    status: SourceSubagentResult['status'],
    summary: string,
    findings: SourceFinding[],
    evidenceIds: string[],
    businessTraceIds: string[],
    coverage: number,
    missingEvidence: string[],
  ): SourceSubagentResult {
    const boundedMissingEvidence = unique(missingEvidence, MAX_ITEMS);
    return {
      source: 'logs', status, summary, findings, evidenceIds, businessTraceIds,
      missingEvidence: boundedMissingEvidence, coverage,
      missingEvidenceCodes: projectSourceMissingEvidenceCodes('logs', boundedMissingEvidence),
      toolCallsUsed: generic.toolCallsUsed, durationMs: generic.durationMs,
    };
  }
}

export class LogsSourceReportProtocolError extends Error {
  public readonly code = 'MCP_PROTOCOL_ERROR';
  public readonly retryable = false;

  public constructor(message: string) {
    super(message);
    this.name = 'LogsSourceReportProtocolError';
  }
}

export class LogsSourceReportPolicyError extends Error {
  public readonly code = 'POLICY_DENIED';
  public readonly retryable = false;

  public constructor(message: string) {
    super(message);
    this.name = 'LogsSourceReportPolicyError';
  }
}

function parseCapture(
  response: ToolResponse,
  request: SourceSubagentRequest,
  requestStart: number,
  requestEnd: number,
): LogCaptureFact {
  const value = singleJson(response, 'capture');
  const evidenceId = value.evidenceId;
  if (!isIdentifier(evidenceId) || response.evidenceIds?.length !== 1 || response.evidenceIds[0] !== evidenceId
    || response.blocks.filter((block) => block.type === 'evidence_ref' && block.evidenceId === evidenceId).length !== 1) {
    throw new LogsSourceReportProtocolError('capture must contain one paired evidence ID');
  }
  if ((value.status !== 'committed' && value.status !== 'partial') || !isSafeInteger(value.recordCount)
    || value.recordCount < 0 || !isSafeInteger(value.sourceBytes) || value.sourceBytes < 0
    || typeof value.coverage !== 'number' || !Number.isFinite(value.coverage) || value.coverage < 0 || value.coverage > 1
    || typeof value.truncated !== 'boolean') {
    throw new LogsSourceReportProtocolError('capture facts are invalid');
  }
  const missingEvidence = parseStrings(value.missingEvidence, MAX_ITEMS, 'capture missing evidence');
  const levels = parseCounts(value.levels, value.recordCount, 'capture levels');
  const services = parseCounts(value.services, value.recordCount, 'capture services');
  const exceptionSignatures = parseCounts(value.exceptionSignatures, value.recordCount, 'capture exceptions');
  const traceIds = parseTraceIds(value.traceIds);
  const observation = readSourceEvidenceObservation(response);
  if (observation !== undefined && (observation.source !== 'logs' || observation.evidenceId !== evidenceId
    || observation.state !== value.status || observation.coverage !== value.coverage)) {
    throw new LogsSourceReportProtocolError('capture observation disagrees with captured facts');
  }
  const timeRange = observation?.timeRange;
  const issues: string[] = [];
  if (timeRange === undefined) issues.push('capture_window_unverified');
  else if (parseTimestamp(timeRange.start, 'capture start') !== requestStart
    || parseTimestamp(timeRange.end, 'capture end') !== requestEnd) {
    issues.push('capture_window_mismatch');
  }
  if (value.status === 'partial') issues.push('log_capture_partial');
  if (value.coverage < 1) issues.push('log_capture_incomplete');
  if (value.truncated) issues.push('log_capture_truncated');
  if (services.some((entry) => entry.value !== request.service)) issues.push('capture_service_mismatch');

  return {
    evidenceId, service: request.service, state: value.status, recordCount: value.recordCount, sourceBytes: value.sourceBytes,
    coverage: value.coverage, truncated: value.truncated, missingEvidence, levels, services,
    exceptionSignatures, traceIds, ...(timeRange === undefined ? {} : { timeRange }), issues,
  };
}

function parseAggregate(response: ToolResponse): LogAggregateFact & { evidenceId: string } {
  const value = singleJson(response, 'aggregate');
  if (!isIdentifier(value.evidenceId) || response.evidenceIds?.length !== 1 || response.evidenceIds[0] !== value.evidenceId) {
    throw new LogsSourceReportProtocolError('aggregate must contain one paired evidence ID');
  }
  if (!isSafeInteger(value.recordCount) || value.recordCount < 0) throw new LogsSourceReportProtocolError('aggregate count is invalid');
  return {
    evidenceId: value.evidenceId,
    recordCount: value.recordCount,
    levels: parseCounts(value.levels, value.recordCount, 'aggregate levels'),
    services: parseCounts(value.services, value.recordCount, 'aggregate services'),
    exceptionSignatures: parseCounts(value.exceptionSignatures, value.recordCount, 'aggregate exceptions'),
    traceIds: parseTraceIds(value.traceIds),
  };
}

function singleJson(response: ToolResponse, label: string): Record<string, unknown> {
  const blocks = response.blocks.filter((block) => block.type === 'json');
  if (blocks.length !== 1 || blocks[0]?.type !== 'json' || !isRecord(blocks[0].value)) {
    throw new LogsSourceReportProtocolError(`${label} must contain exactly one JSON fact`);
  }
  return blocks[0].value;
}

function parseCounts(value: unknown, total: number, label: string): CountFact[] {
  if (!Array.isArray(value) || value.length > MAX_TRACE_IDS) throw new LogsSourceReportProtocolError(`${label} are invalid`);
  const result: CountFact[] = [];
  const names = new Set<string>();
  let sum = 0;
  for (const item of value) {
    if (!isRecord(item) || !isIdentifier(item.value) || item.value.length > MAX_LABEL_CHARS
      || !isSafeInteger(item.count) || item.count < 0 || names.has(item.value)) {
      throw new LogsSourceReportProtocolError(`${label} are invalid`);
    }
    names.add(item.value);
    sum += item.count;
    if (!Number.isSafeInteger(sum) || sum > total) throw new LogsSourceReportProtocolError(`${label} exceed the observed record count`);
    result.push({ value: item.value, count: item.count });
  }
  return result;
}

function parseTraceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TRACE_IDS
    || value.some((id) => !isIdentifier(id))) throw new LogsSourceReportProtocolError('Trace IDs are invalid');
  return unique(value, MAX_TRACE_IDS);
}

function countsAgree(aggregate: readonly CountFact[], captured: readonly CountFact[]): boolean {
  if (aggregate.length === 0) return captured.length === 0;
  const observed = new Map(captured.map(({ value, count }) => [value, count]));
  return aggregate.every(({ value, count }) => observed.get(value) === count);
}

function parseStrings(value: unknown, limit: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > limit
    || value.some((item) => typeof item !== 'string' || item.length === 0 || Buffer.byteLength(item, 'utf8') > 4_096)) {
    throw new LogsSourceReportProtocolError(`${label} are invalid`);
  }
  return unique(value, limit);
}

function renderCapture(capture: LogCaptureFact, aggregate: LogAggregateFact | undefined): string {
  const levels = aggregate?.levels ?? capture.levels;
  const exceptions = aggregate?.exceptionSignatures ?? capture.exceptionSignatures;
  const traces = unique([...(capture.traceIds), ...(aggregate?.traceIds ?? [])], MAX_TRACE_IDS);
  const window = capture.timeRange === undefined
    ? '时间窗未能核验'
    : `${capture.timeRange.start} 至 ${capture.timeRange.end}`;
  const levelText = levels.length === 0 ? '无等级分布' : levels.map(({ value, count }) => `${value} ${count} 条`).join('、');
  const exceptionText = exceptions.length === 0 ? '未观察到异常签名'
    : exceptions.map(({ value, count }) => `${value} ${count} 条`).join('、');
  const traceText = traces.length === 0 ? '未观察到 Trace ID' : `Trace ID：${traces.join('、')}`;
  return `${window}采集到 ${capture.recordCount} 条 ${capture.service} 日志；等级分布：${levelText}；异常分布：${exceptionText}；${traceText}。`;
}

function parseTimestamp(value: string, label: string): number {
  const match = ISO_WITH_ZONE.exec(value);
  const milliseconds = Date.parse(value);
  if (match === null || !Number.isFinite(milliseconds) || !isValidCalendarDate(match)) {
    throw new LogsSourceReportProtocolError(`${label} is invalid`);
  }
  return milliseconds;
}

function isValidCalendarDate(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function unique(values: readonly string[], limit: number): string[] {
  return [...new Set(values)].slice(0, limit);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  for (const character of Array.from(value)) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result;
}
