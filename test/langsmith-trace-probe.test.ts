import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLangSmithTraceProbe } from '../src/acceptance/langsmith-trace-probe.js';
import { createLangSmithMemoryServer } from './fixtures/langsmith-memory-server.js';

const config = { enabled: true, apiKey: 'offline-key', projectName: 'trace-probe-test', endpoint: 'https://smith.invalid' } as const;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('independent LangSmith admission probe', () => {
  it.each(['{LEAK_MARK', '"LEAK_MARK"', '{"batch_ingest_config":{"use_multipart_endpoint":"LEAK_MARK"}}'])('rejects malformed HTTP-200 info before SDK logging/fallback can leak its body', async (body) => {
    const logged: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...values: unknown[]) => logged.push(values.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => logged.push(values.join(' ')));
    const server = createLangSmithMemoryServer();
    let infoCalls = 0;
    const result = await runLangSmithTraceProbe({ authorization: 'explicit-probe', config }, {
      fetch: (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === '/info') { infoCalls += 1; return Promise.resolve(new Response(body)); }
        return server.fetch(request);
      },
    });
    expect(result).toMatchObject({ status: 'failed', code: 'TRACE_PROBE_UPLOAD_FAILED', remoteQueriesSent: 0 });
    expect(result.diagnostics.traceRequests).toContainEqual(expect.objectContaining({ route: 'info', phase: 'body',
      httpStatus: 200, outcome: 'network_error' }));
    expect(infoCalls).toBe(1);
    expect(server.routes).toEqual([]);
    expect(logged.join('\n')).not.toContain('LEAK_MARK');
    expect(JSON.stringify(result)).not.toContain('LEAK_MARK');
  });
  it('uses the production exporter and reads back only the two newly created spans with known usage', async () => {
    const server = createLangSmithMemoryServer();
    const result = await runLangSmithTraceProbe({ authorization: 'explicit-probe', config }, {
      fetch: server.fetch, createId: () => 'probe-run-1', sleep: async () => {},
    });
    expect(result).toMatchObject({ status: 'verified', checkedSpanCount: 2, remoteQueriesSent: 1 });
    expect(server.stored.size).toBe(2);
    expect(server.queries).toHaveLength(1);
    expect(server.queries[0]?.['id']).toEqual(expect.arrayContaining([...server.stored.keys()]));
    expect(server.queries[0]?.['limit']).toBe(2);
    expect(server.routes.every((route) => ['/info', '/runs/multipart', '/runs/batch', '/runs/query'].includes(route))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('offline-key');
    expect(JSON.stringify(result)).not.toContain('https://smith.invalid');
  });

  it.each([
    { authorization: 'none' as const, config },
    { authorization: 'explicit-probe' as const, config: { enabled: false } as const },
  ])('fails before network when explicit admission configuration is missing', async (options) => {
    const send = vi.fn<typeof fetch>(() => Promise.reject(new Error('MUST_NOT_SEND')));
    expect(await runLangSmithTraceProbe(options, { fetch: send })).toMatchObject({ status: 'failed',
      code: 'TRACE_PROBE_CONFIG_INVALID', remoteQueriesSent: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('stops on upload 422 without querying, retrying or invoking a model', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => logged.push(values.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...values: unknown[]) => logged.push(values.join(' ')));
    const server = createLangSmithMemoryServer({ uploadStatus: 422 });
    const result = await runLangSmithTraceProbe({ authorization: 'explicit-probe', config }, { fetch: server.fetch });
    expect(result).toMatchObject({ status: 'failed', code: 'TRACE_PROBE_UPLOAD_FAILED', remoteQueriesSent: 0 });
    expect(result.diagnostics.traceRequests).toContainEqual(expect.objectContaining({ route: 'multipart', phase: 'headers', outcome: 'http_error', httpStatus: 422 }));
    expect(server.queries).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REMOTE_ERROR');
    expect(logged.join('\n')).not.toContain('PRIVATE_REMOTE_ERROR');
  });

  it('bounds missing-span readback to three queries rather than reporting a pass', async () => {
    const server = createLangSmithMemoryServer({ omitChild: true });
    const result = await runLangSmithTraceProbe({ authorization: 'explicit-probe', config }, { fetch: server.fetch, sleep: async () => {} });
    expect(result).toMatchObject({ status: 'failed', code: 'TRACE_PROBE_QUERY_UNAVAILABLE', remoteQueriesSent: 3 });
    expect(server.queries).toHaveLength(3);
  });

  it('rejects remote usage mismatch with a distinct code', async () => {
    const server = createLangSmithMemoryServer({ wrongUsage: true });
    expect(await runLangSmithTraceProbe({ authorization: 'explicit-probe', config }, { fetch: server.fetch }))
      .toMatchObject({ status: 'failed', code: 'TRACE_PROBE_MISMATCH', remoteQueriesSent: 1 });
  });

  it('bounds even a fetch that ignores cancellation and leaves no timers after upload failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const result = runLangSmithTraceProbe({ authorization: 'explicit-probe', config }, {
      fetch: fetcher,
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(await result).toMatchObject({ status: 'failed', remoteQueriesSent: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
