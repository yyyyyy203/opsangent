import { describe, expect, it } from 'vitest';
import { AcceptanceDiagnosticsRecorder, parseAcceptanceDiagnostics } from '../src/acceptance/diagnostics.js';
import { applyManualReview, evaluateAcceptance } from '../src/acceptance/evaluator.js';
import { createAcceptanceFixture } from './fixtures/acceptance-cases.js';

const decision = { runId: 'run-1', stepId: 'step-1', streamId: 'stream-1', phase: 'report', maxOutputTokens: 1024 } as const;
const request = { route: 'multipart', phase: 'headers', outcome: 'http_error', elapsedMs: 1500, httpStatus: 422 } as const;

describe('bounded local acceptance diagnostics', () => {
  it('preserves optional diagnostics through evaluation and review without changing hard failures', () => {
    const input = createAcceptanceFixture('settlement_failure');
    const diagnostics = { modelDecisions: [decision], traceRequests: [request] };
    const report = evaluateAcceptance({ ...input, diagnostics, traceVerification: { status: 'failed', checkedSpanCount: 0 } });
    expect(report.diagnostics).toEqual(diagnostics);
    const reviewed = applyManualReview(report, { status: 'approved', unsupportedClaimCount: 0 });
    expect(reviewed.diagnostics).toEqual(diagnostics);
    expect(reviewed.verdict).toBe('failed');
    expect(report.manualReview.status).toBe('pending');
    expect(evaluateAcceptance(input)).not.toHaveProperty('diagnostics');
  });
  it('preserves only explicit safe diagnostics and returns isolated snapshots', () => {
    const recorder = new AcceptanceDiagnosticsRecorder();
    recorder.recordModelDecision(decision);
    recorder.recordTraceRequest(request);
    recorder.recordTraceVerification({ phase: 'local_snapshot', reason: 'invalid_source_invocation', remoteQueriesSent: 0 });
    const first = recorder.snapshot();
    expect(first).toEqual({ modelDecisions: [decision], traceRequests: [request],
      traceVerification: { phase: 'local_snapshot', reason: 'invalid_source_invocation', remoteQueriesSent: 0 } });
    Object.assign(first.modelDecisions[0]!, { runId: 'changed' });
    expect(recorder.snapshot().modelDecisions).toEqual([decision]);
    expect(parseAcceptanceDiagnostics(recorder.snapshot())).toEqual(recorder.snapshot());
  });

  it('caps retained model decisions and requests and records overflow without unbounded allocation', () => {
    const recorder = new AcceptanceDiagnosticsRecorder();
    for (let i = 0; i < 20; i += 1) recorder.recordModelDecision(decision);
    for (let i = 0; i < 70; i += 1) recorder.recordTraceRequest(request);
    expect(recorder.snapshot()).toMatchObject({ modelDecisions: Array(16).fill(decision),
      traceRequests: Array(64).fill(request), dropped: { modelDecisions: 4, traceRequests: 6 } });
  });

  it.each([
    { modelDecisions: [{ ...decision, prompt: 'PRIVATE_CANARY' }], traceRequests: [] },
    { modelDecisions: [{ ...decision, runId: 'sk-abcdefghijklmnopqrstuvwx' }], traceRequests: [] },
    { modelDecisions: [{ ...decision, phase: 'query' }], traceRequests: [] },
    { modelDecisions: Array(17).fill(decision), traceRequests: [] },
    { modelDecisions: [], traceRequests: [{ ...request, elapsedMs: NaN }] },
    { modelDecisions: [], traceRequests: [{ ...request, elapsedMs: -1 }] },
    { modelDecisions: [], traceRequests: [{ ...request, httpStatus: 999 }] },
    { modelDecisions: [], traceRequests: [{ ...request, body: 'PRIVATE_CANARY' }] },
    { modelDecisions: [], traceRequests: [], traceVerification: { phase: 'remote_query', reason: 'server said PRIVATE_CANARY', remoteQueriesSent: 1 } },
    { modelDecisions: [], traceRequests: [], dropped: { modelDecisions: 1.5, traceRequests: 0 } },
    { modelDecisions: [], traceRequests: [], url: 'https://private.invalid' },
  ])('rejects malformed, oversized or sensitive diagnostics rather than persisting them', (value) => {
    expect(() => parseAcceptanceDiagnostics(value)).toThrow('ACCEPTANCE_DIAGNOSTICS_INVALID');
  });

  it('rejects a configured secret even if it happens to satisfy the identifier grammar', () => {
    expect(() => parseAcceptanceDiagnostics({ modelDecisions: [{ ...decision, runId: 'PRIVATE_CANARY' }], traceRequests: [] },
      ['PRIVATE_CANARY'])).toThrow('ACCEPTANCE_DIAGNOSTICS_INVALID');
  });
});
