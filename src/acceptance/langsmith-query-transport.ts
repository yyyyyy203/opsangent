import { ACCEPTANCE_LANGSMITH_EXPORT_LIMITS } from '../observability/langsmith-export-policy.js';
import { LangSmithTerminalTransportError, readLangSmithBytes, withLangSmithAbort } from '../observability/langsmith-http.js';

/** Single-route, three-request transport; SDK retries must not add hidden sends. */
export function createLangSmithQueryFetch(fetcher: typeof fetch, endpoint: string,
  options: { readonly signal?: AbortSignal; readonly onRequest?: () => void } = {}): typeof fetch {
  const allowed = `${endpoint.replace(/\/$/u, '')}/runs/query`;
  let sent = 0;
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Trace query deadline', 'TimeoutError')),
      ACCEPTANCE_LANGSMITH_EXPORT_LIMITS.requestTimeoutMs);
    try {
      const request = new Request(input, init);
      if (request.url !== allowed || request.method !== 'POST' || sent >= 3) throw new Error('invalid query');
      const signal = AbortSignal.any([request.signal, controller.signal, ...(options.signal === undefined ? [] : [options.signal])]);
      if (signal.aborted) throw new Error('cancelled');
      sent += 1;
      options.onRequest?.();
      const response = await withLangSmithAbort(fetcher(request, { signal, redirect: 'error' }), signal);
      if (!response.ok || response.redirected) {
        if (response.body !== null) void response.body.cancel().catch(() => {});
        throw new Error('query unavailable');
      }
      const bytes = await readLangSmithBytes(response.body, signal);
      return new Response(bytes, { headers: { 'content-type': 'application/json' } });
    } catch {
      throw new LangSmithTerminalTransportError('TRACE_QUERY_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  };
}
