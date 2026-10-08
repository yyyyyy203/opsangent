import type {
  AgentEventEnvelopeV2,
  PublicEvidenceView,
  PublicRunDetail,
  SourceSubagentRequest,
  SourceSubagentResult,
  ToolResponse,
} from '../../src/contracts/index.js';
import { attachSourceEvidenceObservation } from '../../src/application/source-evidence-observation.js';
import { LogsSourceReportCollector } from '../../src/application/logs-source-report-collector.js';
import { MetricsSourceReportCollector } from '../../src/application/metrics-source-report-collector.js';
import type { SourceReportFinalizeInput } from '../../src/application/source-report-collector.js';
import { summarizeRunUsage } from '../../src/contracts/run-usage.js';
import { assessSettlementMetrics, settlementMetricsLabProfile, type SettlementMetricFact } from '../../src/profiles/settlement.js';
import type { AcceptanceCaseId, AcceptanceInput } from '../../src/acceptance/types.js';

const windowStart = '2026-10-04T11:55:00.000Z';
const windowEnd = '2026-10-04T12:00:00.000Z';
const startSeconds = Date.parse(windowStart) / 1_000;
const endSeconds = Date.parse(windowEnd) / 1_000;
const sequenceByRun = new Map<string, number>();

interface CaseMetric {
  readonly total: number;
  readonly failed: number;
}

const metricByCase: Readonly<Record<AcceptanceCaseId, CaseMetric>> = {
  normal: { total: 100, failed: 0 },
  settlement_failure: { total: 100, failed: 15 },
  low_sample: { total: 10, failed: 8 },
  logs_offline: { total: 100, failed: 15 },
  capture_window_mismatch: { total: 100, failed: 15 },
};

