import { ACCEPTANCE_LANGSMITH_EXPORT_LIMITS } from '../observability/langsmith-export-policy.js';
import { LangSmithTerminalTransportError, readLangSmithBytes, withLangSmithAbort } from '../observability/langsmith-http.js';

export const LANGSMITH_RUN_READBACK_FIELDS = [
  'id', 'trace_id', 'parent_run_id', 'name', 'run_type', 'end_time', 'status', 'error', 'inputs', 'outputs', 'extra',
] as const;
const SELECTED_RUN_FIELDS = new Set<string>(LANGSMITH_RUN_READBACK_FIELDS);
const MAX_RUNS_PER_QUERY_PAGE = 256;

/** Single-route, three-request transport; SDK retries must not add hidden sends. */
export function createLangSmithQueryFetch(fetcher: typeof fetch, endpoint: string,
  options: { readonly signal?: AbortSignal; readonly onRequest?: () => void;
    readonly onUnselectedFieldCount?: (count: number) => void } = {}): typeof fetch {
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
      const projected = projectLangSmithQueryResponse(bytes);
      try { options.onUnselectedFieldCount?.(projected.unselectedFieldCount); } catch { /* Diagnostics cannot block readback. */ }
      return Response.json(projected.body);
    } catch {
      throw new LangSmithTerminalTransportError('TRACE_QUERY_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  };
}

function projectLangSmithQueryResponse(bytes: Uint8Array): {
  readonly body: { readonly runs: readonly Record<string, unknown>[]; readonly cursors?: unknown };
  readonly unselectedFieldCount: number;
} {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!isRecord(parsed) || !Array.isArray(parsed['runs']) || parsed['runs'].length > MAX_RUNS_PER_QUERY_PAGE) {
    throw new Error('invalid query response');
  }
  let unselectedFieldCount = 0;
  const runs = parsed['runs'].map((candidate) => {
    if (!isRecord(candidate)) throw new Error('invalid query run');
    const selected: Record<string, unknown> = {};
    for (const key of LANGSMITH_RUN_READBACK_FIELDS) {
      if (Object.hasOwn(candidate, key)) selected[key] = candidate[key];
    }
    unselectedFieldCount += Object.keys(candidate).filter((key) => !SELECTED_RUN_FIELDS.has(key)).length;
    return selected;
  });
  return {
    body: { runs, ...(Object.hasOwn(parsed, 'cursors') ? { cursors: parsed['cursors'] } : {}) },
    unselectedFieldCount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
