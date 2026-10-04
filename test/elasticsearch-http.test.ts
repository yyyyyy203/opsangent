import { describe, expect, it, vi } from 'vitest';
import { SourceFailure } from '../src/mcp/resilience.js';
import { ElasticsearchHttp } from '../src/infrastructure/elk/elasticsearch-http.js';

const signal = new AbortController().signal;

describe('ElasticsearchHttp', () => {
  it('rejects a configured response limit above the fixed 1 MiB ceiling', () => {
    expect(() => new ElasticsearchHttp({ url: 'http://127.0.0.1:19200', maxResponseBytes: 1_048_577 }))
      .toThrowError(RangeError);
    expect(() => new ElasticsearchHttp({ url: 'http://127.0.0.1:19200', maxResponseBytes: 1_048_576 }))
      .not.toThrow();
  });

  it('sends a fixed same-origin request and parses a bounded JSON response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ id: 'pit-id' }));
    const client = new ElasticsearchHttp({ url: 'http://127.0.0.1:19200', fetch });

    await expect(client.request('/checkout/_pit?keep_alive=2m', {}, { method: 'POST', signal }))
      .resolves.toEqual({ id: 'pit-id' });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    if (!(url instanceof URL)) throw new Error('expected a URL request target');
    expect(url.href).toBe('http://127.0.0.1:19200/checkout/_pit?keep_alive=2m');
    expect(init?.redirect).toBe('manual');
    expect(init?.method).toBe('POST');
  });

  it('omits the body and JSON content type when the request has no body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ _shards: { failed: 0 } }));
    const client = new ElasticsearchHttp({ url: 'http://127.0.0.1:19200', fetch });

    await expect(client.request('/checkout/_refresh', undefined, { method: 'POST', signal }))
      .resolves.toEqual({ _shards: { failed: 0 } });

    const init = fetch.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has('content-type')).toBe(false);
  });

  it('rejects absolute and traversal request paths before network access', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new ElasticsearchHttp({ url: 'http://127.0.0.1:19200', fetch });

    await expect(client.request('http://evil.example/_search', {}, { method: 'POST', signal }))
      .rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    await expect(client.request('/../_search', {}, { method: 'POST', signal }))
      .rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps authentication and server errors without exposing response bodies', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('private auth response', { status: 401 }))
      .mockResolvedValueOnce(new Response('private server response', { status: 503 }));
    const client = new ElasticsearchHttp({ url: 'http://127.0.0.1:19200', fetch });

    await expect(client.request('/_search', {}, { method: 'POST', signal }))
      .rejects.toMatchObject({ code: 'MCP_AUTH_ERROR' });
    await expect(client.request('/_search', {}, { method: 'POST', signal }))
      .rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
  });

  it('maps rate limits and rejects non-JSON or malformed JSON responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('private rate limit body', { status: 429 }))
      .mockResolvedValueOnce(new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('{bad json', { headers: { 'content-type': 'application/json' } }));
    const client = new ElasticsearchHttp({ url: 'http://127.0.0.1:19200', fetch });

    await expect(client.request('/_search', {}, { method: 'POST', signal }))
      .rejects.toMatchObject({ code: 'MCP_RATE_LIMITED' });
    await expect(client.request('/_search', {}, { method: 'POST', signal }))
      .rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    await expect(client.request('/_search', {}, { method: 'POST', signal }))
      .rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
  });

  it('rejects redirects and never follows their Location header', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.invalid/collect' },
    }));
    const client = new ElasticsearchHttp({ url: 'http://127.0.0.1:19200', fetch });

    await expect(client.request('/_search', {}, { method: 'POST', signal }))
      .rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it('cancels a response stream as soon as the byte limit is crossed', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"too":"large"}'));
      },
      cancel() { canceled = true; },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, {
      headers: { 'content-type': 'application/json' },
    }));
    const client = new ElasticsearchHttp({ url: 'http://127.0.0.1:19200', fetch, maxResponseBytes: 8 });

    await expect(client.request('/_search', {}, { method: 'POST', signal }))
      .rejects.toBeInstanceOf(SourceFailure);
    expect(canceled).toBe(true);
  });

  it('returns undefined for an empty successful response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new ElasticsearchHttp({ url: 'http://127.0.0.1:19200', fetch });

    await expect(client.request('/_pit', {}, { method: 'DELETE', signal })).resolves.toBeUndefined();
  });
});
