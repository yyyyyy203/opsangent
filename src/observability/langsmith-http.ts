/**
 * LangSmith's general caller currently overwrites callerOptions.maxRetries.
 * Its public transport boundary recognises ECONNABORTED as terminal. This
 * SDK-only carrier prevents retries without changing our diagnostic category.
 * Only fixed, sanitised codes may be passed here; never an upstream error.
 */
export class LangSmithTerminalTransportError extends Error {
  readonly code = 'ECONNABORTED';
  constructor(message: string) {
    super(message);
    this.name = 'LangSmithTerminalTransportError';
    // SDK logging must not expose the local absolute filename from Error.stack.
    this.stack = `${this.name}: ${message}`;
  }
}

/** Only SDK-consumed capability fields may cross the /info response boundary. */
export function sanitizeLangSmithInfo(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(value)) throw new Error('invalid info');
    const output: Record<string, Record<string, boolean | number>> = {};
    for (const section of ['batch_ingest_config', 'instance_flags'] as const) {
      const fields = value[section];
      if (fields === undefined) continue;
      if (!isRecord(fields)) throw new Error('invalid capability');
      const allowed = section === 'batch_ingest_config'
        ? ['use_multipart_endpoint', 'size_limit', 'size_limit_bytes']
        : ['gzip_body_enabled', 'dataset_examples_multipart_enabled'];
      const safe: Record<string, boolean | number> = {};
      for (const key of allowed) {
        const field = fields[key];
        if (field === undefined) continue;
        if (key === 'size_limit' || key === 'size_limit_bytes') {
          if (typeof field !== 'number' || !Number.isSafeInteger(field) || field <= 0) throw new Error('invalid limit');
        } else if (typeof field !== 'boolean') throw new Error('invalid flag');
        safe[key] = field;
      }
      output[section] = safe;
    }
    return new TextEncoder().encode(JSON.stringify(output));
  } catch {
    throw new LangSmithTerminalTransportError('TRACE_INFO_INVALID');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cancellation is consumed even when a custom fetch ignores its signal. */
export async function withLangSmithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(langSmithAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const value = await Promise.race([pending.then((value) => {
      if (signal.aborted && value instanceof Response && value.body !== null) void value.body.cancel().catch(() => {});
      return value;
    }), aborted]);
    if (signal.aborted) throw langSmithAbortError(signal);
    return value;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function langSmithAbortError(signal: AbortSignal): DOMException {
  return new DOMException('Trace export interrupted', signal.reason instanceof Error
    && signal.reason.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError');
}

/** Bounds both work and memory, including empty-chunk and stalled-body streams. */
export async function readLangSmithBytes(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const bytes = new Uint8Array(1_048_576);
  let length = 0;
  let chunkCount = 0;
  let complete = false;
  try {
    for (;;) {
      if (signal.aborted) throw langSmithAbortError(signal);
      const chunk = await withLangSmithAbort(reader.read(), signal);
      if (chunk.done) { complete = true; return bytes.slice(0, length); }
      if (length + chunk.value.byteLength > bytes.byteLength || ++chunkCount > 65_536) {
        throw new Error('TRACE_BODY_LIMIT');
      }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
