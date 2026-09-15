import { describe, expect, it } from 'vitest';
import { DefaultSourceReportCollector } from '../src/application/source-report-collector.js';

describe('source report collector', () => {
  it('rejects a report that cites evidence the child never observed', () => {
    const collector = new DefaultSourceReportCollector({ maxSummaryBytes: 16 * 1024, maxItems: 20 });
    collector.observeToolResult('logs.capture', {
      blocks: [{ type: 'json', value: { status: 'committed', evidenceId: 'evidence-1', coverage: 1 } }],
      evidenceIds: ['evidence-1'],
    });

    expect(() => collector.acceptReport({
      summary: '发现异常',
      findings: [{ kind: 'observation', statement: '异常', evidenceIds: ['evidence-2'] }],
      businessTraceIds: [],
      missingEvidence: [],
    })).toThrow(/evidence-2/);
  });

  it('computes partial status and coverage from observed capture facts', () => {
    const collector = new DefaultSourceReportCollector({ maxSummaryBytes: 16 * 1024, maxItems: 20 });
    collector.observeToolResult('logs.capture', {
      blocks: [{ type: 'json', value: {
        status: 'partial', evidenceId: 'evidence-1', coverage: 0.4, missingEvidence: ['下一页未采集'],
      } }],
      evidenceIds: ['evidence-1'],
    });
    collector.acceptReport({
      summary: '日志证据不完整，但已看到超时异常。',
      findings: [{ kind: 'observation', statement: '存在超时异常', evidenceIds: ['evidence-1'] }],
      businessTraceIds: ['trace-1'],
      missingEvidence: [],
    });

    const result = collector.finalize({
      source: 'logs', startedAt: 100, finishedAt: 250, parentRunId: 'parent-1', childRunId: 'child-1',
    });

    expect(result).toMatchObject({
      source: 'logs', status: 'partial', coverage: 0.4, evidenceIds: ['evidence-1'], durationMs: 150,
    });
    expect(result.missingEvidence).toContain('下一页未采集');
  });

  it('returns unavailable without fabricating evidence when no evidence was observed', () => {
    const collector = new DefaultSourceReportCollector({ maxSummaryBytes: 16 * 1024, maxItems: 20 });
    collector.acceptReport({ summary: '没有找到日志', findings: [], businessTraceIds: [], missingEvidence: ['日志源不可用'] });

    const result = collector.finalize({
      source: 'logs', startedAt: 100, finishedAt: 200, parentRunId: 'parent-1', childRunId: 'child-1',
    });

    expect(result.status).toBe('unavailable');
    expect(result.evidenceIds).toEqual([]);
    expect(result.coverage).toBe(0);
    expect(result.missingEvidence).toContain('日志源不可用');
  });

  it('bounds summaries, findings and trace IDs before returning a result', () => {
    const collector = new DefaultSourceReportCollector({ maxSummaryBytes: 256, maxItems: 2 });
    collector.observeToolResult('logs.capture', {
      blocks: [{ type: 'json', value: { status: 'committed', evidenceId: 'evidence-1', coverage: 1 } }],
      evidenceIds: ['evidence-1'],
    });
    collector.acceptReport({
      summary: 'x'.repeat(10_000),
      findings: [
        { kind: 'observation', statement: 'a'.repeat(10_000), evidenceIds: ['evidence-1'] },
        { kind: 'inference', statement: 'b', evidenceIds: ['evidence-1'] },
        { kind: 'inference', statement: 'c', evidenceIds: ['evidence-1'] },
      ],
      businessTraceIds: ['trace-1', 'trace-2', 'trace-3'],
      missingEvidence: ['m1', 'm2', 'm3'],
    });

    const result = collector.finalize({
      source: 'logs', startedAt: 100, finishedAt: 200, parentRunId: 'parent-1', childRunId: 'child-1',
    });

    expect(Buffer.byteLength(result.summary, 'utf8')).toBeLessThanOrEqual(256);
    expect(result.findings).toHaveLength(2);
    expect(result.businessTraceIds).toHaveLength(2);
    expect(result.missingEvidence).toHaveLength(2);
  });
});
