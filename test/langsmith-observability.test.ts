import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'langsmith';
import { createLangSmithEventObservability } from '../src/bootstrap/langsmith.js';
import { ExportDiagnosticsRecorder } from '../src/observability/export-diagnostics.js';
import { LangSmithObservability } from '../src/observability/langsmith-observability.js';

describe('privacy-safe LangSmith event exporter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('does not construct network tracing when disabled', async () => {
    let requestCount = 0;
    const exporter = createLangSmithEventObservability({ enabled: false }, {
      fetch: () => {
        requestCount += 1;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });

    const handle = exporter.eventObservability.startSpan({
      name: 'agent.run', kind: 'chain', runId: 'disabled-run', spanKey: 'run:disabled-run:initial',
    });
    handle.end({ status: 'completed' });
    await exporter.eventObservability.flush();

    expect(requestCount).toBe(0);
    expect(exporter.getDiagnostics()).toMatchObject({ pending: 0, dropped: 0 });
  });

  it('applies a second allowlist and maps only known canonical token usage', async () => {
    const canary = 'SENSITIVE-CANARY-prompt-error-private-address';
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(`${request.url}\n${await request.text()}`);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const traceIdCanary = 'sk-langsmith-id-canary';
    const exporter = createLangSmithEventObservability({
      enabled: true,
      apiKey: 'unit-test-key',
      projectName: 'inspection-agent-test',
      endpoint: 'https://smith.invalid',
    }, { fetch, now: () => Date.parse('2026-10-04T10:00:00.000Z') });

    const root = exporter.eventObservability.startSpan({
      name: 'agent.run', kind: 'chain', runId: traceIdCanary, spanKey: `run:${traceIdCanary}:stream-1`,
      sessionId: 'session-id-canary', correlationId: 'correlation-id-canary',
      input: { prompt: canary, sourceUrl: `https://${canary}.invalid` },
      attributes: { eventType: 'RUN_STARTED', trigger: canary },
    });
    const model = exporter.eventObservability.startSpan({
      name: 'model.deepseek-chat', kind: 'llm', runId: traceIdCanary,
      spanKey: `model:${traceIdCanary}:stream-1:attempt-1`, parentSpanKey: `run:${traceIdCanary}:stream-1`,
      toolCallId: 'tool-call-id-canary', stepId: 'step-id-canary',
      input: { prompt: canary },
      attributes: {
        provider: 'deepseek', model: 'deepseek-chat', eventType: 'MODEL_CALL_STARTED', errorMessage: canary,
      },
    });
    model.end({
      response: canary,
      error: { message: canary, stack: canary },
      usage: { inputTokens: 12, outputTokens: 8, cachedInputTokens: 4 },
    });
    model.setAttributes({ reportText: canary, retryCount: 2 });
    root.end({ outcome: 'complete', finalText: canary });
    await exporter.eventObservability.flush();

    const payload = requests.join('\n');
    expect(payload).not.toContain(canary);
    expect(payload).not.toContain(traceIdCanary);
    expect(payload).not.toContain('session-id-canary');
    expect(payload).not.toContain('correlation-id-canary');
    expect(payload).not.toContain('tool-call-id-canary');
    expect(payload).not.toContain('step-id-canary');
    expect(payload).toContain('"ls_provider":"deepseek"');
    expect(payload).toContain('"ls_model_name":"deepseek-chat"');
    expect(payload).toContain('"input_tokens":12');
    expect(payload).toContain('"output_tokens":8');
    expect(payload).toContain('"total_tokens":20');
    expect(payload).toContain('"cache_read":4');
    expect(exporter.getDiagnostics().pending).toBe(0);
  });

  it('exports known failure usage while retaining an error state and removing error narratives', async () => {
    const requests: string[] = [];
    const exporter = createLangSmithEventObservability({
      enabled: true, apiKey: 'unit-test-key', projectName: 'inspection-agent-test', endpoint: 'https://smith.invalid',
    }, { fetch: async (input, init) => {
      requests.push(await new Request(input, init).text());
      return Response.json({});
    } });
    const root = exporter.eventObservability.startSpan({
      name: 'agent.run', kind: 'chain', runId: 'failure-run', spanKey: 'run:failure-run:initial',
    });
    const model = exporter.eventObservability.startSpan({
      name: 'model.test-model', kind: 'llm', runId: 'failure-run', spanKey: 'model:failure-run:attempt-1',
      parentSpanKey: 'run:failure-run:initial',
    });
    model.fail({ code: 'MODEL_ERROR', category: 'output_truncated', message: 'PRIVATE_ERROR_CANARY',
      usage: { inputTokens: 120, outputTokens: 512, cachedInputTokens: 64 }, finishReason: 'length' });
    root.fail({ code: 'MODEL_ERROR' });
    await exporter.eventObservability.flush();
    const payload = requests.join('\n');
    expect(payload).toContain('"input_tokens":120');
    expect(payload).toContain('"output_tokens":512');
    expect(payload).toContain('"cache_read":64');
    expect(payload).toContain('"error":"TRACE_ERROR"');
    expect(payload).not.toContain('PRIVATE_ERROR_CANARY');
  });

  it('does not honor SDK replica endpoints from process environment', async () => {
    vi.stubEnv('LANGSMITH_RUNS_ENDPOINTS', JSON.stringify([
      { api_url: 'https://unapproved-replica.invalid', api_key: 'replica-key-canary' },
    ]));
    const injectedRequests: string[] = [];
    const environmentRequests: string[] = [];
    const exporter = createLangSmithEventObservability({
      enabled: true,
      apiKey: 'unit-test-key',
      projectName: 'inspection-agent-test',
      endpoint: 'https://smith.invalid',
    }, {
      fetch: (input, init) => {
        injectedRequests.push(new Request(input, init).url);
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
      },
    });
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      environmentRequests.push(new Request(input, init).url);
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const root = exporter.eventObservability.startSpan({
      name: 'agent.run', kind: 'chain', runId: 'replica-fence-run', spanKey: 'run:replica-fence-run:initial',
    });
    const child = exporter.eventObservability.startSpan({
      name: 'tool.metrics_subagent', kind: 'tool', runId: 'replica-fence-run',
      spanKey: 'tool:replica-fence-run:attempt-1', parentSpanKey: 'run:replica-fence-run:initial',
    });
    child.end({ status: 'completed' });
    root.end({ status: 'completed' });
    await exporter.eventObservability.flush();

    expect(injectedRequests.length).toBeGreaterThan(0);
    expect(injectedRequests.every((url) => new URL(url).origin === 'https://smith.invalid')).toBe(true);
    expect(environmentRequests).toEqual([]);
  });

  it('bounds active spans and reports dropped trace work without retaining payloads', async () => {
    const fetch: typeof globalThis.fetch = () => Promise.resolve(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const exporter = createLangSmithEventObservability({
      enabled: true,
      apiKey: 'unit-test-key',
      projectName: 'inspection-agent-test',
      endpoint: 'https://smith.invalid',
    }, { fetch });
    const spans: ReturnType<typeof exporter.eventObservability.startSpan>[] = [];
    for (let index = 0; index < 300; index += 1) {
      spans.push(exporter.eventObservability.startSpan({
        name: 'agent.run', kind: 'chain', runId: `bounded-run-${index}`, spanKey: `run:bounded-run-${index}:initial`,
      }));
      if ((index + 1) % 8 === 0) await exporter.eventObservability.flush();
    }

    expect(exporter.getDiagnostics().dropped).toBe(45);
    expect(exporter.getDiagnostics().pending).toBeGreaterThan(0);
    expect(exporter.getTraceLinks()).toHaveLength(255);
    const droppedBeforeFirstCompletion = exporter.getDiagnostics().dropped;
    spans[0]?.end({ status: 'completed' });
    expect(exporter.getDiagnostics().dropped).toBe(droppedBeforeFirstCompletion);
    for (const span of spans) span.end({ status: 'completed' });
    await exporter.eventObservability.flush();
    expect(exporter.getDiagnostics().pending).toBe(0);
  });

  it('keeps completion operations within the queue bound until requests settle', async () => {
    const completionResolvers: Array<() => void> = [];
    const createRun = vi.fn(() => Promise.resolve());
    const client = {
      createRun,
      updateRun: vi.fn(() => new Promise<void>((resolve) => completionResolvers.push(resolve))),
      flush: () => Promise.resolve(),
      awaitPendingTraceBatches: () => Promise.resolve(),
    } as unknown as Client;
    const diagnostics = new ExportDiagnosticsRecorder();
    const observability = new LangSmithObservability({
      projectName: 'bounded-completion-test',
      client,
      enabled: true,
      maxPending: 3,
      diagnostics,
    });

    for (const index of [1, 2]) {
      const span = observability.startSpan({
        name: 'agent.run',
        kind: 'chain',
        runId: `bounded-completion-${index}`,
        spanKey: `run:bounded-completion-${index}`,
      });
      await vi.waitFor(() => expect(createRun).toHaveBeenCalledTimes(index));
      span.end({ status: 'completed' });
      await vi.waitFor(() => expect(completionResolvers).toHaveLength(index));
    }

    observability.startSpan({
      name: 'agent.run',
      kind: 'chain',
      runId: 'bounded-completion-3',
      spanKey: 'run:bounded-completion-3',
    });

    expect(diagnostics.snapshot().counts.TRACE_QUEUE_FULL).toBe(1);
    let flushResolved = false;
    const flush = observability.flush().then(() => { flushResolved = true; });
    await Promise.resolve();
    expect(flushResolved).toBe(false);
    for (const resolve of completionResolvers) resolve();
    await flush;
    expect(diagnostics.snapshot().pending).toBe(0);
  });

  it('uses one pending budget for start and reserved completion work', async () => {
    const startResolvers: Array<() => void> = [];
    const client = {
      createRun: () => new Promise<void>((resolve) => startResolvers.push(resolve)),
      updateRun: () => Promise.resolve(),
      flush: () => Promise.resolve(),
      awaitPendingTraceBatches: () => Promise.resolve(),
    } as unknown as Client;
    const diagnostics = new ExportDiagnosticsRecorder();
    const observability = new LangSmithObservability({
      projectName: 'shared-pending-budget-test',
      client,
      enabled: true,
      maxPending: 2,
      diagnostics,
    });

    const first = observability.startSpan({
      name: 'agent.run', kind: 'chain', runId: 'shared-pending-1', spanKey: 'run:shared-pending-1',
    });
    observability.startSpan({
      name: 'agent.run', kind: 'chain', runId: 'shared-pending-2', spanKey: 'run:shared-pending-2',
    });
    await vi.waitFor(() => expect(startResolvers).toHaveLength(1));
    expect(diagnostics.snapshot().counts.TRACE_QUEUE_FULL).toBe(1);

    first.end({ status: 'completed' });
    for (const resolve of startResolvers) resolve();
    await observability.flush();
    expect(diagnostics.snapshot().pending).toBe(0);
  });

  it('sanitizes exporter failures and records network diagnostics', async () => {
    const canary = 'SENSITIVE-CANARY-network-response-private-address';
    const logged: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    const exporter = createLangSmithEventObservability({
      enabled: true,
      apiKey: 'unit-test-key',
      projectName: 'inspection-agent-test',
      endpoint: 'https://smith.invalid',
    }, {
      fetch: () => Promise.reject(new Error(canary)),
    });
    try {
      const span = exporter.eventObservability.startSpan({
        name: 'agent.run', kind: 'chain', runId: 'failed-export-run', spanKey: 'run:failed-export-run:initial',
      });
      span.fail(new Error(canary));
      await exporter.eventObservability.flush();

      expect(exporter.getDiagnostics().counts.TRACE_NETWORK_ERROR).toBeGreaterThan(0);
      expect(logged.join('\n')).not.toContain(canary);
      expect(exporter.getDiagnostics()).not.toHaveProperty('lastError');
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('sanitizes an HTTP 429 body and records the failed export', async () => {
    const canary = 'SENSITIVE-CANARY-rate-limit-private-response';
    const logged: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    const exporter = createLangSmithEventObservability({
      enabled: true,
      apiKey: 'unit-test-key',
      projectName: 'inspection-agent-test',
      endpoint: 'https://smith.invalid',
    }, {
      fetch: () => Promise.resolve(new Response(canary, { status: 429 })),
    });
    try {
      const span = exporter.eventObservability.startSpan({
        name: 'agent.run', kind: 'chain', runId: 'rate-limited-run', spanKey: 'run:rate-limited-run:initial',
      });
      span.end({ status: 'completed' });
      await exporter.eventObservability.flush();

      expect(exporter.getDiagnostics().counts.TRACE_NETWORK_ERROR).toBeGreaterThan(0);
      expect(logged.join('\n')).not.toContain(canary);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('distinguishes local audit rejection from remote HTTP failure without logging bodies', async () => {
    const createExporter = (local: boolean) => createLangSmithEventObservability({
      enabled: true, apiKey: 'unit-test-key', projectName: 'inspection-agent-test', endpoint: 'https://smith.invalid',
    }, { fetch: () => Promise.resolve(Response.json({ error: 'PRIVATE_ERROR_CANARY' }, {
      status: local ? 400 : 403,
      headers: local ? { 'x-agentops-trace-error': 'TRACE_LOCAL_AUDIT_REJECTED' } : {},
    })) });
    const logged: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    try {
      const local = createExporter(true);
      const remote = createExporter(false);
      for (const exporter of [local, remote]) {
        const span = exporter.eventObservability.startSpan({ name: 'agent.run', kind: 'chain', runId: 'diagnostic-run', spanKey: 'run:diagnostic-run' });
        span.end({ status: 'completed' });
        await exporter.eventObservability.flush();
      }
      expect(local.getDiagnostics().counts.TRACE_LOCAL_AUDIT_REJECTED).toBeGreaterThan(0);
      expect(local.getDiagnostics().counts.TRACE_NETWORK_ERROR ?? 0).toBe(0);
      expect(remote.getDiagnostics().counts.TRACE_HTTP_ERROR).toBeGreaterThan(0);
      expect(remote.getDiagnostics().counts.TRACE_LOCAL_AUDIT_REJECTED ?? 0).toBe(0);
      expect(logged.join('\n')).not.toContain('PRIVATE_ERROR_CANARY');
    } finally { errorSpy.mockRestore(); warnSpy.mockRestore(); }
  });

  it('aborts a timed-out flush and releases transport work while retaining failure diagnostics', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const exporter = createLangSmithEventObservability({
      enabled: true,
      apiKey: 'unit-test-key',
      projectName: 'inspection-agent-test',
      endpoint: 'https://smith.invalid',
    }, {
      fetch: async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      },
    });
    const span = exporter.eventObservability.startSpan({
      name: 'agent.run', kind: 'chain', runId: 'flush-timeout-run', spanKey: 'run:flush-timeout-run:initial',
    });
    span.end({ status: 'completed' });

    const flush = exporter.eventObservability.flush();
    await vi.advanceTimersByTimeAsync(2_100);
    await flush;

    expect(exporter.getDiagnostics().counts.TRACE_FLUSH_TIMEOUT).toBe(1);
    // Pending counts local work, not remote delivery. Cancellation must settle
    // the wrapper even when the injected network promise never settles.
    expect(exporter.getDiagnostics().pending).toBe(0);
    expect(requestSignal?.aborted).toBe(true);
  });
});
