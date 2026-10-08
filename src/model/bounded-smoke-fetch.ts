import { SmokeRequestBudget } from './smoke-request-budget.js';
import { SmokeOutputBudget } from './smoke-output-budget.js';
import type { SmokeOutputReservation } from './smoke-output-budget.js';
import { observeSmokeUsage } from './smoke-usage-observer.js';

export { SmokeRequestBudget } from './smoke-request-budget.js';
export type { SmokeBudgetSnapshot } from './smoke-request-budget.js';

export interface BoundedSmokeFetchOptions {
  fetch: typeof globalThis.fetch;
  limit: number;
  maxOutputTokens: number;
  onAttempt: (count: number) => void;
  budget?: SmokeRequestBudget;
  outputBudget?: SmokeOutputBudget;
  selectOutputTokens?: (body: Readonly<Record<string, unknown>>) => 512 | 1024;
}

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const SAFE_ERROR = 'Smoke model request was rejected.';

export function createBoundedSmokeFetch(options: BoundedSmokeFetchOptions): typeof globalThis.fetch {
  if (options === null || typeof options !== 'object'
    || typeof options.fetch !== 'function' || typeof options.onAttempt !== 'function'
    || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 10
    || !Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1
    || options.maxOutputTokens > (options.outputBudget === undefined ? 512 : 1024)
    || (options.outputBudget !== undefined && !(options.outputBudget instanceof SmokeOutputBudget))
    || (options.selectOutputTokens !== undefined && (typeof options.selectOutputTokens !== 'function' || options.outputBudget === undefined))
    || (options.budget !== undefined && options.budget.limit !== options.limit)) {
    throw new RangeError('Invalid bounded smoke fetch options.');
  }

  const budget = options.budget ?? new SmokeRequestBudget(options.limit);
  const outputBudget = options.outputBudget;
  const ceiling = options.maxOutputTokens;
  const selectOutputTokens = options.selectOutputTokens;
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
    let selectedCap = ceiling;
    let model: unknown;
    const signal = init?.signal === undefined
      ? input instanceof Request ? input.signal : undefined
      : init.signal ?? undefined;
    try {
      throwIfAborted(signal);
      const body = await readBoundedBody(input, init, signal);
      const parsed: unknown = JSON.parse(body, (_key: string, value: unknown): unknown => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(SAFE_ERROR);
        return value;
      });
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(SAFE_ERROR);
      const fields = parsed as Record<string, unknown>;
      if (outputBudget !== undefined && fields['n'] !== undefined && fields['n'] !== 1) throw new Error(SAFE_ERROR);
      if (selectOutputTokens !== undefined) {
        selectedCap = selectOutputTokens(structuredClone(fields));
        if ((selectedCap !== 512 && selectedCap !== 1024) || selectedCap > ceiling) throw new Error(SAFE_ERROR);
      }
      model = fields['model'];
      const rest = { ...fields };
      delete rest.max_completion_tokens;
      const rewrittenBody = JSON.stringify({ ...rest, max_tokens: selectedCap });
      if (input instanceof Request) {
        forwardedInput = new Request(input, { ...init, body: rewrittenBody });
      } else {
        forwardedInput = input;
        forwardedInit = { ...init, body: rewrittenBody };
      }
      throwIfAborted(signal);
    } catch (error) {
      budget.rejectReserved();
      throw safeFailure(error);
    }

    // No await between reservation and dispatch: concurrent callers cannot oversubscribe.
    const outputReservation: SmokeOutputReservation | undefined = outputBudget?.reserve(selectedCap);
    if (outputBudget !== undefined && outputReservation === undefined) {
      budget.rejectReserved();
      return new Response(null, { status: 402 });
    }
    budget.markSent();
    try {
      const pendingResponse = options.fetch(forwardedInput, forwardedInit);
      if (signal !== undefined) {
        // A custom transport may ignore AbortSignal and resolve after our abort race ended.
        void pendingResponse.then((response) => {
          if (signal.aborted && response.body !== null) void response.body.cancel().catch(() => undefined);
        }, () => undefined);
      }
      const response = await withAbort(pendingResponse, signal);
      return outputBudget === undefined || outputReservation === undefined ? response
        : observeSmokeUsage(response, model, selectedCap, signal, (outputTokens) => {
          outputBudget.settle(outputReservation, outputTokens);
        });
    } catch (error) {
      throw safeFailure(error);
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

async function readBoundedBody(input: RequestInfo | URL, init: RequestInit | undefined, signal: AbortSignal | undefined): Promise<string> {
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body !== 'string' || init.body.length > MAX_REQUEST_BODY_BYTES
      || new TextEncoder().encode(init.body).byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new Error(SAFE_ERROR);
    }
    return init.body;
  }
  if (init?.body === null || !(input instanceof Request)) throw new Error(SAFE_ERROR);
  if (input.body === null) throw new Error(SAFE_ERROR);
  const reader = input.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  let chunks = 0;
  let complete = false;
  try {
    while (true) {
      const item = await withAbort(reader.read(), signal);
      if (item.done) { complete = true; return body + decoder.decode(); }
      bytes += item.value.byteLength;
      if (bytes > MAX_REQUEST_BODY_BYTES || ++chunks > 65_536) throw new Error(SAFE_ERROR);
      body += decoder.decode(item.value, { stream: true });
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function safeFailure(error: unknown): Error {
  if (error instanceof TypeError) return new TypeError(SAFE_ERROR);
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return new DOMException(SAFE_ERROR, error.name);
  return new Error(SAFE_ERROR);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw safeFailure(signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
    ? signal.reason : new DOMException(SAFE_ERROR, 'AbortError'));
}

async function withAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending;
  let abort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException(SAFE_ERROR, signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const value = await Promise.race([pending, aborted]);
    throwIfAborted(signal);
    return value;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
