import { describe, expect, it } from 'vitest';
import { applyManualReview, evaluateAcceptance, readSourceReports } from '../src/acceptance/index.js';
import { createAcceptanceFixture } from './fixtures/acceptance-cases.js';

describe('combined-source acceptance evaluator', () => {
  it.each(['normal', 'settlement_failure', 'low_sample', 'logs_offline', 'capture_window_mismatch'] as const)(
    'keeps the %s deterministic case explicit and requires human review',
    (caseId) => {
      const input = createAcceptanceFixture(caseId);
      const report = evaluateAcceptance(input);

      expect(report.checks).toHaveLength(11);
      expect(report.checks.every((check) => check.passed)).toBe(true);
      expect(report.verdict).toBe('review_required');
      expect(report).not.toHaveProperty('events');
      expect(report).not.toHaveProperty('reports');
    },
  );

  it('reads only canonical source JSON results paired with lifecycle identity', () => {
    const input = createAcceptanceFixture('settlement_failure');
    expect(readSourceReports(input.events)).toEqual(input.reports);

    const tampered = input.events.map((event) => event.type === 'TOOL_RESULT'
      ? { ...event, payload: { ...event.payload, result: { ...event.payload.result, toolName: 'arbitrary_tool' } } }
      : event);
    expect(readSourceReports(tampered)).toHaveLength(0);
  });

  it('fails a metric status inconsistent with deterministic count assessment', () => {
    const input = createAcceptanceFixture('low_sample');
    const report = evaluateAcceptance({ ...input, metricFact: { ...input.metricFact, status: 'breached' } });
    expect(report.checks.find((check) => check.code === 'METRIC_FACT_VALID')?.passed).toBe(false);
    expect(report.verdict).toBe('failed');
  });

  it('fails the full acceptance when a public-boundary audit is unsafe', () => {
    const input = createAcceptanceFixture('settlement_failure');
    const report = evaluateAcceptance({
      ...input,
      boundaryChecks: { ...input.boundaryChecks, publicDataSafe: false },
    });
    expect(report.checks.find((check) => check.code === 'PUBLIC_DATA_SAFE')?.passed).toBe(false);
    expect(report.verdict).toBe('failed');
  });

  it('fails evidence ownership, unexpected sources, duplicate calls, and over-budget requests', () => {
    const input = createAcceptanceFixture('settlement_failure');
    const movedEvidence = input.evidence.map((item, index) => index === 0 ? { ...item, runId: input.parent.runId } : item);
    const ownership = evaluateAcceptance({ ...input, evidence: movedEvidence });
    expect(ownership.checks.find((check) => check.code === 'EVIDENCE_OWNERSHIP')?.passed).toBe(false);

    const duplicateToolStart = input.events.find((event) => event.type === 'TOOL_STARTED' && event.payload.toolName === 'metrics_subagent');
    if (duplicateToolStart === undefined) throw new Error('fixture Metrics invocation missing');
    const duplicate = evaluateAcceptance({ ...input, events: [...input.events, { ...duplicateToolStart, eventId: 'duplicate-metrics-call' }] });
    expect(duplicate.checks.find((check) => check.code === 'SOURCE_CALL_LIMIT')?.passed).toBe(false);

    const overBudget = evaluateAcceptance({ ...input, budget: { ...input.budget, limit: 10, sent: 11, attempted: 11 } });
    expect(overBudget.checks.find((check) => check.code === 'MODEL_HTTP_BUDGET')?.passed).toBe(false);
  });

  it('requires visible downgrade reasons, matching capture windows, and terminal events', () => {
    const offline = createAcceptanceFixture('logs_offline');
    const hiddenMissing = evaluateAcceptance({ ...offline, parent: { ...offline.parent, missingEvidence: [] } });
    expect(hiddenMissing.checks.find((check) => check.code === 'MISSING_EVIDENCE_VISIBLE')?.passed).toBe(false);

    const mismatch = createAcceptanceFixture('capture_window_mismatch');
    const hiddenWindowMismatch = evaluateAcceptance({
      ...mismatch,
      reports: mismatch.reports.map((report) => report.source === 'logs'
        ? { ...report, status: 'complete', missingEvidence: [] }
        : report),
    });
    expect(hiddenWindowMismatch.checks.find((check) => check.code === 'SOURCE_WINDOW_VALID')?.passed).toBe(false);

    const missingTerminal = evaluateAcceptance({
      ...offline, events: offline.events.filter((event) => !(event.type === 'RUN_FINISHED' && event.runId === offline.parent.runId)),
    });
    expect(missingTerminal.checks.find((check) => check.code === 'TERMINAL_COMPLETE')?.passed).toBe(false);
  });

  it('rejects failed trace verification and explicit review rejection', () => {
    const input = createAcceptanceFixture('settlement_failure');
    expect(evaluateAcceptance({ ...input, traceVerification: { status: 'failed', checkedSpanCount: 0 } }).verdict).toBe('failed');
    expect(evaluateAcceptance({ ...input, traceVerification: { status: 'unavailable', checkedSpanCount: 0 } }).verdict)
      .toBe('review_required');

    const pending = evaluateAcceptance(input);
    expect(applyManualReview(pending, { status: 'rejected', unsupportedClaimCount: 1 }).verdict).toBe('failed');
    expect(applyManualReview(pending, { status: 'approved', unsupportedClaimCount: 1 }).verdict).toBe('failed');
    expect(applyManualReview(pending, { status: 'approved', unsupportedClaimCount: 0 }).verdict).toBe('passed');
  });

  it('rebuilds a bounded report without narratives, evidence payloads, or raw canaries', () => {
    const input = createAcceptanceFixture('settlement_failure');
    const report = evaluateAcceptance({
      ...input,
      codeRevision: 'private-raw-canary',
      reports: input.reports.map((source) => ({ ...source, summary: 'private-raw-canary' })),
      events: input.events.map((event) => event.type === 'RUN_STARTED'
        ? { ...event, payload: { ...event.payload, trigger: 'private-raw-canary' } }
        : event),
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('private-raw-canary');
    expect(serialized).not.toContain('采集到');
    expect(report).not.toHaveProperty('evidence');
  });
});
