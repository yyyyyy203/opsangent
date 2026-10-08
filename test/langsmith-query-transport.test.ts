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
