import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'langsmith';
import { createLangSmithQueryFetch } from '../src/acceptance/langsmith-query-transport.js';

const endpoint = 'https://smith.invalid';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('bounded LangSmith SDK readback transport', () => {
  it.each([401, 403, 422, 429, 500])('does not allow SDK retry after HTTP %i', async (status) => {
    vi.useFakeTimers();
    const send = vi.fn<typeof fetch>(() => Promise.resolve(new Response('PRIVATE_RESPONSE', { status })));
    const client = new Client({ apiUrl: endpoint, apiKey: 'offline-key', callerOptions: { maxRetries: 0 },
      fetchImplementation: createLangSmithQueryFetch(send, endpoint) });
    const read = async () => { for await (const run of client.listRuns({ id: ['only-id'], limit: 1 })) void run; };
    await expect(read()).rejects.toThrow('TRACE_QUERY_UNAVAILABLE');
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('permits only the configured query route and at most three actual requests', async () => {
    const send = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ runs: [] })));
    const query = createLangSmithQueryFetch(send, endpoint);
    await expect(query('https://other.invalid/runs/query', { method: 'POST' })).rejects.toThrow('TRACE_QUERY_UNAVAILABLE');
    for (let i = 0; i < 3; i += 1) await query(`${endpoint}/runs/query`, { method: 'POST' });
    await expect(query(`${endpoint}/runs/query`, { method: 'POST' })).rejects.toThrow('TRACE_QUERY_UNAVAILABLE');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('projects wide paginated Run responses before returning them to the LangSmith SDK', async () => {
    const root = { id: 'probe-root', trace_id: 'probe-trace', parent_run_id: null, name: 'agent.run',
      run_type: 'chain', end_time: '2026-10-08T00:00:00Z', status: 'success', error: null,
      inputs: { profile: 'simulation' }, outputs: { status: 'completed' }, extra: { metadata: {} } };
    const child = { ...root, id: 'probe-child', parent_run_id: 'probe-root', name: 'model.trace-probe',
      run_type: 'llm', inputs: { purpose: 'inspection' }, outputs: { status: 'completed', usage_metadata: {
        input_tokens: 12, output_tokens: 5, total_tokens: 17, input_token_details: { cache_read: 4 },
      } } };
    const widen = (run: Record<string, unknown>): Record<string, unknown> => ({ ...run,
      ...Object.fromEntries(Array.from({ length: 44 }, (_, index) => [`remoteOnlyField${index}`, 'REMOTE_READBACK_CANARY'])),
    });
    const firstPage = widen(root);
    const secondPage = widen(child);
    const queryCursors: unknown[] = [];
    const send = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const body = await request.json() as Record<string, unknown>;
      queryCursors.push(body['cursor']);
      if (body['cursor'] === 'page-two') return Response.json({ runs: [secondPage], cursors: { next: null },
        remoteEnvelopeField: 'REMOTE_READBACK_CANARY' });
      return Response.json({ runs: [firstPage], cursors: { next: 'page-two' },
        remoteEnvelopeField: 'REMOTE_READBACK_CANARY' });
    });
    const discardedFieldCounts: number[] = [];
    const client = new Client({ apiUrl: endpoint, apiKey: 'offline-key', callerOptions: { maxRetries: 0 },
      fetchImplementation: createLangSmithQueryFetch(send, endpoint, {
        onUnselectedFieldCount: (count) => discardedFieldCounts.push(count),
      }) });
    const runs: Record<string, unknown>[] = [];
    for await (const run of client.listRuns({ id: ['probe-root', 'probe-child'], limit: 2,
      select: ['id', 'trace_id', 'parent_run_id', 'name', 'run_type', 'end_time', 'status', 'error', 'inputs', 'outputs', 'extra'] })) {
      runs.push(run as unknown as Record<string, unknown>);
    }

    expect(runs).toEqual([root, child]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(queryCursors).toEqual([undefined, 'page-two']);
    expect(discardedFieldCounts).toEqual([44, 44]);
    expect(JSON.stringify(runs)).not.toContain('REMOTE_READBACK_CANARY');
  });

  it('cancels a stalled body at the same request deadline and releases timers', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const send = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new ReadableStream({ cancel: cancelled }))));
    const query = createLangSmithQueryFetch(send, endpoint);
    const result = query(`${endpoint}/runs/query`, { method: 'POST' }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toMatchObject({ message: 'TRACE_QUERY_UNAVAILABLE', code: 'ECONNABORTED' });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