export function createAcceptanceFixture(caseId: AcceptanceCaseId): AcceptanceInput {
  sequenceByRun.clear();
  const parentRunId = `acceptance-${caseId}-parent`;
  const metricsChildRunId = `acceptance-${caseId}-metrics-child`;
  const logsChildRunId = `acceptance-${caseId}-logs-child`;
  const metricsToolCallId = `acceptance-${caseId}-metrics-call`;
  const logsToolCallId = `acceptance-${caseId}-logs-call`;
  const evidence = buildEvidence(caseId, metricsChildRunId, logsChildRunId);
  const metricFact = buildMetricFact(caseId);
  const reports = buildReports(caseId, parentRunId, metricsChildRunId, logsChildRunId, metricFact);
  const childBySource = { metrics: metricsChildRunId, logs: logsChildRunId } as const;
  const toolCallBySource = { metrics: metricsToolCallId, logs: logsToolCallId } as const;
  const events: AgentEventEnvelopeV2[] = [];

  events.push(event('RUN_STARTED', {
    profile: 'simulation', trigger: 'acceptance_fixture', deadline: '2026-10-04T12:01:30.000Z', versionSnapshot: {},
  }, { runId: parentRunId, streamId: 'parent-stream-1' }));
  events.push(event('MODEL_CALL_STARTED', {
    provider: 'fixture', model: 'scripted', purpose: 'diagnosis', attempt: 1, inputSummary: 'bounded fixture input',
  }, { runId: parentRunId, streamId: 'parent-stream-1', attemptId: 'parent-model-attempt' }));
  events.push(event('MODEL_CALL_COMPLETED', {
    provider: 'fixture', model: 'scripted', attempt: 1, usage: { inputTokens: 100, outputTokens: 40 }, durationMs: 5,
    finishReason: 'stop',
  }, { runId: parentRunId, streamId: 'parent-stream-1', attemptId: 'parent-model-attempt' }));

  for (const source of ['metrics', 'logs'] as const) {
    const childRunId = childBySource[source];
    const toolCallId = toolCallBySource[source];
    const report = reports.find((item) => item.source === source)!;
    const toolName = `${source}_subagent`;
    events.push(event('TOOL_STARTED', { toolName, source: 'subagent', attempt: 1 }, {
      runId: parentRunId, streamId: 'parent-stream-1', toolCallId, attemptId: `${toolCallId}-attempt`,
    }));
    events.push(event('SUBAGENT_STARTED', {
      subagentType: source, childRunId, parentRunId,
      budget: { type: 'tool_calls', limit: 4, used: 0 },
    }, { runId: childRunId, parentRunId, streamId: 'parent-stream-1', toolCallId }));
    events.push(event('RUN_STARTED', {
      profile: 'simulation', trigger: `${source}_child`, deadline: '2026-10-04T12:00:30.000Z', versionSnapshot: {},
    }, { runId: childRunId, parentRunId, streamId: `${source}-stream-1` }));
    events.push(event('MODEL_CALL_STARTED', {
      provider: 'fixture', model: `scripted-${source}`, purpose: 'evidence_collection', attempt: 1,
      inputSummary: 'bounded fixture input',
    }, { runId: childRunId, parentRunId, streamId: `${source}-stream-1`, attemptId: `${source}-model-attempt` }));
    events.push(event('MODEL_CALL_COMPLETED', {
      provider: 'fixture', model: `scripted-${source}`, attempt: 1, usage: { inputTokens: 50, outputTokens: 20 },
      durationMs: 3, finishReason: 'stop',
    }, { runId: childRunId, parentRunId, streamId: `${source}-stream-1`, attemptId: `${source}-model-attempt` }));

    const unavailable = report.status === 'unavailable';
    events.push(unavailable
      ? event('SUBAGENT_FAILED', {
        childRunId, error: { code: 'UNAVAILABLE', message: 'Source unavailable.', retryable: false }, partialEvidenceIds: [],
      }, { runId: childRunId, parentRunId, streamId: 'parent-stream-1', toolCallId })
      : event('SUBAGENT_COMPLETED', {
        childRunId,
        status: report.status === 'partial' ? 'partial' : 'completed',
        evidenceIds: report.evidenceIds,
        coverage: report.coverage,
      }, { runId: childRunId, parentRunId, streamId: 'parent-stream-1', toolCallId }));
    events.push(event('RUN_FINISHED', { outcome: 'complete', durationMs: 8 }, {
      runId: childRunId, parentRunId, streamId: `${source}-stream-1`,
    }));
    const response: ToolResponse = {
      blocks: [
        { type: 'json', value: report },
        ...report.evidenceIds.map((evidenceId) => ({ type: 'evidence_ref' as const, evidenceId })),
      ],
      evidenceIds: report.evidenceIds,
      ...(unavailable ? { isError: true } : {}),
    };
    events.push(event('TOOL_RESULT', {
      result: {
        toolCallId, toolName, status: unavailable ? 'failed' : 'success',
        response,
        startedAt: '2026-10-04T12:00:00.000Z', finishedAt: '2026-10-04T12:00:00.008Z',
      },
      durationMs: 8, evidenceIds: report.evidenceIds,
    }, { runId: parentRunId, streamId: 'parent-stream-1', toolCallId, attemptId: `${toolCallId}-attempt` }));
  }

  events.push(event('RUN_FINISHED', {
    outcome: 'partial', usage: { inputTokens: 200, outputTokens: 80 }, usageCompleteness: 'complete', durationMs: 20,
  }, { runId: parentRunId, streamId: 'parent-stream-1' }));
  const reportBySource = new Map(reports.map((report) => [report.source, report]));
  const children = [
    publicRun(metricsChildRunId, parentRunId, reportBySource.get('metrics')?.evidenceIds ?? []),
    publicRun(logsChildRunId, parentRunId, reportBySource.get('logs')?.evidenceIds ?? []),
  ];
  const parent: PublicRunDetail = {
    ...publicRun(parentRunId, undefined, evidence.map((item) => item.evidenceId)),
    childRunIds: [metricsChildRunId, logsChildRunId],
    missingEvidence: missingCodes(caseId, reports),
    usage: summarizeRunUsage(events.filter((item) => item.runId === parentRunId)),
  };
  const childDetails = children.map((child) => ({
    ...child,
    usage: summarizeRunUsage(events.filter((item) => item.runId === child.runId)),
  }));

  return {
    caseId,
    parent,
    children: childDetails,
    evidence,
    events,
    codeRevision: 'fixture-revision-1',
    sourceFingerprint: 'a'.repeat(64),
    profileRevision: 'simulation-v1',
    snapshotId: `snapshot-${caseId}`,
    reports,
    metricFact,
    budget: { limit: 10, attempted: 3, sent: 3, rejected: 0 },
    exportDiagnostics: { pending: 0, dropped: 0, counts: {} },
    traceVerification: { status: 'verified', checkedSpanCount: 8 },
    manualReview: { status: 'pending' },
    boundaryChecks: { publicDataSafe: true, traceExportSafe: true },
  };
}

