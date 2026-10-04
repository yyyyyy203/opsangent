import type { NormalizedLogRecord } from '../../contracts/storage.js';
import { ElasticsearchHttp } from './elasticsearch-http.js';

const MAX_BULK_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const LAB_INDEX = /^agentops-lab-logs-[a-z0-9][a-z0-9-]{0,127}$/;

export interface LogFixtureWriteOptions {
  url: string;
  index: string;
  records: AsyncIterable<NormalizedLogRecord>;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

/** The only writer for a newly created, invocation-owned lab evidence index. Never deletes it. */
export async function writeLogFixture(options: LogFixtureWriteOptions): Promise<{ recordCount: number }> {
  const { index, signal } = options;
  if (!LAB_INDEX.test(index)) throw new TypeError('INVALID_FIXTURE_INDEX');
  const http = new ElasticsearchHttp({ url: options.url, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  const created = await http.request(`/${index}`, {
    mappings: { properties: {
      timestamp: { type: 'date' }, service: { type: 'keyword' }, level: { type: 'keyword' },
      exception: { type: 'keyword' }, traceId: { type: 'keyword' }, message: { type: 'text' },
    } },
  }, { method: 'PUT', signal });
  if (!isObject(created) || created.acknowledged !== true) throw new Error('FIXTURE_CREATE_FAILED');

  const base = new URL(options.url);
  const fetcher = options.fetch ?? globalThis.fetch;
  let lines: string[] = [];
  let bytes = 0;
  let recordCount = 0;
  let batchCount = 0;
  const flush = async (): Promise<void> => {
    if (batchCount === 0) return;
    const result = await postBulk(new URL('/_bulk', base), lines.join(''), signal, fetcher);
    if (!isObject(result) || result.errors !== false || !Array.isArray(result.items)
      || result.items.length !== batchCount || result.items.some((item: unknown) => {
        if (!isObject(item) || !isObject(item.index)) return true;
        return !Number.isInteger(item.index.status) || (item.index.status as number) < 200 || (item.index.status as number) >= 300
          || item.index.error !== undefined;
      })) throw new Error('FIXTURE_BULK_FAILED');
    lines = [];
    bytes = 0;
    batchCount = 0;
  };

  for await (const record of options.records) {
    signal.throwIfAborted();
    const item = `${JSON.stringify({ index: { _index: index } })}\n${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(item);
    if (size > MAX_BULK_BYTES) throw new Error('FIXTURE_RECORD_TOO_LARGE');
    if (bytes + size > MAX_BULK_BYTES) await flush();
    lines.push(item);
    bytes += size;
    batchCount++;
    recordCount++;
  }
  await flush();

  const refreshed = await http.request(`/${index}/_refresh`, undefined, { method: 'POST', signal });
  if (!isObject(refreshed) || !isObject(refreshed._shards) || refreshed._shards.failed !== 0) {
    throw new Error('FIXTURE_REFRESH_FAILED');
  }
  const counted = await http.request(`/${index}/_count`, { query: { match_all: {} } }, { method: 'POST', signal });
  if (!isObject(counted) || counted.count !== recordCount) throw new Error('FIXTURE_COUNT_MISMATCH');
  return { recordCount };
}

async function postBulk(url: URL, body: string, signal: AbortSignal, fetcher: typeof globalThis.fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-ndjson' },
      body, signal, redirect: 'manual',
    });
  } catch {
    throw new Error(signal.aborted ? 'FIXTURE_ABORTED' : 'FIXTURE_BULK_FAILED');
  }
  if (!response.ok || response.status >= 300 || response.body === null) {
    await response.body?.cancel();
    throw new Error('FIXTURE_BULK_FAILED');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('FIXTURE_BULK_RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new Error('FIXTURE_BULK_FAILED'); }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
