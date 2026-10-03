import { describe, expect, it } from 'vitest';
import { LogsSourceReportCollector } from '../src/application/logs-source-report-collector.js';
import { attachSourceEvidenceObservation } from '../src/application/source-evidence-observation.js';
import type { SourceReportCandidate, SourceReportFinalizeInput } from '../src/application/source-report-collector.js';
import type { SourceSubagentRequest, ToolResponse } from '../src/contracts/index.js';

const request: SourceSubagentRequest = {
  profileId: 'simulation', service: 'checkout',
  start: '2026-10-03T00:00:00.000Z', end: '2026-10-03T00:05:00.000Z',
  question: '检查结算日志', evidenceIds: [],
};
const finalizeInput: SourceReportFinalizeInput = {
  source: 'logs', startedAt: 1_000, finishedAt: 1_250,
  parentRunId: 'parent-1', childRunId: 'child-1',
};

function captureResponse(input: {
  evidenceId?: string;
  recordCount?: number;
  exceptionCount?: number;
  traceIds?: string[];
  state?: 'committed' | 'partial';
  coverage?: number;
  truncated?: boolean;
  timeRange?: { start: string; end: string };
} = {}): ToolResponse {
  const evidenceId = input.evidenceId ?? 'log-e1';
  const value = {
    evidenceId,
    status: input.state ?? 'committed',
    recordCount: input.recordCount ?? 100,
    sourceBytes: 40_960,
    coverage: input.coverage ?? 1,
    truncated: input.truncated ?? false,
    missingEvidence: [],
    levels: [{ value: 'ERROR', count: input.exceptionCount ?? 15 }, { value: 'INFO', count: (input.recordCount ?? 100) - (input.exceptionCount ?? 15) }],
    services: [{ value: 'checkout', count: input.recordCount ?? 100 }],
    exceptionSignatures: [{ value: 'SQLTimeoutException', count: input.exceptionCount ?? 15 }],
    traceIds: input.traceIds ?? ['trace-1'],
    samples: [],
  };
  return attachSourceEvidenceObservation({
    blocks: [{ type: 'json', value }, { type: 'evidence_ref', evidenceId }],
    evidenceIds: [evidenceId],
  }, {
    schemaVersion: 1,
    source: 'logs',
    evidenceId,
    state: input.state ?? 'committed',
    coverage: input.coverage ?? 1,
    timeRange: input.timeRange ?? { start: request.start, end: request.end },
    missingEvidence: [],
  });
}

function aggregateResponse(input: {
  evidenceId?: string;
  recordCount?: number;
  exceptionCount?: number;
  traceIds?: string[];
  emptyDistributions?: boolean;
} = {}): ToolResponse {
  const evidenceId = input.evidenceId ?? 'log-e1';
  const count = input.recordCount ?? 100;
  const exceptionCount = input.exceptionCount ?? 15;
  return {
    blocks: [{ type: 'json', value: {
      evidenceId, recordCount: count,
      levels: input.emptyDistributions === true ? [] : [{ value: 'ERROR', count: exceptionCount }, { value: 'INFO', count: count - exceptionCount }],
      services: input.emptyDistributions === true ? [] : [{ value: 'checkout', count }],
      exceptionSignatures: input.emptyDistributions === true ? [] : [{ value: 'SQLTimeoutException', count: exceptionCount }],
      traceIds: input.traceIds ?? ['trace-1'],
    } }],
    evidenceIds: [evidenceId],
  };
}

function candidate(input: Partial<SourceReportCandidate> = {}): SourceReportCandidate {
  return {
    summary: '模型声称 999 条错误，根因已确认。',
    findings: [{ kind: 'observation', statement: '数据库是已确认根因。', evidenceIds: ['log-e1'] }],
    businessTraceIds: ['trace-1'],
    missingEvidence: [],
    ...input,
  };
}

function collector(): LogsSourceReportCollector {
  return new LogsSourceReportCollector({ request });
}