function buildReports(
  caseId: AcceptanceCaseId,
  parentRunId: string,
  metricsChildRunId: string,
  logsChildRunId: string,
  metricFact: SettlementMetricFact,
): SourceSubagentResult[] {
  const request: SourceSubagentRequest = {
    profileId: 'simulation', service: 'checkout', start: windowStart, end: windowEnd,
    question: '验证结算指标与日志证据。', evidenceIds: [],
  };
  const metricEvidenceId = `metric-evidence-${caseId}`;
  const metrics = new MetricsSourceReportCollector({ request, profile: settlementMetricsLabProfile });
  metrics.observeToolResult('metrics.settlement', metricResponse(metricFact, metricEvidenceId));
  metrics.acceptReport({
    summary: '指标采集已由确定性 Collector 校验。',
    findings: [{ kind: 'observation', statement: '采集到结算指标。', evidenceIds: [metricEvidenceId] }],
    businessTraceIds: [], missingEvidence: [],
  });
  const metricResult = metrics.finalize(finalizeInput('metrics', parentRunId, metricsChildRunId));

  const logs = new LogsSourceReportCollector({ request });
  const logEvidenceId = `log-evidence-${caseId}`;
  if (caseId !== 'logs_offline') {
    const timeRange = caseId === 'capture_window_mismatch'
      ? { start: '2026-10-04T11:50:00.000Z', end: '2026-10-04T11:55:00.000Z' }
      : { start: windowStart, end: windowEnd };
    logs.observeToolResult('logs.capture', logCaptureResponse(logEvidenceId, timeRange));
    logs.acceptReport({
      summary: '日志采集已由确定性 Collector 校验。',
      findings: [{ kind: 'observation', statement: '采集到日志摘要。', evidenceIds: [logEvidenceId] }],
      businessTraceIds: [], missingEvidence: [],
    });
  }
  const logsResult = logs.finalize(finalizeInput('logs', parentRunId, logsChildRunId));
  return [metricResult, logsResult];
}

function metricResponse(fact: SettlementMetricFact, evidenceId: string): ToolResponse {
  return attachSourceEvidenceObservation({
    blocks: [{ type: 'json', value: fact }, { type: 'evidence_ref', evidenceId }],
    evidenceIds: [evidenceId],
  }, {
    schemaVersion: 1, source: 'metrics', evidenceId, state: 'committed', coverage: 1,
    timeRange: { start: new Date(fact.start * 1_000).toISOString(), end: new Date(fact.end * 1_000).toISOString() },
    missingEvidence: [],
  });
}

function logCaptureResponse(evidenceId: string, timeRange: { start: string; end: string }): ToolResponse {
  const value = {
    evidenceId, status: 'committed', recordCount: 30, sourceBytes: 12_000, coverage: 1,
    truncated: false, missingEvidence: [],
    levels: [{ value: 'ERROR', count: 4 }, { value: 'INFO', count: 26 }],
    services: [{ value: 'checkout', count: 30 }],
    exceptionSignatures: [{ value: 'TimeoutException', count: 4 }],
    traceIds: ['trace-fixture-1'], samples: [],
  };
  return attachSourceEvidenceObservation({
    blocks: [{ type: 'json', value }, { type: 'evidence_ref', evidenceId }], evidenceIds: [evidenceId],
  }, {
    schemaVersion: 1, source: 'logs', evidenceId, state: 'committed', coverage: 1, timeRange,
    missingEvidence: [],
  });
}

