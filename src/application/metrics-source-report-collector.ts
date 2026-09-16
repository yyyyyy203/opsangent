import type {
  SourceEvidenceObservation,
  SourceSubagentRequest,
  SourceSubagentResult,
  ToolResponse,
} from '../contracts/index.js';
import { assessSettlementMetrics, type SettlementMetricFact, type SettlementMetricsProfile } from '../profiles/settlement.js';
import { readSourceEvidenceObservation } from './source-evidence-observation.js';
import {
  DefaultSourceReportCollector,
  SourceReportValidationError,
  type SourceReportCandidate,
  type SourceReportCollector,
  type SourceReportFinalizeInput,
} from './source-report-collector.js';

const METRIC_TOOL_NAME = 'metrics.settlement';

export interface MetricsSourceReportCollectorOptions {
  request: SourceSubagentRequest;
  profile: SettlementMetricsProfile;
}

interface MetricObservation {
  evidenceId: string;
  fact: SettlementMetricFact;
  observation: SourceEvidenceObservation;
  windowMatchesRequest: boolean;
  coverage: number;
}

export class MetricsSourceReportCollector implements SourceReportCollector {
  private readonly delegate = new DefaultSourceReportCollector();
  private readonly requestStart: number;
  private readonly requestEnd: number;
  private readonly observations: MetricObservation[] = [];
  private reportAccepted = false;
  private toolCallsUsed = 0;

  public constructor(private readonly options: MetricsSourceReportCollectorOptions) {
    if (options.request.profileId !== options.profile.profileId || options.request.service !== options.profile.service) {
      throw new MetricsSourceReportPolicyError('request is outside the injected metrics profile');
    }
    this.requestStart = parseTimestamp(options.request.start, 'request start');
    this.requestEnd = parseTimestamp(options.request.end, 'request end');
    if (this.requestStart >= this.requestEnd || this.requestEnd - this.requestStart !== options.profile.windowSeconds) {
      throw new MetricsSourceReportProtocolError('request window does not match the metrics profile');
    }
  }

  public observeToolResult(toolName: string, response: ToolResponse): void {
    this.toolCallsUsed += 1;
    this.delegate.observeToolResult(toolName, response);
    if (toolName !== METRIC_TOOL_NAME || response.isError === true) return;

    const observation = readSourceEvidenceObservation(response);
    if (observation === undefined || observation.source !== 'metrics') {
      throw new MetricsSourceReportProtocolError('metrics response requires source evidence metadata');
    }
    if (response.evidenceIds?.length !== 1 || response.evidenceIds[0] !== observation.evidenceId
      || response.blocks.filter((block) => block.type === 'evidence_ref' && block.evidenceId === observation.evidenceId).length !== 1) {
      throw new MetricsSourceReportProtocolError('metrics response must contain exactly one paired evidence ID');
    }
    const facts = response.blocks.filter((block) => block.type === 'json');
    if (facts.length !== 1 || facts[0]?.type !== 'json') {
      throw new MetricsSourceReportProtocolError('metrics response must contain exactly one metric fact');
    }
    const fact = parseMetricFact(facts[0].value, this.options.profile);
    validateMetricFact(fact, observation, this.options.profile);

    const overlapCoverage = intervalCoverage(fact.start, fact.end, this.requestStart, this.requestEnd);
    const windowMatchesRequest = Math.abs(fact.start - this.requestStart) <= this.options.profile.maxWindowSkewSeconds
      && fact.end <= this.requestEnd + this.options.profile.maxFutureSkewSeconds;
    this.observations.push({
      evidenceId: observation.evidenceId,
      fact,
      observation,
      windowMatchesRequest,
      coverage: overlapCoverage,
    });
  }

  public acceptReport(candidate: SourceReportCandidate): void {
    this.delegate.acceptReport(candidate);
    const observedEvidenceIds = new Set(this.observations.map((observation) => observation.evidenceId));
    const citesMetricEvidence = candidate.findings.some((finding) => finding.evidenceIds
      .some((evidenceId) => observedEvidenceIds.has(evidenceId)));
    if (!citesMetricEvidence) {
      throw new SourceReportValidationError('metrics report must cite observed metric evidence');
    }
    this.reportAccepted = true;
  }

  public finalize(input: SourceReportFinalizeInput): SourceSubagentResult {
    assertRunIdentity(input);
    if (this.observations.length === 0) return this.result(input, 'unavailable', '没有获得可验证的结算指标证据。', [], [], 0);

    const evidenceIds = this.observations.map((observation) => observation.evidenceId);
    const missingEvidence: string[] = [];
    if (!this.reportAccepted) missingEvidence.push('source_report');
    if (this.observations.length !== 1) missingEvidence.push('multiple_metric_snapshots');
    if (this.observations.some((observation) => observation.observation.state === 'partial')) missingEvidence.push('metric_evidence_partial');
    if (this.observations.some((observation) => !observation.windowMatchesRequest)) {
      missingEvidence.push('window_outside_request_tolerance');
    }
    const coverage = Math.min(...this.observations.map((observation) => observation.coverage));
    if (missingEvidence.length > 0) {
      const summary = this.observations.length === 1
        ? renderSummary(this.observations[0]!.fact)
        : '存在多个结算指标快照，不能形成单一确定性指标结论。';
      const findings = this.observations.length === 1
        ? [renderFinding(this.observations[0]!)]
        : [];
      return this.result(input, 'partial', summary, findings, evidenceIds, coverage, missingEvidence);
    }

    const metric = this.observations[0]!;
    return this.result(input, 'complete', renderSummary(metric.fact), [renderFinding(metric)], evidenceIds, coverage);
  }

