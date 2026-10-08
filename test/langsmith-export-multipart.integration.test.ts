import { Client } from 'langsmith';
import { describe, expect, it } from 'vitest';
import { createAuditedLangSmithFetch } from '../src/acceptance/langsmith-export-transport.js';

describe('offline LangSmith SDK multipart negotiation', () => {
  it.each([false, true])('exports after genuine info negotiation with gzip=%s', async (useGzip) => {
    const config = { enabled: true, apiKey: 'offline-test-key', projectName: 'offline-smoke', endpoint: 'https://smith.invalid' } as const;
    const requests: { path: string; body: string; redirect: RequestRedirect; multipartValid: boolean }[] = [];
    const rejected: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/info') {
        requests.push({ path, body: await request.text(), redirect: request.redirect, multipartValid: true });
        return Response.json({ batch_ingest_config: { use_multipart_endpoint: true }, instance_flags: { gzip_body_enabled: useGzip } });
      }
      expect(path).toBe('/runs/multipart');
      const rawBody = await request.text();
      const multipartValid = hasSdkCompatibleParts(rawBody, request.headers.get('content-type') ?? '');
      const data = await new Response(rawBody, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
      const fields: Record<string, unknown> = {};
      const entries: [string, FormDataEntryValue][] = [];
      data.forEach((value, name) => { entries.push([name, value]); });
      for (const [name, value] of entries) {
        fields[name] = JSON.parse(typeof value === 'string' ? value : await value.text()) as unknown;
      }
      requests.push({ path, body: JSON.stringify(fields), redirect: request.redirect, multipartValid });
      return multipartValid ? Response.json({}) : Response.json({ error: 'TRACE_HTTP_422' }, { status: 422 });
    };
    const client = new Client({
      apiUrl: config.endpoint, apiKey: config.apiKey, timeout_ms: 1_000,
      callerOptions: { maxRetries: 0 }, autoBatchTracing: true, manualFlushMode: true,
      blockOnRootRunFinalization: false, omitTracedRuntimeInfo: true, debug: false,
      fetchImplementation: createAuditedLangSmithFetch(fetcher, config, ['PRIVATE_PROMPT', 'PRIVATE_MODEL_TEXT'],
        (code = 'LEGACY_REJECTION') => { rejected.push(code); }),
    });
    const runId = '11111111-1111-4111-8111-111111111111';
    const dottedOrder = `20261007T120000000000Z${runId}`;
    await client.createRun({
      id: runId, trace_id: runId, dotted_order: dottedOrder,
      name: 'agent.run', run_type: 'chain', project_name: config.projectName,
      inputs: { profile: 'simulation', purpose: 'inspection' },
      extra: { metadata: { agentRunId: 'run-1' }, runtime: { platform: 'offline-sdk' } },
    });
    await client.flush();
    await client.updateRun(runId, {
      trace_id: runId, dotted_order: dottedOrder, end_time: 1,
      outputs: { status: 'completed', usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      events: [], serialized: {}, error: 'TRACE_ERROR',
    });
    await client.flush();

    expect(rejected).toEqual([]);
    expect(requests.map(({ path }) => path)).toEqual(['/info', '/runs/multipart', '/runs/multipart']);
    expect(requests.every(({ redirect }) => redirect === 'error')).toBe(true);
    expect(requests.filter(({ path }) => path === '/runs/multipart').every(({ multipartValid }) => multipartValid)).toBe(true);
    const exported = requests.map(({ body }) => body).join('\n');
    expect(exported).toContain(`post.${runId}`);
    expect(exported).toContain(`patch.${runId}.outputs`);
    expect(exported).toContain('input_tokens');
    expect(exported).not.toContain('runtime');
    expect(exported).not.toContain('offline-sdk');
    expect(exported).not.toContain('PRIVATE_PROMPT');
    expect(exported).not.toContain('PRIVATE_MODEL_TEXT');
  });
});

function hasSdkCompatibleParts(body: string, contentType: string): boolean {
  const boundary = /(?:^|;)\s*boundary=(?:"([^";]+)"|([^;\s]+))/iu.exec(contentType);
  const token = boundary?.[1] ?? boundary?.[2];
  if (token === undefined) return false;
  const parts = body.split(`--${token}`).slice(1, -1);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) return false;
    const headers = part.slice(0, separator);
    const payload = part.slice(separator + 4).replace(/\r\n$/u, '');
    if (/content-disposition:[^\r\n]*\bfilename\s*=/iu.test(headers)) return false;
    const contentType = /^content-type:\s*application\/json\s*$/imu.test(headers);
    const length = /^content-length:\s*(\d+)\s*$/imu.exec(headers)?.[1];
    return contentType && length !== undefined && Number(length) === Buffer.byteLength(payload, 'utf8');
  });
}
