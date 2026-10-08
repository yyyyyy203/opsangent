import { Client } from 'langsmith';
import { randomUUID } from 'node:crypto';
import { createLangSmithEventObservability, type LangSmithEventConfig, type TraceLink } from '../bootstrap/langsmith.js';
import { ACCEPTANCE_LANGSMITH_EXPORT_LIMITS } from '../observability/langsmith-export-policy.js';
import { withLangSmithAbort } from '../observability/langsmith-http.js';
import type { ExportDiagnostics } from '../observability/export-diagnostics.js';
import { AcceptanceDiagnosticsRecorder, type AcceptanceDiagnostics } from './diagnostics.js';
import { createAuditedLangSmithFetch } from './langsmith-export-transport.js';
import { isSafeLangSmithRunPayload } from './langsmith-verifier.js';
import { containsSensitivePublicContent } from './privacy-audit.js';
import { createLangSmithQueryFetch } from './langsmith-query-transport.js';

export type TraceProbeErrorCode = 'TRACE_PROBE_CONFIG_INVALID' | 'TRACE_PROBE_UPLOAD_FAILED'
  | 'TRACE_PROBE_QUERY_UNAVAILABLE' | 'TRACE_PROBE_MISMATCH' | 'TRACE_PROBE_DEADLINE';
export interface TraceProbeResult {
  readonly status: 'verified' | 'failed';
  readonly code?: TraceProbeErrorCode;
  readonly checkedSpanCount: number;
  readonly remoteQueriesSent: number;
  readonly diagnostics: AcceptanceDiagnostics;
  readonly exportDiagnostics: ExportDiagnostics;
}
export interface TraceProbeDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const SELECT = ['id', 'trace_id', 'parent_run_id', 'name', 'run_type', 'end_time', 'status', 'error', 'inputs', 'outputs', 'extra'];
const EMPTY_EXPORT: ExportDiagnostics = { pending: 0, dropped: 0, counts: {} };

