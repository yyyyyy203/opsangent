import { describe, expect, it } from 'vitest';
import { ApiClient } from '../apps/agent-web/src/api/client.js';

describe('browser API client', () => {
  it('uses the public HTTP contract and asks SSE for notification-only frames', async () => {
    const requests: Request[] = [];
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:4100/',
      fetchImpl: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      },
      eventSourceFactory: () => ({ close: () => undefined }),
    });

    await client.getMessages('run/1', { limit: 20 });
    const events = client.openRunEvents('run/1', 'event-7', () => undefined);
    events.close();

    expect(requests[0]?.url).toBe('http://127.0.0.1:4100/runs/run%2F1/messages?limit=20');
    expect(requests[0]?.method).toBe('GET');
    expect(client.lastEventSourceUrl).toBe('http://127.0.0.1:4100/runs/run%2F1/events?snapshots=none&lastEventId=event-7');
  });

  it('surfaces a conflict without retrying a confirmation command', async () => {
    let calls = 0;
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:4100',
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify({ error: 'REVISION_CONFLICT', message: 'stale confirmation' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }));
      },
      eventSourceFactory: () => ({ close: () => undefined }),
    });

    await expect(client.decideConfirmation('run-1', {
      toolCallId: 'tool-1', confirmed: true, expectedRevision: 3,
    })).rejects.toEqual(expect.objectContaining({ code: 'REVISION_CONFLICT', status: 409 }));
    expect(calls).toBe(1);
  });

  it('posts cancellation to the encoded Run endpoint without a body', async () => {
    let captured: Request | undefined;
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:4100',
      fetchImpl: (input, init) => {
        captured = new Request(input, init);
        return Promise.resolve(new Response(JSON.stringify({ runId: 'run/1', status: 'cancelling' }), { status: 202 }));
      },
      eventSourceFactory: () => ({ close: () => undefined }),
    });

    await expect(client.cancelRun('run/1')).resolves.toEqual({ runId: 'run/1', status: 'cancelling' });
    expect(captured?.url).toBe('http://127.0.0.1:4100/runs/run%2F1/cancel');
    expect(captured?.method).toBe('POST');
    expect(captured?.body).toBeNull();
  });

  it('binds the default browser fetch to the global object', async () => {
    const originalFetch = globalThis.fetch;
    let invokedWithGlobal = false;
    globalThis.fetch = function (this: unknown): Promise<Response> {
      if (this !== globalThis) return Promise.reject(new Error('fetch receiver was not globalThis'));
      invokedWithGlobal = true;
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    };
    try {
      await new ApiClient({ baseUrl: 'http://127.0.0.1:4100' }).listProfiles();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(invokedWithGlobal).toBe(true);
  });
});
