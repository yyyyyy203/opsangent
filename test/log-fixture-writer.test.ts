import { describe, expect, it, vi } from 'vitest';
import type { NormalizedLogRecord } from '../src/contracts/storage.js';
import { writeLogFixture } from '../src/infrastructure/elk/log-fixture-writer.js';

const index = 'agentops-lab-logs-fixture-1';
const signal = new AbortController().signal;
// eslint-disable-next-line @typescript-eslint/require-await
async function* records(count: number, message = 'ok'): AsyncIterable<NormalizedLogRecord> {
  for (let i = 0; i < count; i++) yield { timestamp: '2026-10-03T00:04:59Z', service: 'checkout', message: `${message}${i}` };
}

function fakeElasticsearch(input?: { itemFailure?: boolean; hideTopLevelError?: boolean; count?: number }) {
  const requests: { url: string; method: string; body: string; contentType: string }[] = [];
  const fetcher = vi.fn<typeof fetch>((resource, init) => {
    const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    const contentType = new Headers(init?.headers).get('content-type') ?? '';
    requests.push({ url, method, body, contentType });
    if (url.endsWith('/_bulk')) {
      const rows = body.trimEnd().split('\n');
      const items = Array.from({ length: rows.length / 2 }, (_, i) => ({ index: { status: input?.itemFailure && i === 0 ? 400 : 201 } }));
      return Promise.resolve(Response.json({ errors: (input?.itemFailure ?? false) && !input?.hideTopLevelError, items }));
    }
    if (url.endsWith('/_refresh')) return Promise.resolve(Response.json({ _shards: { total: 1, successful: 1, failed: 0 } }));
    if (url.endsWith('/_count')) return Promise.resolve(Response.json({ count: input?.count ?? 2 }));
    return Promise.resolve(Response.json({ acknowledged: true }));
  });
  return { fetcher, requests };
}

describe('isolated log fixture writer', () => {
  it('creates one index, streams NDJSON with final newlines, then refreshes and verifies count', async () => {
    const fake = fakeElasticsearch();
    await expect(writeLogFixture({ url: 'http://127.0.0.1:19200', index, records: records(2), signal, fetch: fake.fetcher }))
      .resolves.toEqual({ recordCount: 2 });
    expect(fake.requests.map(({ url, method }) => [method, new URL(url).pathname])).toEqual([
      ['PUT', `/${index}`], ['POST', '/_bulk'], ['POST', `/${index}/_refresh`], ['POST', `/${index}/_count`],
    ]);
    expect(fake.requests[2]).toMatchObject({ body: '', contentType: '' });
    const bulk = fake.requests[1]!.body;
    expect(bulk.endsWith('\n')).toBe(true);
    expect(bulk.split('\n').filter(Boolean)).toHaveLength(4);
    expect(bulk).toContain(`"_index":"${index}"`);
    expect(fake.requests.every(({ url }) => !url.includes('_delete'))).toBe(true);
  });

  it('splits before 512 KiB and rejects an oversized encoded row', async () => {
    const fake = fakeElasticsearch({ count: 2 });
    await writeLogFixture({ url: 'http://127.0.0.1:19200', index, records: records(2, 'x'.repeat(300_000)), signal, fetch: fake.fetcher });
    const bulks = fake.requests.filter(({ url }) => url.endsWith('/_bulk'));
    expect(bulks).toHaveLength(2);
    expect(bulks.every(({ body }) => Buffer.byteLength(body) <= 512 * 1024 && body.endsWith('\n'))).toBe(true);
    const oversized = fakeElasticsearch();
    await expect(writeLogFixture({ url: 'http://127.0.0.1:19200', index, records: records(1, 'x'.repeat(530_000)), signal, fetch: oversized.fetcher }))
      .rejects.toThrow('FIXTURE_RECORD_TOO_LARGE');
    expect(oversized.requests.some(({ url }) => url.endsWith('/_bulk'))).toBe(false);
  });

  it('fails on a bulk item error even with HTTP 200 and never refreshes', async () => {
    const fake = fakeElasticsearch({ itemFailure: true });
    await expect(writeLogFixture({ url: 'http://127.0.0.1:19200', index, records: records(2), signal, fetch: fake.fetcher }))
      .rejects.toThrow('FIXTURE_BULK_FAILED');
    expect(fake.requests.some(({ url }) => url.endsWith('/_refresh'))).toBe(false);
  });

  it('rejects a failed bulk item when HTTP is 200 and errors is false', async () => {
    const fake = fakeElasticsearch({ itemFailure: true, hideTopLevelError: true });
    await expect(writeLogFixture({ url: 'http://127.0.0.1:19200', index, records: records(2), signal, fetch: fake.fetcher }))
      .rejects.toThrow('FIXTURE_BULK_FAILED');
    expect(fake.requests.map(({ url }) => new URL(url).pathname)).toEqual([`/${index}`, '/_bulk']);
  });

  it('does not report ready when refreshed count differs or index is outside lab namespace', async () => {
    const fake = fakeElasticsearch({ count: 1 });
    await expect(writeLogFixture({ url: 'http://127.0.0.1:19200', index, records: records(2), signal, fetch: fake.fetcher }))
      .rejects.toThrow('FIXTURE_COUNT_MISMATCH');
    await expect(writeLogFixture({ url: 'http://127.0.0.1:19200', index: 'business-logs', records: records(1), signal, fetch: fake.fetcher }))
      .rejects.toThrow('INVALID_FIXTURE_INDEX');
    expect(fake.requests.every(({ method }) => method !== 'DELETE')).toBe(true);
  });
});
