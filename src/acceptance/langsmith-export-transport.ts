import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import type { LangSmithEventConfig } from '../bootstrap/langsmith.js';
import { isSafeLangSmithExportBody } from './langsmith-export-safety.js';
import { resolveLangSmithExportLimits, type LangSmithExportLimits } from '../observability/langsmith-export-policy.js';
import type { TraceRequestDiagnostic } from './diagnostics.js';
import { readLangSmithBytes as readBoundedBytes, withLangSmithAbort as withAbort, langSmithAbortError as abortError, sanitizeLangSmithInfo } from '../observability/langsmith-http.js';

const MAX_BODY_BYTES = 1_048_576;
const REJECTION_CODE = 'TRACE_LOCAL_AUDIT_REJECTED';
const SPLIT_FIELDS = new Set(['inputs', 'outputs', 'extra', 'events', 'error', 'serialized']);
const PART_NAME = /^(post|patch)\.([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})(?:\.(inputs|outputs|extra|events|error|serialized))?$/u;

interface MultipartRecord {
  readonly operation: 'post' | 'patch';
  readonly id: string;
  readonly fields: Map<string, unknown>;
  main?: Record<string, unknown>;
}

type Batch = Record<string, unknown>;

export interface AuditedLangSmithFetchOptions {
  readonly signal?: AbortSignal;
  readonly limits?: LangSmithExportLimits;
  readonly now?: () => number;
  readonly onDiagnostic?: (value: TraceRequestDiagnostic) => void;
}

/** Audit completely before sending; never forward the SDK's original upload body. */
export function createAuditedLangSmithFetch(
  fetcher: typeof globalThis.fetch,
  config: LangSmithEventConfig,
  sensitiveValues: readonly string[],
  onReject: (machineCode: 'TRACE_LOCAL_AUDIT_REJECTED') => void,
  options: AuditedLangSmithFetchOptions = {},
): typeof globalThis.fetch {
  if (!config.enabled) return fetcher;
  const endpoint = readEndpoint(config.endpoint);
  const limits = resolveLangSmithExportLimits(options.limits);
  const now = options.now ?? (() => performance.now());
  const reject = (): Response => {
    onReject(REJECTION_CODE);
    return Response.json({ error: REJECTION_CODE }, {
      status: 400,
      headers: { 'x-agentops-trace-error': REJECTION_CODE },
    });
  };

  return async (input, init) => {
    const startedAt = now();
    let route: TraceRequestDiagnostic['route'] | undefined;
    let phase: TraceRequestDiagnostic['phase'] = 'audit';
    let httpStatus: number | undefined;
    let recorded = false;
    const record = (outcome: TraceRequestDiagnostic['outcome']): void => {
      if (recorded || route === undefined) return;
      recorded = true;
      const duration = now() - startedAt;
      options.onDiagnostic?.({ route, phase, outcome,
        elapsedMs: Number.isFinite(duration) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(duration))) : 0,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });
    };
    let request: Request;
    try {
      // Consume the request as fetch would. Cloning would tee an unbounded input stream.
      request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      route = pathname.endsWith('/info') ? 'info' : pathname.endsWith('/runs/batch') ? 'batch'
        : pathname.endsWith('/runs/multipart') ? 'multipart' : undefined;
    } catch {
      return reject();
    }
    const timeoutController = new AbortController();
    const signal = AbortSignal.any([request.signal, timeoutController.signal, ...(options.signal === undefined ? [] : [options.signal])]);
    const timeout = setTimeout(() => timeoutController.abort(
      new DOMException('Trace export timed out', 'TimeoutError'),
    ), limits.requestTimeoutMs);

    try {
      let forwarded: Request;
      try {
        checkAbort(signal);
        if (endpoint === null) throw new Error(REJECTION_CODE);
        const url = new URL(request.url);
        if (url.protocol !== 'https:' || url.origin !== endpoint.origin || url.username !== ''
          || url.password !== '' || url.search !== '' || url.hash !== '') throw new Error(REJECTION_CODE);
        const prefix = endpoint.pathname.replace(/\/+$/u, '');
        const isInfo = url.pathname === `${prefix}/info` && request.method === 'GET';
        const isBatch = url.pathname === `${prefix}/runs/batch` && request.method === 'POST';
        const isMultipart = url.pathname === `${prefix}/runs/multipart` && request.method === 'POST';
        if (!isInfo && !isBatch && !isMultipart) throw new Error(REJECTION_CODE);

        const encoding = (request.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
        if (encoding !== 'identity' && encoding !== 'gzip') throw new Error(REJECTION_CODE);
        if (isInfo && (request.body !== null || encoding !== 'identity')) throw new Error(REJECTION_CODE);
        // Authentication is configured locally. Do not forward cookies, caller headers or stale lengths.
        const headers = new Headers({ accept: 'application/json', 'x-api-key': config.apiKey.trim() });
        let body: BodyInit | undefined;
        if (!isInfo) {
          const wire = await readBoundedBytes(request.body, signal);
          const decoded = encoding === 'gzip' ? gunzipSync(wire, { maxOutputLength: MAX_BODY_BYTES }) : wire;
          const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
          const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
          let batch: Batch;
          if (isBatch && mediaType === 'application/json') {
            const parsed: unknown = JSON.parse(text) as unknown;
            if (!isRecord(parsed)) throw new Error(REJECTION_CODE);
            batch = parsed;
          } else if (isMultipart && mediaType === 'multipart/form-data') {
            // The Web parser handles boundaries, quoted parameters, CRLF and malformed forms.
            const data = await withAbort(new Response(text, {
              headers: { 'content-type': request.headers.get('content-type') ?? '' },
            }).formData(), signal);
            batch = reassembleMultipart(data);
          } else {
            throw new Error(REJECTION_CODE);
          }
          stripSdkRuntime(batch);
          const json = JSON.stringify(batch);
          if (!isSafeLangSmithExportBody(json, sensitiveValues)) throw new Error(REJECTION_CODE);
          if (isMultipart) {
            const encoded = rebuildMultipart(batch);
            headers.set('content-type', encoded.contentType);
            body = encoded.body;
          } else {
            headers.set('content-type', 'application/json');
            body = json;
          }
        }
        checkAbort(signal);
        forwarded = new Request(request.url, {
          method: request.method, headers, signal, redirect: 'error',
          credentials: 'omit', referrerPolicy: 'no-referrer',
          ...(body === undefined ? {} : { body }),
        });
      } catch {
        checkAbort(signal);
        record('local_reject');
        return reject();
      }

      // Keep network failures and caller cancellation distinct from local payload rejections.
      phase = 'send';
      const pending = fetcher(forwarded);
      phase = 'headers';
      const response = await withAbort(pending, signal);
      httpStatus = response.status;
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        if (response.body !== null) void response.body.cancel().catch(() => {});
        record('local_reject');
        return reject();
      }
      if (!response.ok) {
        record('http_error');
        if (response.body !== null) void response.body.cancel().catch(() => {});
        return Response.json({ error: `TRACE_HTTP_${response.status}` }, { status: response.status });
      }
      // Fetch resolves at headers. Keep both this deadline and bootstrap's
      // cancellation attached until the SDK's eventual body read is safe.
      phase = 'body';
      let bytes = await readBoundedBytes(response.body, signal);
      if (route === 'info') bytes = sanitizeLangSmithInfo(bytes);
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      phase = 'complete';
      record('ok');
      return new Response(response.body === null ? null : bytes, {
        status: response.status, statusText: response.statusText, headers: responseHeaders,
      });
    } catch (error) {
      record(signal.aborted ? (signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'timeout' : 'aborted') : 'network_error');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

function readEndpoint(value: string): URL | null {
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === 'https:' && endpoint.username === '' && endpoint.password === ''
      && endpoint.search === '' && endpoint.hash === '' ? endpoint : null;
  } catch {
    return null;
  }
}

