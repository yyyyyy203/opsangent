import { describe, expect, it } from 'vitest';
import { applyManualReview, evaluateAcceptance, readSourceReports } from '../src/acceptance/index.js';
import type { EvidenceRecord } from '../src/contracts/index.js';
import { publicEvidenceFromRecord } from '../src/contracts/read-model.js';
import { createAcceptanceFixture } from './fixtures/acceptance-cases.js';

describe('combined-source acceptance evaluator', () => {
  it.each(['normal', 'settlement_failure', 'low_sample', 'logs_offline', 'capture_window_mismatch'] as const)(
    'keeps the %s deterministic case explicit and requires human review',
    (caseId) => {
      const input = createAcceptanceFixture(caseId);
      const report = evaluateAcceptance(input);

      expect(report.checks).toHaveLength(13);
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

  it.each([
    { label: 'matching', offset: 0, passed: true, verdict: 'review_required' },
    { label: 'earlier', offset: -300, passed: false, verdict: 'failed' },
    { label: 'later', offset: 300, passed: false, verdict: 'failed' },
  ])('checks the $label metric window projected from stored summary seconds', ({ offset, passed, verdict }) => {
    const input = createAcceptanceFixture('settlement_failure');
    const evidence = input.evidence.map((item) => {
      if (item.source !== 'metric') return item;
      const record: EvidenceRecord = {
        evidenceId: item.evidenceId, runId: item.runId, source: 'metric',
        summary: { ...input.metricFact, start: input.metricFact.start + offset, end: input.metricFact.end + offset },
        raw: { privateCanary: 'EVALUATOR_RAW_MUST_NOT_LEAK' }, businessTraceIds: [], capturedAt: item.capturedAt,
      };
      return publicEvidenceFromRecord(record);
    });

    const report = evaluateAcceptance({ ...input, evidence });

    expect(report.checks.find((check) => check.code === 'METRIC_FACT_VALID')?.passed).toBe(true);
    expect(report.checks.find((check) => check.code === 'SOURCE_WINDOW_VALID')?.passed).toBe(passed);
    expect(report.verdict).toBe(verdict);
    expect(JSON.stringify(evidence)).not.toContain('EVALUATOR_RAW_MUST_NOT_LEAK');
  });

  it('fails SOURCE_WINDOW_VALID for legacy metric summaries without window seconds', () => {
    const input = createAcceptanceFixture('settlement_failure');
    const evidence = input.evidence.map((item) => item.source === 'metric' ? publicEvidenceFromRecord({
      evidenceId: item.evidenceId, runId: item.runId, source: 'metric', summary: { status: 'breached' },
      raw: { start: input.metricFact.start, end: input.metricFact.end }, businessTraceIds: [], capturedAt: item.capturedAt,
    }) : item);

    const report = evaluateAcceptance({ ...input, evidence });

    expect(report.checks.find((check) => check.code === 'SOURCE_WINDOW_VALID')?.passed).toBe(false);
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

  it('fails when the source/build input fingerprint is absent or malformed', () => {
    const input = createAcceptanceFixture('settlement_failure');
    const report = evaluateAcceptance({ ...input, sourceFingerprint: 'unverified' });
    expect(report.checks.find((check) => check.code === 'SOURCE_FINGERPRINT_VALID')?.passed).toBe(false);
    expect(report.sourceFingerprint).toBe('unverified');
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

  it('preserves safe failure diagnostics and unexecuted checks after human review', () => {
    const report = evaluateAcceptance(createAcceptanceFixture('settlement_failure'));
    const reviewed = applyManualReview({
      ...report,
      checks: report.checks.map((check) => ({ ...check, passed: false, status: 'not_run' as const })),
      failures: [{ runId: report.runId, code: 'MODEL_ERROR', category: 'output_truncated' }],
      outputBudget: { limit: 5120, reserved: 512, settled: 400, available: 4208, reservations: 2, settlements: 1, rejected: 0 },
      verdict: 'failed',
    }, { status: 'approved', unsupportedClaimCount: 0 });
    expect(reviewed.failures).toEqual([{ runId: report.runId, code: 'MODEL_ERROR', category: 'output_truncated' }]);
    expect(reviewed.checks.every((check) => check.status === 'not_run' && check.passed === false)).toBe(true);
    expect(reviewed.verdict).toBe('failed');
    expect(reviewed.outputBudget).toEqual({ limit: 5120, reserved: 512, settled: 400, available: 4208, reservations: 2, settlements: 1, rejected: 0 });
  });

  it('keeps a failed child model category even when the parent reaches completed', () => {
    const input = createAcceptanceFixture('settlement_failure');
    const child = input.children[1]!;
    const report = evaluateAcceptance({ ...input,
      events: input.events.map((event) => event.type === 'MODEL_CALL_COMPLETED' && event.runId === child.runId
        ? { ...event, type: 'MODEL_CALL_FAILED', payload: {
          attempt: 1, retryable: false, durationMs: 1, usage: { inputTokens: 50, outputTokens: 20 }, finishReason: 'length',
          error: { code: 'MODEL_ERROR', message: 'PRIVATE_CHILD_ERROR_CANARY', retryable: false,
            details: { category: 'output_truncated', unsafeDetail: 'PRIVATE_CHILD_ERROR_CANARY' } },
        } } : event),
    });
    expect(report.failures).toEqual([{ runId: child.runId, code: 'MODEL_ERROR', category: 'output_truncated' }]);
    expect(report.usage).toEqual({ completeness: 'partial', inputTokens: 200, outputTokens: 80 });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_CHILD_ERROR_CANARY');
    expect(report.checks.find((check) => check.code === 'SCENARIO_OUTCOME_VALID')?.passed).toBe(false);
    expect(report.verdict).toBe('failed');
  });

  it('does not treat a terminal failed child as a successful scenario outcome', () => {
    const input = createAcceptanceFixture('settlement_failure');
    const failedChild = { ...input.children[1]!, status: 'failed' as const };
    const report = evaluateAcceptance({ ...input, children: [input.children[0]!, failedChild] });
    expect(report.checks.find((check) => check.code === 'TERMINAL_COMPLETE')?.passed).toBe(true);
    expect(report.checks.find((check) => check.code === 'SCENARIO_OUTCOME_VALID')?.passed).toBe(false);
    expect(report.verdict).toBe('failed');
  });
});
