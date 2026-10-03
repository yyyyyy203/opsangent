import { describe, expect, it, vi } from 'vitest';
import { createElasticsearchLogSource } from '../src/infrastructure/elk/elasticsearch-log-source.js';
import type { ElasticsearchLogSourceOptions } from '../src/infrastructure/elk/elasticsearch-log-source.js';
import type { LogsSearchPageInput } from '../src/mcp/logs-protocol.js';

const secret = '0123456789abcdef0123456789abcdef';
const start = '2026-10-03T00:00:00Z';
const end = '2026-10-03T00:05:00Z';
const lastTimestamp = '2026-10-03T00:04:59Z';
const now = Date.parse('2026-10-03T00:05:00Z');
const signal = new AbortController().signal;

function createSource(
  options: Omit<ElasticsearchLogSourceOptions, 'onCleanupFailure'>
    & { onCleanupFailure?: ElasticsearchLogSourceOptions['onCleanupFailure'] },
) {
  return createElasticsearchLogSource({
    ...options,
    onCleanupFailure: options.onCleanupFailure ?? (() => undefined),
  });
}

function jsonBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON request body');
  return JSON.parse(init.body) as unknown;
}

function hit(message: string, sort: [string, number]) {
  return { _source: { timestamp: sort[0], service: 'checkout', level: 'ERROR', message }, sort };
}

function response(body: unknown): Response {
  return Response.json(body);
}

