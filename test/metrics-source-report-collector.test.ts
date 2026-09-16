import { describe, expect, it } from 'vitest';
import { MetricsSourceReportCollector } from '../src/application/metrics-source-report-collector.js';
import { attachSourceEvidenceObservation } from '../src/application/source-evidence-observation.js';
import type {
  SourceReportCandidate,
  SourceReportFinalizeInput,
} from '../src/application/source-report-collector.js';
import type { SourceSubagentRequest, ToolResponse } from '../src/contracts/index.js';
import {
  settlementMetricsLabProfile,
  type SettlementMetricFact,
} from '../src/profiles/settlement.js';

const start = Date.parse('2026-09-15T00:00:00.000Z') / 1_000;
const end = start + 300;
const request: SourceSubagentRequest = {
  profileId: 'simulation',
  service: 'checkout',
  start: new Date(start * 1_000).toISOString(),
  end: new Date(end * 1_000).toISOString(),
  question: '结算失败率是否升高？',
  evidenceIds: [],
};
const finalizeInput: SourceReportFinalizeInput = {
  source: 'metrics',
  startedAt: 1_000,
  finishedAt: 1_250,
  parentRunId: 'parent-run-1',
  childRunId: 'child-run-1',
};

function fact(total: number, failed: number, overrides: Partial<SettlementMetricFact> = {}): SettlementMetricFact {
  const status = total < settlementMetricsLabProfile.minSamples
    ? 'insufficient_data'
    : failed / total > settlementMetricsLabProfile.threshold ? 'breached' : 'healthy';
  return {
    status,
    total,
    failed,
    failureRate: total === 0 ? null : failed / total,
    threshold: settlementMetricsLabProfile.threshold,
    minSamples: settlementMetricsLabProfile.minSamples,
    service: 'checkout',
    environment: 'simulation',
    start,
    end,
    ...overrides,
  };
}

function metricResponse(metricFact: SettlementMetricFact, evidenceId = 'metric-evidence-1', coverage = 1): ToolResponse {
  return attachSourceEvidenceObservation({
    blocks: [
      { type: 'json', value: metricFact },
      { type: 'evidence_ref', evidenceId },
    ],
    evidenceIds: [evidenceId],
  }, {
    schemaVersion: 1,
    source: 'metrics',
    evidenceId,
    state: 'committed',
    coverage,
    timeRange: {
      start: new Date(metricFact.start * 1_000).toISOString(),
      end: new Date(metricFact.end * 1_000).toISOString(),
    },
    missingEvidence: [],
  });
}

function candidate(evidenceIds: string[], summary = '模型候选摘要'): SourceReportCandidate {
  return {
    summary,
    findings: [{ kind: 'observation', statement: '模型候选发现', evidenceIds }],
    businessTraceIds: ['model-trace-id'],
    missingEvidence: ['模型建议检查日志'],
  };
}

function collector(): MetricsSourceReportCollector {
  return new MetricsSourceReportCollector({ request, profile: settlementMetricsLabProfile });
}

