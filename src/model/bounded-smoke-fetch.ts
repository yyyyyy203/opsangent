import { SmokeRequestBudget } from './smoke-request-budget.js';

export { SmokeRequestBudget } from './smoke-request-budget.js';
export type { SmokeBudgetSnapshot } from './smoke-request-budget.js';

export interface BoundedSmokeFetchOptions {
  fetch: typeof globalThis.fetch;
  limit: number;
  maxOutputTokens: number;
  onAttempt: (count: number) => void;
  budget?: SmokeRequestBudget;
}

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const SAFE_ERROR = 'Smoke model request was rejected.';

export function createBoundedSmokeFetch(options: BoundedSmokeFetchOptions): typeof globalThis.fetch {
  if (options === null || typeof options !== 'object'
    || typeof options.fetch !== 'function' || typeof options.onAttempt !== 'function'
    || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 10
    || !Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > 512
    || (options.budget !== undefined && options.budget.limit !== options.limit)) {
    throw new RangeError('Invalid bounded smoke fetch options.');
  }

  const budget = options.budget ?? new SmokeRequestBudget(options.limit);
  return async (input, init) => {
    const reserved = budget.reserve();
    try {
      options.onAttempt(budget.snapshot().attempted);
    } catch {
      if (reserved) budget.rejectReserved();
      throw new Error(SAFE_ERROR);
    }
    if (!reserved) return new Response(null, { status: 402 });
    if (!isChatCompletion(input, init)) {
      budget.rejectReserved();
      return new Response(null, { status: 402 });
    }

    let forwardedInput: RequestInfo | URL;
    let forwardedInit: RequestInit | undefined;
    try {
      const body = await readBoundedBody(input, init);
      const parsed: unknown = JSON.parse(body, (_key: string, value: unknown): unknown => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(SAFE_ERROR);
        return value;
      });
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(SAFE_ERROR);
      const fields = parsed as Record<string, unknown>;
      const rest = { ...fields };
      delete rest.max_completion_tokens;
      const rewrittenBody = JSON.stringify({ ...rest, max_tokens: options.maxOutputTokens });
      if (input instanceof Request) {
        forwardedInput = new Request(input, { ...init, body: rewrittenBody });
      } else {
        forwardedInput = input;
        forwardedInit = { ...init, body: rewrittenBody };
      }
    } catch {
      budget.rejectReserved();
      throw new Error(SAFE_ERROR);
    }

    budget.markSent();
    try {
      return await options.fetch(forwardedInput, forwardedInit);
    } catch (error) {
      if (error instanceof TypeError) throw new TypeError(SAFE_ERROR);
      if (error instanceof Error && error.name === 'AbortError') throw new DOMException(SAFE_ERROR, 'AbortError');
      if (error instanceof Error && error.name === 'TimeoutError') {
        const timeout = new Error(SAFE_ERROR);
        timeout.name = 'TimeoutError';
        throw timeout;
      }
      throw new Error(SAFE_ERROR);
    }
  };
}

function isChatCompletion(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  const urlValue = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  try {
    return method === 'POST' && new URL(urlValue).pathname.endsWith('/chat/completions');
  } catch {
    return false;
  }
}

async function readBoundedBody(input: RequestInfo | URL, init: RequestInit | undefined): Promise<string> {
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body !== 'string' || init.body.length > MAX_REQUEST_BODY_BYTES
      || new TextEncoder().encode(init.body).byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new Error(SAFE_ERROR);
    }
    return init.body;
  }
  if (init?.body === null || !(input instanceof Request)) throw new Error(SAFE_ERROR);
  const copy = input.clone();
  if (copy.body === null) throw new Error(SAFE_ERROR);
  const reader = copy.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return body + decoder.decode();
      bytes += item.value.byteLength;
      if (bytes > MAX_REQUEST_BODY_BYTES) throw new Error(SAFE_ERROR);
      body += decoder.decode(item.value, { stream: true });
    }
  } finally {
    // A cloned Request tees its body. Cancellation may wait for the caller-owned
    // branch forever, so cleanup must not delay the bounded rejection.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