describe('LogsSourceReportCollector', () => {
  it('renders observed counts deterministically and never promotes model prose to fact', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse());
    subject.acceptReport(candidate({
      findings: [
        { kind: 'observation', statement: '数据库是已确认根因。', evidenceIds: ['log-e1'] },
        { kind: 'inference', statement: 'SQL 超时可能与结算异常有关，但未验证完整链路。', evidenceIds: ['log-e1'] },
      ],
    }));

    const result = subject.finalize(finalizeInput);

    expect(result.summary).toContain('100');
    expect(result.summary).toContain('SQLTimeoutException');
    expect(result.summary).not.toContain('999');
    expect(result.summary).not.toContain('根因已确认');
    expect(result.findings.some((finding) => finding.kind === 'observation' && finding.statement.includes('100'))).toBe(true);
    expect(result.findings.some((finding) => finding.kind === 'observation' && finding.statement.includes('数据库'))).toBe(false);
    expect(result.findings.some((finding) => finding.kind === 'inference' && finding.statement.includes('SQL 超时'))).toBe(true);
    expect(result.businessTraceIds).toEqual(['trace-1']);
    expect(result.missingEvidence).toContain('traces');
  });

  it('returns unavailable without a successful capture even if a read tool returned an evidence ID', () => {
    const subject = collector();
    subject.observeToolResult('logs.search_evidence', {
      blocks: [{ type: 'json', value: { evidenceId: 'old-evidence', records: [] } }], evidenceIds: ['old-evidence'],
    });

    expect(subject.finalize(finalizeInput)).toMatchObject({ status: 'unavailable', evidenceIds: [], coverage: 0 });
  });

  it('returns unavailable when a complete capture contains no records', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse({ recordCount: 0, exceptionCount: 0, traceIds: [] }));
    subject.acceptReport(candidate({ businessTraceIds: [] }));

    expect(subject.finalize(finalizeInput)).toMatchObject({ status: 'unavailable', missingEvidence: ['no_log_records', 'traces'] });
  });

  it('keeps an incomplete zero-record capture partial instead of downgrading it to unavailable', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse({
      recordCount: 0, exceptionCount: 0, traceIds: [], state: 'partial', coverage: 0.4, truncated: true,
    }));
    subject.acceptReport(candidate({ businessTraceIds: [] }));

    const result = subject.finalize(finalizeInput);
    expect(result.status).toBe('partial');
    expect(result.missingEvidence).toContain('log_capture_partial');
    expect(result.missingEvidence).toContain('log_capture_truncated');
    expect(result.coverage).toBe(0.4);
  });

  it('remains partial when a capture is partial or truncated despite a complete model report', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse({ state: 'partial', coverage: 0.7, truncated: true }));
    subject.acceptReport(candidate());

    expect(subject.finalize(finalizeInput)).toMatchObject({
      status: 'partial', evidenceIds: ['log-e1'], coverage: 0.7,
    });
  });

  it('records truncation explicitly even when the upstream state says committed', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse({ truncated: true }));
    subject.acceptReport(candidate());

    expect(subject.finalize(finalizeInput).missingEvidence).toContain('log_capture_truncated');
  });

  it('returns partial when the actual capture window differs from the request', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse({
      timeRange: { start: '2026-10-02T23:55:00.000Z', end: request.end },
    }));
    subject.acceptReport(candidate());

    const result = subject.finalize(finalizeInput);
    expect(result.status).toBe('partial');
    expect(result.missingEvidence).toContain('capture_window_mismatch');
  });

  it('returns partial when the source report was never submitted', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse());

    const result = subject.finalize(finalizeInput);
    expect(result.status).toBe('partial');
    expect(result.missingEvidence).toContain('source_report');
  });

  it('bounds model-provided missing-evidence strings', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse());
    subject.acceptReport(candidate({ missingEvidence: ['x'.repeat(5_000)] }));

    const result = subject.finalize(finalizeInput);
    expect(result.missingEvidence.some((item) => item.length > 4_096)).toBe(false);
    expect(result.missingEvidence.some((item) => item.length === 4_096)).toBe(true);
  });

  it('rejects a report that cites evidence not observed by this child', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse());

    expectToThrowWithCode(() => subject.acceptReport(candidate({
      findings: [{ kind: 'inference', statement: '猜测', evidenceIds: ['invented-evidence'] }],
    })), 'POLICY_DENIED');
  });

  it('rejects a business trace ID not returned by capture or aggregation', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse());

    expectToThrowWithCode(() => subject.acceptReport(candidate({ businessTraceIds: ['invented-trace'] })), 'POLICY_DENIED');
  });

  it('does not combine distinct capture snapshots into a complete report or total', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse({ evidenceId: 'log-e1', recordCount: 100 }));
    subject.observeToolResult('logs.capture', captureResponse({ evidenceId: 'log-e2', recordCount: 100 }));
    subject.acceptReport(candidate({
      findings: [{ kind: 'inference', statement: '两次采集都看到 SQL 超时。', evidenceIds: ['log-e1', 'log-e2'] }],
    }));

    const result = subject.finalize(finalizeInput);

    expect(result.status).toBe('partial');
    expect(result.missingEvidence).toContain('multiple_log_snapshots');
    expect(result.summary).not.toContain('200');
    expect(result.evidenceIds).toEqual(['log-e1', 'log-e2']);
  });

  it('rejects aggregate results for evidence not captured in this child', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse());

    expectToThrowWithCode(
      () => subject.observeToolResult('logs.aggregate_evidence', aggregateResponse({ evidenceId: 'other-evidence' })),
      'MCP_PROTOCOL_ERROR',
    );
  });

  it('uses aggregate facts only when they match the captured evidence count', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse());
    subject.observeToolResult('logs.aggregate_evidence', aggregateResponse({ traceIds: ['trace-aggregate'] }));
    subject.acceptReport(candidate());

    const result = subject.finalize(finalizeInput);

    expect(result.summary).toContain('trace-aggregate');
    expect(result.summary).toContain('100');
    expect(result.businessTraceIds).toEqual(['trace-1', 'trace-aggregate']);
    expect(result.findings[0]?.evidenceIds).toEqual(['log-e1']);
  });

  it('marks mismatched aggregate counts partial and does not use them as capture totals', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse());
    subject.observeToolResult('logs.aggregate_evidence', aggregateResponse({ recordCount: 42, exceptionCount: 7 }));
    subject.acceptReport(candidate());

    const result = subject.finalize(finalizeInput);

    expect(result.status).toBe('partial');
    expect(result.missingEvidence).toContain('aggregate_snapshot_mismatch');
    expect(result.summary).toContain('100');
    expect(result.summary).not.toContain('42');
  });

  it('rejects aggregate distributions that disagree with the same captured snapshot', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse());
    subject.observeToolResult('logs.aggregate_evidence', aggregateResponse({ exceptionCount: 30 }));
    subject.acceptReport(candidate());

    const result = subject.finalize(finalizeInput);

    expect(result.status).toBe('partial');
    expect(result.missingEvidence).toContain('aggregate_snapshot_mismatch');
    expect(result.summary).toContain('SQLTimeoutException 15 条');
    expect(result.summary).not.toContain('SQLTimeoutException 30 条');
  });

  it('rejects empty aggregate distributions that would erase captured facts', () => {
    const subject = collector();
    subject.observeToolResult('logs.capture', captureResponse());
    subject.observeToolResult('logs.aggregate_evidence', aggregateResponse({ emptyDistributions: true }));
    subject.acceptReport(candidate());

    const result = subject.finalize(finalizeInput);
    expect(result.missingEvidence).toContain('aggregate_snapshot_mismatch');
    expect(result.summary).toContain('ERROR 15 条');
    expect(result.summary).toContain('SQLTimeoutException 15 条');
    expect(result.summary).not.toContain('无等级分布');
    expect(result.summary).not.toContain('未观察到异常签名');
  });
});

function expectToThrowWithCode(action: () => unknown, code: string): void {
  let caught: unknown;
  try { action(); } catch (error: unknown) { caught = error; }
  expect(caught).toMatchObject({ code });
}