describe('Elasticsearch log page source', () => {
  it('keeps a stable logical snapshot when Elasticsearch rotates the private PIT ID', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-1' }))
      .mockResolvedValueOnce(response({ pit_id: 'pit-2', hits: { hits: [hit('timeout', [lastTimestamp, 1])] } }));
    const source = createSource({
      url: 'http://127.0.0.1:19200', index: 'agentops-lab-logs-test', cursorSecret: secret,
      fetch, now: () => now, id: () => 'snapshot-test', pageSize: 1,
    });

    const page = await source.searchPage({ service: 'checkout', start, end, requestId: 'capture-1' }, signal);

    expect(page).toMatchObject({ status: 'available', sourceSnapshotId: 'snapshot-test' });
    expect(JSON.stringify(page)).not.toContain('pit-');
    expect(JSON.stringify(page)).not.toContain('agentops-lab-logs-test');
    const search = jsonBody(fetch.mock.calls[1]?.[1]) as Record<string, unknown>;
    expect(search).toMatchObject({
      size: 1,
      pit: { id: 'pit-1', keep_alive: '2m' },
      sort: [{ timestamp: 'asc' }, { _shard_doc: 'asc' }],
      track_total_hits: false,
      query: { bool: { filter: [
        { term: { service: 'checkout' } },
        { range: { timestamp: { gte: start, lt: end } } },
      ] } },
    });
    expect(JSON.stringify(search)).not.toContain('match_all');
  });

  it('replays the same cursor page without issuing a second Elasticsearch request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-1' }))
      .mockResolvedValueOnce(response({ pit_id: 'pit-2', hits: { hits: [hit('first', [start, 1])] } }))
      .mockResolvedValueOnce(response({ pit_id: 'pit-3', hits: { hits: [hit('second', [lastTimestamp, 2])] } }));
    const source = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch, now: () => now, id: () => 'snapshot-1', pageSize: 1,
    });
    const first = await source.searchPage({ service: 'checkout', start, end, requestId: 'capture-1' }, signal);
    if (first.status !== 'available' || first.nextCursor === undefined) throw new Error('expected a next-page cursor');
    const pageInput: LogsSearchPageInput = {
      service: 'checkout', start, end, sourceSnapshotId: first.sourceSnapshotId, cursor: first.nextCursor,
    };

    const second = await source.searchPage(pageInput, signal);
    const replay = await source.searchPage(pageInput, signal);

    expect(second).toEqual(replay);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(second)).not.toContain('pit-');
    const secondSearch = jsonBody(fetch.mock.calls[2]?.[1]) as Record<string, unknown>;
    expect(secondSearch).toMatchObject({
      pit: { id: 'pit-2', keep_alive: '2m' },
      search_after: [start, 1],
    });
  });

  it('replays a first-page request ID without opening another PIT or advancing state', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-1' }))
      .mockResolvedValueOnce(response({ hits: { hits: [hit('first', [start, 1])] } }));
    const source = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch, now: () => now, id: () => 'snapshot-1', pageSize: 1,
    });
    const input = { service: 'checkout', start, end, requestId: 'capture-retry' };

    const first = await source.searchPage(input, signal);
    const retry = await source.searchPage(input, signal);

    expect(retry).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a cursor reused with a different filter without querying Elasticsearch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-1' }))
      .mockResolvedValueOnce(response({ pit_id: 'pit-2', hits: { hits: [hit('first', [start, 1])] } }));
    const source = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch, now: () => now, id: () => 'snapshot-1', pageSize: 1,
    });
    const first = await source.searchPage({ service: 'checkout', start, end, requestId: 'capture-1' }, signal);
    if (first.status !== 'available' || first.nextCursor === undefined) throw new Error('expected a next-page cursor');

    const denied = await source.searchPage({
      service: 'checkout', start, end, level: 'WARN',
      sourceSnapshotId: first.sourceSnapshotId, cursor: first.nextCursor,
    }, signal);

    expect(denied).toMatchObject({ status: 'source_error', code: 'MCP_PROTOCOL_ERROR' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses fixed filter translations and redacts returned records', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-private' }))
      .mockResolvedValueOnce(response({ hits: { hits: [{
        _source: {
          timestamp: lastTimestamp, service: 'checkout', level: 'ERROR',
          message: 'Bearer abc.def', fields: { apiKey: 'secret', route: '/checkout' },
        },
        sort: [end, 2],
      }] } }));
    const source = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch, now: () => now, id: () => 'snapshot-1', pageSize: 2,
    });

    const page = await source.searchPage({ service: 'checkout', start, end, requestId: 'capture-1', contains: 'timeout', traceId: 'trace-1' }, signal);

    expect(page).toMatchObject({
      status: 'available',
      records: [{ message: '[REDACTED]', fields: { apiKey: '[REDACTED]', route: '/checkout' } }],
    });
    const body = jsonBody(fetch.mock.calls[1]?.[1]) as { query: unknown };
    expect(JSON.stringify(body.query)).toContain('match_phrase');
    expect(JSON.stringify(body.query)).toContain('trace-1');
  });

  it('returns structured stale-scope, malformed-hit and source failures without leaking raw details', async () => {
    const staleFetch = vi.fn<typeof globalThis.fetch>();
    const stale = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch: staleFetch, now: () => now + 121_000,
    });
    await expect(stale.searchPage({ service: 'checkout', start, end, requestId: 'capture-1' }, signal))
      .resolves.toMatchObject({ status: 'source_error', code: 'POLICY_DENIED', reason: 'scope_denied' });
    expect(staleFetch).not.toHaveBeenCalled();

    const malformedFetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-private' }))
      .mockResolvedValueOnce(response({ hits: { hits: [{ _source: { timestamp: end }, sort: [] }] } }));
    const malformed = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch: malformedFetch, now: () => now,
    });
    const malformedPage = await malformed.searchPage({ service: 'checkout', start, end, requestId: 'capture-2' }, signal);
    expect(malformedPage).toMatchObject({ status: 'source_error', code: 'MCP_PROTOCOL_ERROR' });
    expect(JSON.stringify(malformedPage)).not.toContain('pit-private');

    const authFetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-private' }))
      .mockResolvedValueOnce(new Response('secret response body', { status: 401 }));
    const auth = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch: authFetch, now: () => now,
    });
    await expect(auth.searchPage({ service: 'checkout', start, end, requestId: 'capture-3' }, signal))
      .resolves.toMatchObject({ status: 'source_error', code: 'MCP_AUTH_ERROR' });
  });

  it('closes the PIT after an aborted search without masking the abort result', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-private' }))
      .mockImplementationOnce(() => {
        controller.abort();
        return Promise.reject(new Error('fetch aborted'));
      })
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const source = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch, now: () => now, id: () => 'snapshot-1', pageSize: 1,
    });

    await expect(source.searchPage({ service: 'checkout', start, end, requestId: 'capture-abort' }, controller.signal))
      .resolves.toMatchObject({ status: 'source_error', code: 'ABORTED' });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });

  it('reports a safe stable code when PIT cleanup fails', async () => {
    const onCleanupFailure = vi.fn(() => { throw new Error('private callback details'); });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-private' }))
      .mockResolvedValueOnce(response({ pit_id: 'pit-rotated', hits: { hits: [hit('still-more', [start, 1])] } }))
      .mockResolvedValueOnce(new Response('private PIT response', { status: 503 }));
    const source = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch, now: () => now, id: () => 'snapshot-1', pageSize: 1, onCleanupFailure,
    });
    const page = await source.searchPage({ service: 'checkout', start, end, requestId: 'capture-cleanup' }, signal);
    if (page.status !== 'available') throw new Error('expected an available page');

    await expect(source.closeSnapshot({ sourceSnapshotId: page.sourceSnapshotId }, signal)).resolves.toBeUndefined();

    expect(onCleanupFailure).toHaveBeenCalledOnce();
    expect(onCleanupFailure).toHaveBeenCalledWith({ code: 'MCP_SERVER_ERROR', sourceSnapshotId: 'snapshot-1' });
  });

  it('rejects an oversized normalized record and treats an expired PIT as unavailable', async () => {
    const oversizedFetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-private' }))
      .mockResolvedValueOnce(response({ hits: { hits: [hit('x'.repeat(9_000), [start, 1])] } }));
    const oversized = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch: oversizedFetch, now: () => now, id: () => 'snapshot-1', pageSize: 1,
    });
    await expect(oversized.searchPage({ service: 'checkout', start, end, requestId: 'capture-large' }, signal))
      .resolves.toMatchObject({ status: 'source_error', code: 'MCP_PROTOCOL_ERROR' });

    const expiredFetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-1' }))
      .mockResolvedValueOnce(response({ hits: { hits: [hit('first', [start, 1])] } }))
      .mockResolvedValueOnce(new Response('not disclosed', { status: 404 }));
    const expired = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch: expiredFetch, now: () => now, id: () => 'snapshot-1', pageSize: 1,
    });
    const first = await expired.searchPage({ service: 'checkout', start, end, requestId: 'capture-expired' }, signal);
    if (first.status !== 'available' || first.nextCursor === undefined) throw new Error('expected a next-page cursor');
    await expect(expired.searchPage({
      service: 'checkout', start, end, sourceSnapshotId: first.sourceSnapshotId, cursor: first.nextCursor,
      }, signal)).resolves.toMatchObject({ status: 'source_error', code: 'UNAVAILABLE', reason: 'snapshot_expired' });
  });

  it('closes a newly opened PIT when the active-session limit rejects its logical session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ id: 'pit-1' }))
      .mockResolvedValueOnce(response({ hits: { hits: [hit('first', [start, 1])] } }))
      .mockResolvedValueOnce(response({ id: 'pit-2' }))
      .mockResolvedValueOnce(response({ succeeded: true }));
    const source = createSource({
      url: 'http://127.0.0.1:19200', index: 'logs-test', cursorSecret: secret,
      fetch, now: () => now, id: (() => { let count = 0; return () => `snapshot-${++count}`; })(),
      maxSessions: 1, pageSize: 1,
    });
    await source.searchPage({ service: 'checkout', start, end, requestId: 'capture-1' }, signal);

    const rejected = await source.searchPage({ service: 'checkout', start, end, requestId: 'capture-2' }, signal);

    expect(rejected).toMatchObject({ status: 'source_error', code: 'MCP_RATE_LIMITED' });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3]?.[1]?.method).toBe('DELETE');
    expect(jsonBody(fetch.mock.calls[3]?.[1])).toEqual({ id: 'pit-2' });
  });
});
