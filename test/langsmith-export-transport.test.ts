import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createAuditedLangSmithFetch } from '../src/acceptance/langsmith-export-transport.js';
import { isSafeLangSmithExportBody } from '../src/acceptance/langsmith-export-safety.js';

const config = {
  enabled: true,
  apiKey: 'offline-test-key',
  projectName: 'offline-smoke',
  endpoint: 'https://smith.invalid',
} as const;
const runId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const maxBytes = 1_048_576;
const canary = 'OFFLINE_PRIVATE_CANARY';
const safeRun = {
  id: runId, name: 'agent.run', run_type: 'chain', trace_id: runId,
  session_name: 'Agent Acceptance 巡检', start_time: 0,
  inputs: { profile: 'simulation', purpose: 'inspection' },
  outputs: { status: 'completed', usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
  extra: { metadata: { agentRunId: 'run-1', eventType: 'RUN_FINISHED' } },
  serialized: {}, events: [], attachments: [], child_runs: [], tags: ['event-v2'], error: null,
};

function capture() {
  const requests: Request[] = [];
  const rejected: string[] = [];
  const fetcher: typeof fetch = (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(new Response('{}'));
  };
  return {
    requests, rejected,
    audited: createAuditedLangSmithFetch(fetcher, config, [canary, config.apiKey],
      (code = 'LEGACY_REJECTION') => { rejected.push(code); }),
  };
}

function sdkMultipart(parts: readonly (readonly [string, unknown])[], boundary = 'OfflineSdkBoundary'): string {
  return parts.map(([name, value]) => {
    const json = JSON.stringify(value);
    return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}\r\n`;
  }).join('')
    + `--${boundary}--\r\n`;
}

function multipartInit(parts: readonly (readonly [string, unknown])[]): RequestInit {
  return {
    method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=OfflineSdkBoundary' },
    body: sdkMultipart(parts),
  };
}

async function exportedParts(request: Request): Promise<Record<string, unknown>> {
  const entries: [string, unknown][] = [];
  const data = await request.formData();
  const values: [string, FormDataEntryValue][] = [];
  data.forEach((value, name) => { values.push([name, value]); });
  for (const [name, value] of values) {
    entries.push([name, JSON.parse(typeof value === 'string' ? value : await value.text()) as unknown]);
  }
  return Object.fromEntries(entries);
}

describe('LangSmith audited export transport', () => {
  it('keeps the one-second deadline active through a headers-first stalled response body', async () => {
    let forwardedSignal: AbortSignal | undefined;
    let cancelled = false;
    const audited = createAuditedLangSmithFetch((input, init) => {
      forwardedSignal = new Request(input, init).signal;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), {
        headers: { 'content-type': 'application/json' },
      }));
    }, config, [], () => { throw new Error('Network timeout must not be a local audit rejection.'); });
    await expect(audited(`${config.endpoint}/info`)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(forwardedSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it('accepts the SDK multipart record layout after stripping runtime', async () => {
    const sent: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      sent.push(await request.text());
      return new Response('{}');
    };
    const rejected: string[] = [];
    const audited = createAuditedLangSmithFetch(fetcher, config, [], () => { rejected.push('rejected'); });
    const boundary = 'OfflineSdkBoundary';
    const parts = [
      [`post.${runId}`, { id: runId, name: 'agent.run', run_type: 'chain' }],
      [`post.${runId}.inputs`, { profile: 'simulation', purpose: 'inspection' }],
      [`post.${runId}.extra`, { metadata: { agentRunId: 'run-1' }, runtime: { platform: 'node' } }],
    ] as const;
    const body = parts.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}\r\n`).join('')
      + `--${boundary}--\r\n`;

    const response = await audited(`${config.endpoint}/runs/multipart`, {
      method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body,
    });

    expect(response.status).toBe(200);
    expect(rejected).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('runtime');
    expect(sent[0]).toContain('simulation');
  });

  it('reassembles out-of-order split fields for distinct post and patch records', async () => {
    const { audited, requests, rejected } = capture();
    const response = await audited(`${config.endpoint}/runs/multipart`, multipartInit([
      [`patch.${otherId}.outputs`, safeRun.outputs],
      [`post.${runId}.inputs`, safeRun.inputs],
      [`post.${runId}`, { id: runId, name: 'agent.run', run_type: 'chain' }],
      [`patch.${otherId}`, { id: otherId, end_time: 1 }],
      [`post.${runId}.extra`, { ...safeRun.extra, runtime: { cwd: canary } }],
      [`patch.${otherId}.events`, []], [`patch.${otherId}.serialized`, {}],
      [`patch.${otherId}.error`, 'TRACE_ERROR'],
    ]));
    expect(response.status).toBe(200);
    expect(rejected).toEqual([]);
    expect(requests).toHaveLength(1);
    const parts = await exportedParts(requests[0]!);
    expect(parts[`post.${runId}.inputs`]).toEqual({ profile: 'simulation', purpose: 'inspection' });
    expect(parts[`post.${runId}.extra`]).toEqual({ metadata: { agentRunId: 'run-1', eventType: 'RUN_FINISHED' } });
    expect(parts[`patch.${otherId}.outputs`]).toEqual(safeRun.outputs);
    expect(parts[`patch.${otherId}.error`]).toBe('TRACE_ERROR');
    expect(JSON.stringify(parts)).not.toContain(canary);
  });

  it.each(['identity', 'gzip'])('rebuilds audited JSON batches with %s encoding', async (encoding) => {
    const { audited, requests, rejected } = capture();
    const body = JSON.stringify({ post: [{ ...safeRun, extra: { ...safeRun.extra, runtime: { platform: 'node', cwd: canary } } }], patch: [{ id: otherId, error: 'TRACE_ERROR' }], pre: [] });
    const response = await audited(`${config.endpoint}/runs/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': '1', cookie: canary },
      body: encoding === 'gzip' ? gzipSync(body) : body,
    });
    expect(response.status).toBe(200);
    expect(rejected).toEqual([]);
    const forwarded = requests[0]!;
    expect(forwarded.redirect).toBe('error');
    expect(forwarded.headers.get('content-encoding')).toBeNull();
    expect(forwarded.headers.get('content-length')).toBeNull();
    expect(forwarded.headers.get('cookie')).toBeNull();
    expect(forwarded.headers.get('x-api-key')).toBe(config.apiKey);
    const exported = await forwarded.text();
    expect(exported).not.toContain('runtime');
    expect(exported).not.toContain(canary);
    expect(isSafeLangSmithExportBody(exported)).toBe(true);
  });

  it('accepts a streamed gzip SDK multipart body with a quoted boundary', async () => {
    const { audited, requests } = capture();
    const compressed = gzipSync(sdkMultipart([[`post.${runId}`, safeRun]]));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= compressed.length) controller.close();
        else {
          controller.enqueue(compressed.subarray(offset, offset + 17));
          offset += 17;
        }
      },
    });
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST', body, duplex: 'half',
      headers: { 'content-type': 'multipart/form-data; boundary="OfflineSdkBoundary"', 'content-encoding': 'gzip' },
    };
    expect((await audited(`${config.endpoint}/runs/multipart`, init)).status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('content-encoding')).toBeNull();
    const parts = await exportedParts(requests[0]!);
    expect(parts[`post.${runId}.outputs`]).toEqual(safeRun.outputs);
  });

  const unsafeRuns = [
    ['prompt', { ...safeRun, inputs: { prompt: 'private prompt' } }],
    ['model text', { ...safeRun, outputs: { text: 'private model output' } }],
    ['log', { ...safeRun, extra: { metadata: { rawLog: 'private log' } } }],
    ['canary', { ...safeRun, session_name: canary }],
    ['key', { ...safeRun, session_name: config.apiKey }],
    ['internal address', { ...safeRun, session_name: 'http://10.1.2.3' }],
    ['private path', { ...safeRun, session_name: 'D:\\private\\source' }],
    ['attachment', { ...safeRun, attachments: [{ name: 'private.txt' }] }],
    ['event text', { ...safeRun, events: [{ name: 'private text' }] }],
    ['serialized model', { ...safeRun, serialized: { model: 'private' } }],
    ['error text', { ...safeRun, error: 'private error text' }],
    ['unknown field', { ...safeRun, unknown: 'opaque' }],
    ['coerced type', { ...safeRun, run_type: ['chain'] }],
  ] as const;

  describe.each(['json', 'multipart'])('%s payload safety', (format) => {
    it.each(unsafeRuns)('blocks %s before external fetch', async (_name, run) => {
      const { audited, requests, rejected } = capture();
      const response = await audited(`${config.endpoint}/runs/${format === 'json' ? 'batch' : 'multipart'}`,
        format === 'json'
          ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ post: [run] }) }
          : multipartInit([[`post.${runId}`, run]]));
      expect(response.status).toBe(400);
      expect(response.headers.get('x-agentops-trace-error')).toBe('TRACE_LOCAL_AUDIT_REJECTED');
      expect(await response.json()).toEqual({ error: 'TRACE_LOCAL_AUDIT_REJECTED' });
      expect(rejected).toEqual(['TRACE_LOCAL_AUDIT_REJECTED']);
      expect(requests).toEqual([]);
    });
  });

  it.each([
    ['duplicate main', [[`post.${runId}`, safeRun], [`post.${runId}`, safeRun]]],
    ['duplicate field', [[`post.${runId}`, { id: runId, name: 'agent.run', run_type: 'chain' }], [`post.${runId}.inputs`, {}], [`post.${runId}.inputs`, {}]]],
    ['embedded collision', [[`post.${runId}`, safeRun], [`post.${runId}.inputs`, {}]]],
    ['orphan', [[`post.${runId}.inputs`, {}]]],
    ['mismatched id', [[`post.${runId}`, { ...safeRun, id: otherId }]]],
    ['unknown field', [[`post.${runId}`, safeRun], [`post.${runId}.unknown`, {}]]],
    ['attachment part', [[`post.${runId}`, safeRun], [`attachment.${runId}.log`, 'private']]],
    ['unknown operation', [[`pre.${runId}`, safeRun]]],
    ['invalid uuid', [['post.opaque', { ...safeRun, id: 'opaque' }]]],
    ['non-object main', [[`post.${runId}`, []]]],
    ['empty form', []],
  ] satisfies [string, [string, unknown][]][])('rejects multipart %s', async (_name, parts) => {
    const { audited, requests, rejected } = capture();
    expect((await audited(`${config.endpoint}/runs/multipart`, multipartInit(parts))).status).toBe(400);
    expect(requests).toEqual([]);
    expect(rejected).toEqual(['TRACE_LOCAL_AUDIT_REJECTED']);
  });

  it('rejects filename-bearing parts even if they claim a valid JSON field name', async () => {
    const { audited, requests } = capture();
    const form = new FormData();
    form.append(`post.${runId}`, new Blob([JSON.stringify(safeRun)], { type: 'application/json' }), 'private.json');
    expect((await audited(`${config.endpoint}/runs/multipart`, { method: 'POST', body: form })).status).toBe(400);
    expect(requests).toEqual([]);
  });

  it.each([
    ['missing boundary', 'multipart/form-data', 'invalid'],
    ['truncated form', 'multipart/form-data; boundary=OfflineSdkBoundary', sdkMultipart([[`post.${runId}`, safeRun]]).slice(0, -30)],
    ['invalid part JSON', 'multipart/form-data; boundary=OfflineSdkBoundary', sdkMultipart([[`post.${runId}`, safeRun]]).replace('"id":', '"id":bad')],
    ['wrong media type', 'text/plain', JSON.stringify({ post: [safeRun] })],
    ['invalid JSON', 'application/json', '{'],
    ['empty JSON', 'application/json', ''],
    ['unknown JSON envelope', 'application/json', JSON.stringify({ unknown: [safeRun] })],
  ])('rejects %s', async (_name, type, body) => {
    const { audited, requests } = capture();
    const path = type.startsWith('multipart') ? 'multipart' : 'batch';
    expect((await audited(`${config.endpoint}/runs/${path}`, { method: 'POST', headers: { 'content-type': type }, body })).status).toBe(400);
    expect(requests).toEqual([]);
  });

  it.each([
    ['insecure URL', 'http://smith.invalid/runs/batch', 'POST'],
    ['foreign origin', 'https://other.invalid/runs/batch', 'POST'],
    ['userinfo', 'https://user:pass@smith.invalid/runs/batch', 'POST'],
    ['query', 'https://smith.invalid/runs/batch?key=private', 'POST'],
    ['fragment', 'https://smith.invalid/runs/batch#private', 'POST'],
    ['unknown path', 'https://smith.invalid/sessions', 'POST'],
    ['encoded path', 'https://smith.invalid/runs/%62atch', 'POST'],
    ['extra path', 'https://smith.invalid/runs/batch/other', 'POST'],
    ['wrong batch method', 'https://smith.invalid/runs/batch', 'PUT'],
    ['wrong info method', 'https://smith.invalid/info', 'POST'],
    ['wrong multipart method', 'https://smith.invalid/runs/multipart', 'PATCH'],
  ])('rejects %s before external fetch', async (_name, url, method) => {
    const { audited, requests, rejected } = capture();
    expect((await audited(url, { method, body: JSON.stringify({ post: [safeRun] }) })).status).toBe(400);
    expect(requests).toEqual([]);
    expect(rejected).toEqual(['TRACE_LOCAL_AUDIT_REJECTED']);
  });

  it('passes through the real empty GET info response with redirects disabled', async () => {
    const requests: Request[] = [];
    const response = Response.json({ batch_ingest_config: { use_multipart_endpoint: true } });
    const fetcher: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(response);
    };
    const audited = createAuditedLangSmithFetch(fetcher, config, [], () => { throw new Error('UNEXPECTED_REJECTION'); });
    const result = await audited(new Request(`${config.endpoint}/info`));
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('application/json');
    expect(await result.json()).toEqual({ batch_ingest_config: { use_multipart_endpoint: true } });
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.body).toBeNull();
    expect(requests[0]!.redirect).toBe('error');
  });

  it('honors the configured endpoint path and RequestInit overrides', async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(new Response('{}'));
    };
    const audited = createAuditedLangSmithFetch(fetcher, { ...config, endpoint: `${config.endpoint}/api/v1/` }, [], () => {});
    const controller = new AbortController();
    const response = await audited(new Request(`${config.endpoint}/api/v1/runs/batch`), {
      method: 'POST', body: JSON.stringify({ post: [safeRun] }), headers: { 'content-type': 'application/json' }, signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(requests[0]!.url).toBe(`${config.endpoint}/api/v1/runs/batch`);
    controller.abort();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect((await audited(`${config.endpoint}/info`)).status).toBe(400);
  });

  it.each(['http://smith.invalid', 'https://user:pass@smith.invalid', 'https://smith.invalid?private=1', 'https://smith.invalid#private'])('fails closed for invalid config endpoint %s', async (endpoint) => {
    const requests: RequestInfo[] = [];
    const fetcher: typeof fetch = (input) => { requests.push(input as RequestInfo); return Promise.resolve(new Response('{}')); };
    const rejected: string[] = [];
    const audited = createAuditedLangSmithFetch(fetcher, { ...config, endpoint }, [], (code = 'LEGACY_REJECTION') => { rejected.push(code); });
    expect((await audited(`${config.endpoint}/info`)).status).toBe(400);
    expect(requests).toEqual([]);
    expect(rejected).toEqual(['TRACE_LOCAL_AUDIT_REJECTED']);
  });

  it.each([
    ['oversized wire', 'identity', new Uint8Array(maxBytes + 1)],
    ['gzip bomb', 'gzip', gzipSync(' '.repeat(maxBytes + 1))],
    ['corrupt gzip', 'gzip', new TextEncoder().encode('not gzip')],
    ['stacked encoding', 'gzip, gzip', gzipSync('{}')],
    ['unsupported encoding', 'br', new Uint8Array([1, 2, 3])],
  ])('bounds and rejects %s', async (_name, encoding, body) => {
    const { audited, requests, rejected } = capture();
    expect((await audited(`${config.endpoint}/runs/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': encoding }, body,
    })).status).toBe(400);
    expect(requests).toEqual([]);
    expect(rejected).toEqual(['TRACE_LOCAL_AUDIT_REJECTED']);
  });

  it('accepts exactly one MiB decoded JSON and rejects one byte beyond it', async () => {
    const base = JSON.stringify({ post: [safeRun] });
    const exact = base + ' '.repeat(maxBytes - Buffer.byteLength(base));
    const { audited, requests } = capture();
    const headers = { 'content-type': 'application/json', 'content-encoding': 'gzip' };
    expect((await audited(`${config.endpoint}/runs/batch`, { method: 'POST', headers, body: gzipSync(exact) })).status).toBe(200);
    expect((await audited(`${config.endpoint}/runs/batch`, { method: 'POST', headers, body: gzipSync(exact + ' ') })).status).toBe(400);
    expect(requests).toHaveLength(1);
  });

  it('cancels an oversized stream without waiting for an uncooperative cancellation', async () => {
    const { audited, requests } = capture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(65_536)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/json' } };
    expect((await audited(`${config.endpoint}/runs/batch`, init)).status).toBe(400);
    expect(cancelled).toBe(true);
    expect(requests).toEqual([]);
  });

  it('bounds stream work even when an attacker sends only zero-length chunks', async () => {
    const { audited, requests } = capture();
    let chunks = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++chunks <= 65_537) controller.enqueue(new Uint8Array());
        else if (chunks === 65_538) controller.enqueue(new TextEncoder().encode(JSON.stringify({ post: [safeRun] })));
        else controller.close();
      },
      cancel() { cancelled = true; },
    });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/json' } };
    expect((await audited(`${config.endpoint}/runs/batch`, init)).status).toBe(400);
    expect(cancelled).toBe(true);
    expect(requests).toEqual([]);
  });

  it.each([
    ['inputs', { prompt: 'private prompt' }],
    ['outputs', { text: 'private model text' }],
    ['extra', { metadata: { rawLog: 'private log' } }],
    ['events', [{ name: 'private event' }]],
    ['serialized', { model: 'private serialized text' }],
    ['error', 'private error text'],
  ])('audits the reassembled %s field before external fetch', async (field, value) => {
    const { audited, requests, rejected } = capture();
    expect((await audited(`${config.endpoint}/runs/multipart`, multipartInit([
      [`post.${runId}`, { id: runId, name: 'agent.run', run_type: 'chain' }],
      [`post.${runId}.${field}`, value],
    ]))).status).toBe(400);
    expect(requests).toEqual([]);
    expect(rejected).toEqual(['TRACE_LOCAL_AUDIT_REJECTED']);
  });

  it('rejects invalid UTF-8 rather than auditing replacement characters', async () => {
    const { audited, requests } = capture();
    const prefix = new TextEncoder().encode(`{"post":[{"id":"${runId}","name":"agent.run","run_type":"chain","session_name":"`);
    const suffix = new TextEncoder().encode('"}]}');
    const body = new Uint8Array([...prefix, 0xff, ...suffix]);
    expect((await audited(`${config.endpoint}/runs/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(400);
    expect(requests).toEqual([]);
  });

  it('times out a stalled input without network or audit-rejection misclassification', async () => {
    const { audited, requests, rejected } = capture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/json' } };
    await expect(audited(`${config.endpoint}/runs/batch`, init)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cancelled).toBe(true);
    expect(requests).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it('enforces the one second deadline even if a fake fetch ignores cancellation', async () => {
    const rejected: string[] = [];
    const signals: AbortSignal[] = [];
    const fetcher: typeof fetch = (input, init) => {
      signals.push(new Request(input, init).signal);
      return new Promise<Response>(() => {});
    };
    const audited = createAuditedLangSmithFetch(fetcher, config, [], (code) => { rejected.push(code); });
    await expect(audited(`${config.endpoint}/info`)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(rejected).toEqual([]);
  });

  it('propagates a pre-aborted Request without classifying it as an audit rejection', async () => {
    const { audited, requests, rejected } = capture();
    const controller = new AbortController();
    controller.abort();
    await expect(audited(new Request(`${config.endpoint}/info`, { signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it('aborts a stalled input stream and cancels its reader before external fetch', async () => {
    const { audited, requests, rejected } = capture();
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half', signal: controller.signal, headers: { 'content-type': 'application/json' } };
    const pending = audited(`${config.endpoint}/runs/batch`, init);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
    expect(requests).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it('propagates caller abort while the external fetch is pending', async () => {
    const controller = new AbortController();
    const rejected: string[] = [];
    const fetcher: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      controller.abort();
      expect(request.signal.aborted).toBe(true);
      return Promise.reject(new DOMException('offline aborted', 'AbortError'));
    };
    const audited = createAuditedLangSmithFetch(fetcher, config, [], (code = 'LEGACY_REJECTION') => { rejected.push(code); });
    await expect(audited(`${config.endpoint}/info`, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(rejected).toEqual([]);
  });

  it('preserves network failures and remote HTTP status without local rejection', async () => {
    const failure = new Error('OFFLINE_NETWORK_FAILURE');
    const rejected: string[] = [];
    let attempt = 0;
    const remote = new Response('{}', { status: 429 });
    const fetcher: typeof fetch = () => ++attempt === 1 ? Promise.reject(failure) : Promise.resolve(remote);
    const audited = createAuditedLangSmithFetch(fetcher, config, [], (code = 'LEGACY_REJECTION') => { rejected.push(code); });
    await expect(audited(`${config.endpoint}/info`)).rejects.toBe(failure);
    const result = await audited(`${config.endpoint}/info`);
    expect(result.status).toBe(remote.status);
    expect(await result.json()).toEqual({ error: 'TRACE_HTTP_429' });
    expect(remote.headers.get('x-agentops-trace-error')).toBeNull();
    expect(attempt).toBe(2);
    expect(rejected).toEqual([]);
  });

  it('rejects a redirect response from a custom fetch implementation', async () => {
    const rejected: string[] = [];
    const fetcher: typeof fetch = () => Promise.resolve(Response.redirect('https://other.invalid', 307));
    const audited = createAuditedLangSmithFetch(fetcher, config, [], (code = 'LEGACY_REJECTION') => { rejected.push(code); });
    expect((await audited(`${config.endpoint}/info`)).status).toBe(400);
    expect(rejected).toEqual(['TRACE_LOCAL_AUDIT_REJECTED']);
  });

  it('preserves the existing JSON whitelist including empty arrays and Unicode project names', () => {
    expect(isSafeLangSmithExportBody(JSON.stringify({ post: [safeRun], pre: [], patch: [{ id: otherId, error: 'TRACE_ERROR' }] }))).toBe(true);
    expect(isSafeLangSmithExportBody(JSON.stringify({ post: [{ ...safeRun, extra: { runtime: {} } }] }))).toBe(false);
    expect(isSafeLangSmithExportBody(JSON.stringify({ post: [safeRun] }), [runId])).toBe(false);
    expect(isSafeLangSmithExportBody(JSON.stringify({ post: [] }))).toBe(false);
  });
});