function buildMetricFact(caseId: AcceptanceCaseId): SettlementMetricFact {
  const selected = metricByCase[caseId];
  const assessed = assessSettlementMetrics(selected, settlementMetricsLabProfile);
  return {
    status: assessed.status,
    total: assessed.total,
    failed: assessed.failed,
    failureRate: assessed.failureRate,
    threshold: assessed.threshold,
    minSamples: assessed.minSamples,
    service: 'checkout', environment: 'simulation', start: startSeconds, end: endSeconds,
  };
}

function buildEvidence(
  caseId: AcceptanceCaseId,
  metricsChildRunId: string,
  logsChildRunId: string,
): PublicEvidenceView[] {
  const metricFact = buildMetricFact(caseId);
  const evidence: PublicEvidenceView[] = [{
    evidenceId: `metric-evidence-${caseId}`, runId: metricsChildRunId, source: 'metric', state: 'committed',
    capturedAt: windowEnd, summary: { ...metricFact, missingEvidence: ['logs', 'traces'] },
    coverage: 1, timeRange: { start: windowStart, end: windowEnd }, rawSha256: 'f'.repeat(64),
    traceIdCount: 0, retrievable: false,
  }];
  if (caseId !== 'logs_offline') {
    const mismatch = caseId === 'capture_window_mismatch';
    evidence.push({
      evidenceId: `log-evidence-${caseId}`, runId: logsChildRunId, source: 'log', state: mismatch ? 'partial' : 'committed',
      capturedAt: windowEnd, summary: {
        recordCount: 30, sourceBytes: 4096, storedBytes: 1024, coverage: 1, truncated: false, missingEvidence: [],
      }, coverage: 1,
      timeRange: mismatch
        ? { start: '2026-10-04T11:50:00.000Z', end: '2026-10-04T11:55:00.000Z' }
        : { start: windowStart, end: windowEnd },
      rawSha256: 'e'.repeat(64), traceIdCount: 1, retrievable: false,
    });
  }
  return evidence;
}

function publicRun(runId: string, parentRunId: string | undefined, evidenceIds: readonly string[]): PublicRunDetail {
  return {
    runId, profileId: 'simulation', status: 'completed', stage: 'postmortem', contextVersion: 1,
    createdAt: '2026-10-04T12:00:00.000Z', updatedAt: '2026-10-04T12:00:00.020Z', evidenceIds,
    missingEvidence: [], childRunIds: [], ...(parentRunId === undefined ? {} : { parentRunId }),
  };
}

function missingCodes(_caseId: AcceptanceCaseId, reports: readonly SourceSubagentResult[]): string[] {
  return [...new Set(reports.flatMap((report) => report.missingEvidence)
    .filter((item) => /^[a-z][a-z0-9_]{0,63}$/u.test(item)))];
}

function finalizeInput(
  source: 'metrics' | 'logs',
  parentRunId: string,
  childRunId: string,
): SourceReportFinalizeInput {
  return { source, startedAt: 0, finishedAt: 8, parentRunId, childRunId };
}

function event<T extends AgentEventEnvelopeV2['type']>(
  type: T,
  payload: AgentEventEnvelopeV2<T>['payload'],
  context: { runId: string; parentRunId?: string; streamId?: string; toolCallId?: string; attemptId?: string },
): AgentEventEnvelopeV2<T> {
  const sequence = (sequenceByRun.get(context.runId) ?? 0) + 1;
  sequenceByRun.set(context.runId, sequence);
  const { runId, ...optionalContext } = context;
  return {
    schemaVersion: 2, eventId: `${context.runId}-${sequence}`, sequence, type, payload,
    runId, correlationId: 'acceptance-correlation', timestamp: '2026-10-04T12:00:00.000Z',
    visibility: 'audit', durability: 'durable', ...optionalContext,
  } as AgentEventEnvelopeV2<T>;
}