/** No Lab, MCP or ChatModel dependency: two synthetic spans admit the next layer. */
export async function runLangSmithTraceProbe(
  options: { readonly authorization: 'explicit-probe' | 'none'; readonly config: LangSmithEventConfig },
  dependencies: TraceProbeDependencies = {},
): Promise<TraceProbeResult> {
  const recorder = new AcceptanceDiagnosticsRecorder();
  let remoteQueriesSent = 0;
  let checkedSpanCount = 0;
  let exporter: ReturnType<typeof createLangSmithEventObservability> | undefined;
  const result = (code?: TraceProbeErrorCode): TraceProbeResult => ({ status: code === undefined ? 'verified' : 'failed',
    ...(code === undefined ? {} : { code }), checkedSpanCount, remoteQueriesSent,
    diagnostics: recorder.snapshot(), exportDiagnostics: exporter?.getDiagnostics() ?? EMPTY_EXPORT });
  if (options.authorization !== 'explicit-probe' || !options.config.enabled) return result('TRACE_PROBE_CONFIG_INVALID');

  const config = options.config;
  const controller = new AbortController();
  let deadlineExpired = false;
  let uploadFailed = false;
  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort(new DOMException('Trace probe deadline', 'TimeoutError'));
  }, 30000);
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => performance.now());
  try {
    const probeRunId = (dependencies.createId ?? randomUUID)();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(probeRunId)
      || containsSensitivePublicContent(probeRunId, [config.apiKey])) return result('TRACE_PROBE_CONFIG_INVALID');
    exporter = createLangSmithEventObservability(config, {
      limits: ACCEPTANCE_LANGSMITH_EXPORT_LIMITS,
      fetch: createAuditedLangSmithFetch(fetcher, config, [config.apiKey], () => { uploadFailed = true; }, {
        limits: ACCEPTANCE_LANGSMITH_EXPORT_LIMITS, signal: controller.signal, now,
        onDiagnostic: (value) => {
          recorder.recordTraceRequest(value);
          if (value.outcome !== 'ok') { uploadFailed = true; controller.abort(); }
        },
      }),
    });
    const root = exporter.eventObservability.startSpan({ name: 'agent.run', kind: 'chain', runId: probeRunId,
      spanKey: 'trace-probe-root', input: { profile: 'simulation' } });
    const child = exporter.eventObservability.startSpan({ name: 'model.trace-probe', kind: 'llm', runId: probeRunId,
      spanKey: 'trace-probe-model', parentSpanKey: 'trace-probe-root', input: { purpose: 'inspection' },
      attributes: { provider: 'test-provider', model: 'trace-probe' } });
    child.end({ status: 'completed', usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 4 } });
    root.end({ status: 'completed' });
    // Flush already has its own bounded deadline and owns its cleanup. Do not
    // race it away when an upload aborts, leaving its timer/SDK queue behind.
    await exporter.eventObservability.flush();
    if (uploadFailed || Object.values(exporter.getDiagnostics().counts).some((value) => value !== undefined && value > 0)
      || exporter.getDiagnostics().pending !== 0 || exporter.getDiagnostics().dropped !== 0) return result('TRACE_PROBE_UPLOAD_FAILED');
    const links = exporter.getTraceLinks();
    if (!validLinks(links, probeRunId)) return result('TRACE_PROBE_UPLOAD_FAILED');
    const ids = links.map((link) => link.remoteRunId).sort();
    const queryClient = new Client({ apiUrl: config.endpoint, apiKey: config.apiKey, timeout_ms: 10000,
      callerOptions: { maxRetries: 0 }, debug: false,
      fetchImplementation: createLangSmithQueryFetch(fetcher, config.endpoint, {
        signal: controller.signal, onRequest: () => { remoteQueriesSent += 1; },
      }),
    });
    for (let query = 0; query < 3; query += 1) {
      const runs: Record<string, unknown>[] = [];
      const read = async (): Promise<void> => {
        for await (const run of queryClient.listRuns({ id: ids, limit: 2, select: SELECT })) {
          if (runs.length >= 2) throw new Error('TRACE_PROBE_MISMATCH');
          runs.push(run as unknown as Record<string, unknown>);
        }
      };
      await withLangSmithAbort(read(), controller.signal);
      checkedSpanCount = runs.length;
      if (runs.some((run) => !ids.includes(String(run['id']))) || new Set(runs.map((run) => run['id'])).size !== runs.length) {
        return result('TRACE_PROBE_MISMATCH');
      }
      if (runs.length === 2) return result(matchesRemote(runs, links) ? undefined : 'TRACE_PROBE_MISMATCH');
      if (query < 2) await withLangSmithAbort(dependencies.sleep === undefined
        ? sleep(1000, controller.signal) : dependencies.sleep(1000), controller.signal);
    }
    return result('TRACE_PROBE_QUERY_UNAVAILABLE');
  } catch {
    return result(deadlineExpired ? 'TRACE_PROBE_DEADLINE' : uploadFailed || remoteQueriesSent === 0
      ? 'TRACE_PROBE_UPLOAD_FAILED' : 'TRACE_PROBE_QUERY_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function validLinks(links: readonly TraceLink[], runId: string): boolean {
  const root = links.find((link) => link.spanKey === 'trace-probe-root');
  const child = links.find((link) => link.spanKey === 'trace-probe-model');
  return links.length === 2 && root !== undefined && child !== undefined && root.remoteRunId !== child.remoteRunId
    && links.every((link) => link.agentRunId === runId) && root.parentRemoteRunId === undefined
    && child.parentRemoteRunId === root.remoteRunId && child.traceId === root.traceId;
}

function matchesRemote(runs: readonly Record<string, unknown>[], links: readonly TraceLink[]): boolean {
  return links.every((link) => {
    const run = runs.find((candidate) => candidate['id'] === link.remoteRunId);
    if (run === undefined || !isSafeLangSmithRunPayload(run) || run['trace_id'] !== link.traceId
      || (run['parent_run_id'] ?? undefined) !== link.parentRemoteRunId || !validEnd(run['end_time'])
      || (run['error'] !== undefined && run['error'] !== null && run['error'] !== '')) return false;
    const isModel = link.spanKey === 'trace-probe-model';
    if (run['name'] !== (isModel ? 'model.trace-probe' : 'agent.run') || run['run_type'] !== (isModel ? 'llm' : 'chain')) return false;
    const outputs = record(run['outputs']);
    if (outputs?.['status'] !== 'completed' || (run['status'] !== undefined && run['status'] !== 'success' && run['status'] !== 'completed')) return false;
    if (!isModel) return true;
    const usage = record(outputs['usage_metadata']);
    return usage?.['input_tokens'] === 12 && usage['output_tokens'] === 5 && usage['total_tokens'] === 17
      && record(usage['input_token_details'])?.['cache_read'] === 4;
  });
}

function validEnd(value: unknown): boolean {
  return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(new Error('TRACE_PROBE_DEADLINE')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