describe('MetricsSourceReportCollector', () => {
  it.each([
    { total: 100, failed: 0, expected: 'healthy', sourceStatus: 'complete' },
    { total: 100, failed: 15, expected: 'breached', sourceStatus: 'complete' },
    { total: 10, failed: 8, expected: 'insufficient_data', sourceStatus: 'complete' },
  ] as const)('renders the $expected metric fact deterministically', ({ total, failed, expected, sourceStatus }) => {
    const subject = collector();
    subject.observeToolResult('metrics.settlement', metricResponse(fact(total, failed)));
    subject.acceptReport(candidate(['metric-evidence-1']));

    const result = subject.finalize(finalizeInput);

    expect(result).toMatchObject({
      source: 'metrics', status: sourceStatus, evidenceIds: ['metric-evidence-1'], coverage: 1,
      businessTraceIds: [],
      findings: [{ kind: 'observation', evidenceIds: ['metric-evidence-1'] }],
    });
    expect(result.summary).toContain(expected === 'insufficient_data'
      ? `共 ${total} 次，低于最小样本 ${settlementMetricsLabProfile.minSamples}`
      : `共 ${total} 次，失败 ${failed} 次`);
    expect(result.summary).toContain(`${((failed / total) * 100).toFixed(2)}%`);
    if (expected === 'insufficient_data') {
      expect(result.summary).not.toContain('超过');
      expect(result.summary).not.toContain('结算指标异常');
    }
  });

  it('discards model numeric and root-cause prose in favor of the observed fact', () => {
    const subject = collector();
    subject.observeToolResult('metrics.settlement', metricResponse(fact(100, 15)));
    subject.acceptReport(candidate(['metric-evidence-1'], '失败率只有 1%，MySQL 是根因。'));

    const result = subject.finalize(finalizeInput);

    expect(result.summary).toContain('15.00%');
    expect(result.summary).not.toContain('1%');
    expect(result.summary).not.toContain('MySQL');
    expect(result.findings[0]?.statement).not.toContain('MySQL');
  });

  it.each([
    ['threshold differs from the Profile', fact(100, 15, { threshold: 0.01 })],
    ['minSamples differs from the Profile', fact(100, 15, { minSamples: 1 })],
    ['failureRate differs from failed divided by total', fact(100, 15, { failureRate: 0.01 })],
    ['status differs from deterministic assessment', fact(100, 15, { status: 'healthy' })],
  ])('rejects a metric fact when its %s', (_name, invalidFact) => {
    const subject = collector();

    expect(() => subject.observeToolResult('metrics.settlement', metricResponse(invalidFact))).toThrow(expect.objectContaining({
      code: 'MCP_PROTOCOL_ERROR', retryable: false,
    }));
  });

  it('returns partial when valid metric evidence has no source report', () => {
    const subject = collector();
    subject.observeToolResult('metrics.settlement', metricResponse(fact(100, 15)));

    expect(subject.finalize(finalizeInput)).toMatchObject({
      status: 'partial', evidenceIds: ['metric-evidence-1'], coverage: 1,
      missingEvidence: ['source_report'],
    });
  });

  it('rejects an empty source report and leaves the metric report unaccepted', () => {
    const subject = collector();
    subject.observeToolResult('metrics.settlement', metricResponse(fact(100, 15)));

    expect(() => subject.acceptReport({ ...candidate(['metric-evidence-1']), findings: [] })).toThrow(expect.objectContaining({
      code: 'POLICY_DENIED',
    }));
    expect(subject.finalize(finalizeInput)).toMatchObject({
      status: 'partial', missingEvidence: ['source_report'],
    });
  });

  it('rejects a source report whose known citation is not metric evidence', () => {
    const subject = collector();
    subject.observeToolResult('metrics.settlement', metricResponse(fact(100, 15)));
    subject.observeToolResult('logs.capture', {
      blocks: [{ type: 'evidence_ref', evidenceId: 'non-metric-evidence' }],
      evidenceIds: ['non-metric-evidence'],
    });

    expect(() => subject.acceptReport(candidate(['non-metric-evidence']))).toThrow(expect.objectContaining({
      code: 'POLICY_DENIED',
    }));
  });

  it('returns unavailable when no valid metric evidence was observed', () => {
    expect(collector().finalize(finalizeInput)).toMatchObject({
      status: 'unavailable', evidenceIds: [], coverage: 0,
    });
  });

  it('returns partial for conflicting metric snapshots', () => {
    const subject = collector();
    subject.observeToolResult('metrics.settlement', metricResponse(fact(100, 0), 'metric-evidence-1'));
    subject.observeToolResult('metrics.settlement', metricResponse(fact(100, 15), 'metric-evidence-2'));
    subject.acceptReport(candidate(['metric-evidence-1']));

    expect(subject.finalize(finalizeInput)).toMatchObject({
      status: 'partial', evidenceIds: ['metric-evidence-1', 'metric-evidence-2'], coverage: 1,
      missingEvidence: ['multiple_metric_snapshots'],
    });
  });

  it('returns partial with overlap coverage when the observed window exceeds request tolerance', () => {
    const subject = collector();
    const skewed = fact(100, 15, { start: start - 121, end: end - 121 });
    subject.observeToolResult('metrics.settlement', metricResponse(skewed));
    subject.acceptReport(candidate(['metric-evidence-1']));

    const result = subject.finalize(finalizeInput);

    expect(result.status).toBe('partial');
    expect(result.coverage).toBeCloseTo(179 / 300);
    expect(result.missingEvidence).toContain('window_outside_request_tolerance');
  });

  it.each([
    ['profileId', { ...request, profileId: 'another-profile' }],
    ['service', { ...request, service: 'another-service' }],
  ])('fails closed when the request %s is outside the injected Profile', (_field, invalidRequest) => {
    expect(() => new MetricsSourceReportCollector({
      request: invalidRequest,
      profile: settlementMetricsLabProfile,
    })).toThrow(expect.objectContaining({ code: 'POLICY_DENIED', retryable: false }));
  });

  it('recomputes final coverage from the metric fact interval instead of metadata', () => {
    const subject = collector();
    subject.observeToolResult('metrics.settlement', metricResponse(fact(100, 15), 'metric-evidence-1', 0.25));
    subject.acceptReport(candidate(['metric-evidence-1']));

    expect(subject.finalize(finalizeInput)).toMatchObject({ status: 'complete', coverage: 1 });
  });

  it('rejects a report that cites unknown evidence', () => {
    const subject = collector();
    subject.observeToolResult('metrics.settlement', metricResponse(fact(100, 15)));

    expect(() => subject.acceptReport(candidate(['unknown-evidence']))).toThrow(expect.objectContaining({
      code: 'POLICY_DENIED',
    }));
  });
});