  private result(
    input: SourceReportFinalizeInput,
    status: SourceSubagentResult['status'],
    summary: string,
    findings: SourceSubagentResult['findings'],
    evidenceIds: string[],
    coverage: number,
    missingEvidence: string[] = [],
  ): SourceSubagentResult {
    return {
      source: 'metrics',
      status,
      summary,
      findings,
      evidenceIds,
      businessTraceIds: [],
      missingEvidence,
      coverage,
      toolCallsUsed: this.toolCallsUsed,
      durationMs: Math.max(0, input.finishedAt - input.startedAt),
    };
  }
}

export class MetricsSourceReportProtocolError extends Error {
  public readonly code = 'MCP_PROTOCOL_ERROR';
  public readonly retryable = false;

  public constructor(message: string) {
    super(message);
    this.name = 'MetricsSourceReportProtocolError';
  }
}

export class MetricsSourceReportPolicyError extends Error {
  public readonly code = 'POLICY_DENIED';
  public readonly retryable = false;

  public constructor(message: string) {
    super(message);
    this.name = 'MetricsSourceReportPolicyError';
  }
}

function parseMetricFact(value: unknown, profile: SettlementMetricsProfile): SettlementMetricFact {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'status', 'total', 'failed', 'failureRate', 'threshold', 'minSamples', 'service', 'environment', 'start', 'end',
  ])) throw new MetricsSourceReportProtocolError('invalid metric fact');
  const { status, total, failed, failureRate, threshold, minSamples, service, environment, start, end } = value;
  if ((status !== 'healthy' && status !== 'breached' && status !== 'insufficient_data')
    || !isSafeInteger(total) || !isSafeInteger(failed)
    || (failureRate !== null && typeof failureRate !== 'number')
    || typeof threshold !== 'number' || !isSafeInteger(minSamples)
    || typeof service !== 'string' || typeof environment !== 'string'
    || !isSafeInteger(start) || !isSafeInteger(end)) {
    throw new MetricsSourceReportProtocolError('invalid metric fact');
  }
  if (service !== profile.service || environment !== profile.environment) {
    throw new MetricsSourceReportProtocolError('metric fact is outside the injected profile');
  }
  return {
    status,
    total,
    failed,
    failureRate,
    threshold,
    minSamples,
    service: profile.service,
    environment: profile.environment,
    start,
    end,
  };
}

function validateMetricFact(
  fact: SettlementMetricFact,
  observation: SourceEvidenceObservation,
  profile: SettlementMetricsProfile,
): void {
  let assessed: ReturnType<typeof assessSettlementMetrics>;
  try {
    assessed = assessSettlementMetrics({ total: fact.total, failed: fact.failed }, profile);
  } catch {
    throw new MetricsSourceReportProtocolError('invalid metric counts');
  }
  if (fact.threshold !== profile.threshold || fact.minSamples !== profile.minSamples
    || fact.failureRate !== assessed.failureRate || fact.status !== assessed.status
    || fact.end - fact.start !== profile.windowSeconds
    || observation.timeRange === undefined
    || parseTimestamp(observation.timeRange.start, 'observation start') !== fact.start
    || parseTimestamp(observation.timeRange.end, 'observation end') !== fact.end) {
    throw new MetricsSourceReportProtocolError('metric fact disagrees with deterministic assessment');
  }
}

function renderSummary(fact: SettlementMetricFact): string {
  const window = `${new Date(fact.start * 1_000).toISOString()} 至 ${new Date(fact.end * 1_000).toISOString()}`;
  const rate = formatPercent(fact.failureRate);
  const threshold = formatPercent(fact.threshold);
  switch (fact.status) {
    case 'healthy':
      return `结算指标正常：${window} 共 ${fact.total} 次，失败 ${fact.failed} 次，失败率 ${rate}，未超过 ${threshold} 阈值。指标只能确认当前症状，不能单独确认根因。`;
    case 'breached':
      return `结算指标异常：${window} 共 ${fact.total} 次，失败 ${fact.failed} 次，失败率 ${rate}，超过 ${threshold} 阈值。指标只能确认当前症状，不能单独确认根因。`;
    case 'insufficient_data':
      return `结算指标样本不足：${window} 共 ${fact.total} 次，低于最小样本 ${fact.minSamples}；观测失败率为 ${rate}，不作健康或异常阈值结论。指标不能单独确认根因。`;
  }
}

function renderFinding(observation: MetricObservation): SourceSubagentResult['findings'][number] {
  return {
    kind: 'observation',
    statement: renderSummary(observation.fact),
    evidenceIds: [observation.evidenceId],
  };
}

function intervalCoverage(actualStart: number, actualEnd: number, requestedStart: number, requestedEnd: number): number {
  const overlap = Math.max(0, Math.min(actualEnd, requestedEnd) - Math.max(actualStart, requestedStart));
  return Math.min(1, Math.max(0, overlap / (requestedEnd - requestedStart)));
}

function parseTimestamp(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  const seconds = milliseconds / 1_000;
  if (!Number.isSafeInteger(seconds)) throw new MetricsSourceReportProtocolError(`invalid ${label}`);
  return seconds;
}

function assertRunIdentity(input: SourceReportFinalizeInput): void {
  if (input.parentRunId.length === 0 || input.childRunId.length === 0) {
    throw new MetricsSourceReportProtocolError('source run identities are required');
  }
}

function formatPercent(value: number | null): string {
  return value === null ? '不可用' : `${(value * 100).toFixed(2)}%`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
