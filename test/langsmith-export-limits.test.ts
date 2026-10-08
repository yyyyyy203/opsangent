import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuditedLangSmithFetch } from '../src/acceptance/langsmith-export-transport.js';
import { createLangSmithEventObservability } from '../src/bootstrap/langsmith.js';
import { ACCEPTANCE_LANGSMITH_EXPORT_LIMITS } from '../src/observability/langsmith-export-policy.js';
import type { TraceRequestDiagnostic } from '../src/acceptance/diagnostics.js';

const config = { enabled: true, apiKey: 'offline-key', projectName: 'offline-limits', endpoint: 'https://smith.invalid' } as const;
afterEach(() => vi.useRealTimers());

function slowFetch(delay: number, requests: Request[]): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return new Promise((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(new DOMException('Trace request interrupted', 'AbortError')); };
      const timer = setTimeout(() => {
        request.signal.removeEventListener('abort', abort);
        resolve(Response.json({ version: '0.1', batch_ingest_config: { use_multipart_endpoint: false } }));
      }, delay);
      request.signal.addEventListener('abort', abort, { once: true });
    });
  };
}

describe('same-source LangSmith export limits', () => {
  it('keeps the default one-second request timeout', async () => {
    vi.useFakeTimers();
    const requests: Request[] = [];
    const diagnostics: TraceRequestDiagnostic[] = [];
    const audited = createAuditedLangSmithFetch(slowFetch(1500, requests), config, [], () => {},
      { now: () => Date.now(), onDiagnostic: (value) => diagnostics.push(value) });
    const result = audited(`${config.endpoint}/info`).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ name: 'TimeoutError' });
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(diagnostics).toEqual([{ route: 'info', phase: 'headers', outcome: 'timeout', elapsedMs: 1000 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave an inner one-second timeout in an explicitly configured acceptance request', async () => {
    vi.useFakeTimers();
    const requests: Request[] = [];
    const diagnostics: TraceRequestDiagnostic[] = [];
    const audited = createAuditedLangSmithFetch(slowFetch(1500, requests), config, [], () => {},
      { limits: ACCEPTANCE_LANGSMITH_EXPORT_LIMITS, now: () => Date.now(), onDiagnostic: (value) => diagnostics.push(value) });
    const result = audited(`${config.endpoint}/info`);
    await vi.advanceTimersByTimeAsync(1500);
    expect((await result).status).toBe(200);
    expect(requests[0]?.signal.aborted).toBe(false);
    expect(diagnostics).toEqual([{ route: 'info', phase: 'complete', outcome: 'ok', elapsedMs: 1500, httpStatus: 200 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('injects the same limits into SDK, outer fetch and audited fetch', async () => {
    vi.useFakeTimers();
    const requests: Request[] = [];
    const exporter = createLangSmithEventObservability(config, {
      limits: ACCEPTANCE_LANGSMITH_EXPORT_LIMITS,
      fetch: createAuditedLangSmithFetch(slowFetch(1500, requests), config, [], () => {},
        { limits: ACCEPTANCE_LANGSMITH_EXPORT_LIMITS }),
    });
    const root = exporter.eventObservability.startSpan({ name: 'agent.run', kind: 'chain', runId: 'limits-run', spanKey: 'limits-root' });
    root.end({ status: 'completed' });
    const result = exporter.eventObservability.flush();
    await vi.advanceTimersByTimeAsync(6500);
    await result;
    expect(requests.some((request) => new URL(request.url).pathname === '/runs/batch')).toBe(true);
    expect(exporter.getDiagnostics()).toEqual({ pending: 0, dropped: 0, counts: {} });
  });

  it.each([401, 403, 422, 429, 500])('records safe route/stage/status for HTTP %i without response text', async (status) => {
    const values: TraceRequestDiagnostic[] = [];
    let calls = 0;
    const audited = createAuditedLangSmithFetch(() => { calls += 1; return Promise.resolve(new Response('PRIVATE_REMOTE_BODY', { status })); },
      config, [], () => {}, { now: () => 0, onDiagnostic: (value) => values.push(value) });
    expect((await audited(`${config.endpoint}/info`)).status).toBe(status);
    expect(values).toEqual([{ route: 'info', phase: 'headers', outcome: 'http_error', elapsedMs: 0, httpStatus: status }]);
    expect(calls).toBe(1);
    expect(JSON.stringify(values)).not.toContain('PRIVATE_REMOTE_BODY');
  });

  it('cancels a stalled body and records body timeout, not a local audit rejection', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const diagnostics: TraceRequestDiagnostic[] = [];
    const audited = createAuditedLangSmithFetch(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }))), config, [], () => { throw new Error('WRONG_REJECTION'); },
    { limits: ACCEPTANCE_LANGSMITH_EXPORT_LIMITS, now: () => Date.now(), onDiagnostic: (value) => diagnostics.push(value) });
    const result = audited(`${config.endpoint}/info`).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toMatchObject({ name: 'TimeoutError' });
    expect(cancelled).toBe(true);
    expect(diagnostics).toEqual([{ route: 'info', phase: 'body', outcome: 'timeout', elapsedMs: 10000, httpStatus: 200 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes caller cancellation from deadline and clears timers', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const diagnostics: TraceRequestDiagnostic[] = [];
    const audited = createAuditedLangSmithFetch(slowFetch(1500, []), config, [], () => {},
      { onDiagnostic: (value) => diagnostics.push(value), now: () => 0 });
    const result = audited(`${config.endpoint}/info`, { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(diagnostics).toEqual([{ route: 'info', phase: 'headers', outcome: 'aborted', elapsedMs: 0 }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