function reassembleMultipart(data: FormData): Batch {
  const records = new Map<string, MultipartRecord>();
  const names = new Set<string>();
  data.forEach((value, name) => {
    const match = PART_NAME.exec(name);
    const operation = match?.[1];
    const id = match?.[2];
    const field = match?.[3];
    if (typeof value !== 'string' || (operation !== 'post' && operation !== 'patch') || id === undefined
      || names.has(name) || names.size >= 7_168) throw new Error(REJECTION_CODE);
    names.add(name);
    const key = `${operation}.${id}`;
    let record = records.get(key);
    if (record === undefined) {
      record = { operation, id, fields: new Map() };
      records.set(key, record);
    }
    const parsed: unknown = JSON.parse(value) as unknown;
    if (field === undefined) {
      if (!isRecord(parsed) || parsed['id'] !== id) throw new Error(REJECTION_CODE);
      record.main = parsed;
    } else {
      record.fields.set(field, parsed);
    }
  });
  const batch: { post: Record<string, unknown>[]; patch: Record<string, unknown>[] } = { post: [], patch: [] };
  for (const record of records.values()) {
    if (record.main === undefined) throw new Error(REJECTION_CODE);
    const run = { ...record.main };
    for (const [field, value] of record.fields) {
      if (Object.hasOwn(run, field)) throw new Error(REJECTION_CODE);
      run[field] = value;
    }
    batch[record.operation].push(run);
  }
  return batch;
}

function stripSdkRuntime(batch: Batch): void {
  for (const operation of ['post', 'patch', 'pre']) {
    const runs = batch[operation];
    if (!Array.isArray(runs)) continue;
    for (const run of runs as unknown[]) {
      if (isRecord(run) && isRecord(run['extra'])) delete run['extra']['runtime'];
    }
  }
}

function rebuildMultipart(batch: Batch): { contentType: string; body: Uint8Array<ArrayBuffer> } {
  const parts: { name: string; text: string; bytes: Buffer }[] = [];
  for (const operation of ['post', 'patch']) {
    const runs = batch[operation];
    if (!Array.isArray(runs)) throw new Error(REJECTION_CODE);
    for (const run of runs as unknown[]) {
      if (!isRecord(run) || typeof run['id'] !== 'string') throw new Error(REJECTION_CODE);
      const key = `${operation}.${run['id']}`;
      const main = Object.fromEntries(Object.entries(run).filter(([field]) => !SPLIT_FIELDS.has(field)));
      appendPart(parts, key, main);
      for (const field of SPLIT_FIELDS) {
        if (Object.hasOwn(run, field)) appendPart(parts, `${key}.${field}`, run[field]);
      }
    }
  }
  let boundary = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `agentops-${randomBytes(18).toString('hex')}`;
    if (parts.every((part) => !part.text.includes(candidate))) {
      boundary = candidate;
      break;
    }
  }
  if (boundary === '') throw new Error(REJECTION_CODE);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\nContent-Type: application/json\r\nContent-Length: ${part.bytes.byteLength}\r\n\r\n`, 'utf8'));
    chunks.push(part.bytes, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const encoded = Buffer.concat(chunks);
  if (encoded.byteLength > MAX_BODY_BYTES) throw new Error(REJECTION_CODE);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: encoded };
}

function appendPart(parts: { name: string; text: string; bytes: Buffer }[], name: string, value: unknown): void {
  if (!PART_NAME.test(name)) throw new Error(REJECTION_CODE);
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error(REJECTION_CODE);
  const bytes = Buffer.from(text, 'utf8');
  parts.push({ name, text, bytes });
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
