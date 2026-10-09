import { Client } from 'langsmith';
import { randomUUID } from 'node:crypto';
import { createLangSmithEventObservability, type LangSmithEventConfig, type TraceLink } from '../bootstrap/langsmith.js';
import { ACCEPTANCE_LANGSMITH_EXPORT_LIMITS } from '../observability/langsmith-export-policy.js';
import { withLangSmithAbort } from '../observability/langsmith-http.js';
import type { ExportDiagnostics } from '../observability/export-diagnostics.js';
import { AcceptanceDiagnosticsRecorder, type AcceptanceDiagnostics } from './diagnostics.js';
import { createAuditedLangSmithFetch } from './langsmith-export-transport.js';
import {
  inspectLangSmithRunPayloadDetails,
  type LangSmithRunPayloadInspection,
  type LangSmithRunPayloadSafetyIssue,
  type LangSmithRunTopLevelShape,
} from './langsmith-verifier.js';
import { containsSensitivePublicContent } from './privacy-audit.js';
import { createLangSmithQueryFetch, LANGSMITH_RUN_READBACK_FIELDS } from './langsmith-query-transport.js';

export type TraceProbeErrorCode = 'TRACE_PROBE_CONFIG_INVALID' | 'TRACE_PROBE_UPLOAD_FAILED'
  | 'TRACE_PROBE_QUERY_UNAVAILABLE' | 'TRACE_PROBE_MISMATCH' | 'TRACE_PROBE_DEADLINE';
export type TraceProbeMismatchReason = LangSmithRunPayloadSafetyIssue | 'remote_run_identity_mismatch' | 'remote_run_missing'
  | 'trace_id_mismatch' | 'parent_run_mismatch' | 'end_time_invalid' | 'run_error_present' | 'run_name_mismatch'
  | 'run_type_mismatch' | 'output_status_mismatch' | 'run_status_mismatch' | 'usage_metadata_missing'
  | 'input_tokens_mismatch' | 'output_tokens_mismatch' | 'total_tokens_mismatch' | 'cached_input_tokens_mismatch';
export type TraceProbeMismatchSpan = 'root' | 'model';
interface TraceProbeMismatch {
  readonly reason: TraceProbeMismatchReason;
  readonly span?: TraceProbeMismatchSpan;
  readonly shape?: LangSmithRunTopLevelShape;
  readonly unexpectedTopLevelFieldCount?: number;
}
export interface TraceProbeResult {
  readonly status: 'verified' | 'failed';
  readonly code?: TraceProbeErrorCode;
  /** Fixed safe category and optional synthetic span category; never remote values or payloads. */
  readonly mismatchReason?: TraceProbeMismatchReason;
  readonly mismatchSpan?: TraceProbeMismatchSpan;
  readonly mismatchShape?: LangSmithRunTopLevelShape;
  readonly unexpectedTopLevelFieldCount?: number;
  readonly discardedTopLevelFieldCount?: number;
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

const EMPTY_EXPORT: ExportDiagnostics = { pending: 0, dropped: 0, counts: {} };

/** No Lab, MCP or ChatModel dependency: two synthetic spans admit the next layer. */
export async function runLangSmithTraceProbe(
  options: { readonly authorization: 'explicit-probe' | 'none'; readonly config: LangSmithEventConfig },
  dependencies: TraceProbeDependencies = {},
): Promise<TraceProbeResult> {
  const recorder = new AcceptanceDiagnosticsRecorder();
  let remoteQueriesSent = 0;
  let checkedSpanCount = 0;
  let discardedTopLevelFieldCount = 0;
  let exporter: ReturnType<typeof createLangSmithEventObservability> | undefined;
  const result = (code?: TraceProbeErrorCode, mismatch?: TraceProbeMismatch): TraceProbeResult => ({
    status: code === undefined ? 'verified' : 'failed',
    ...(code === undefined ? {} : { code }),
    ...(mismatch === undefined ? {} : { mismatchReason: mismatch.reason,
      ...(mismatch.span === undefined ? {} : { mismatchSpan: mismatch.span }),
      ...(mismatch.shape === undefined ? {} : { mismatchShape: mismatch.shape }),
      ...(mismatch.unexpectedTopLevelFieldCount === undefined ? {} : {
        unexpectedTopLevelFieldCount: mismatch.unexpectedTopLevelFieldCount,
      }) }),
    checkedSpanCount, remoteQueriesSent,
    ...(discardedTopLevelFieldCount === 0 ? {} : { discardedTopLevelFieldCount }),
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
        onUnselectedFieldCount: (count) => { discardedTopLevelFieldCount += count; },
      }),
    });
    for (let query = 0; query < 3; query += 1) {
      const runs: Record<string, unknown>[] = [];
      const read = async (): Promise<void> => {
        for await (const run of queryClient.listRuns({ id: ids, limit: 2, select: [...LANGSMITH_RUN_READBACK_FIELDS] })) {
          if (runs.length >= 2) throw new Error('TRACE_PROBE_MISMATCH');
          runs.push(run as unknown as Record<string, unknown>);
        }
      };
      await withLangSmithAbort(read(), controller.signal);
      checkedSpanCount = runs.length;
      if (runs.some((run) => typeof run['id'] !== 'string' || !ids.includes(run['id']))
        || new Set(runs.map((run) => run['id'])).size !== runs.length) {
        return result('TRACE_PROBE_MISMATCH', { reason: 'remote_run_identity_mismatch' });
      }
      if (runs.length === 2) {
        const mismatch = findRemoteMismatch(runs, links);
        return mismatch === undefined ? result() : result('TRACE_PROBE_MISMATCH', mismatch);
      }
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

function findRemoteMismatch(
  runs: readonly Record<string, unknown>[],
  links: readonly TraceLink[],
): TraceProbeMismatch | undefined {
  for (const link of links) {
    const run = runs.find((candidate) => candidate['id'] === link.remoteRunId);
    if (run === undefined) return mismatchFor(link, 'remote_run_missing');
    const payloadInspection = inspectLangSmithRunPayloadDetails(run);
    if (payloadInspection !== undefined) return payloadMismatchFor(link, payloadInspection);
    if (run['id'] !== link.remoteRunId) return mismatchFor(link, 'remote_run_identity_mismatch');
    if (run['trace_id'] !== link.traceId) return mismatchFor(link, 'trace_id_mismatch');
    if ((run['parent_run_id'] ?? undefined) !== link.parentRemoteRunId) return mismatchFor(link, 'parent_run_mismatch');
    if (!validEnd(run['end_time'])) return mismatchFor(link, 'end_time_invalid');
    if (run['error'] !== undefined && run['error'] !== null && run['error'] !== '') return mismatchFor(link, 'run_error_present');
    const isModel = link.spanKey === 'trace-probe-model';
    if (run['name'] !== (isModel ? 'model.trace-probe' : 'agent.run')) return mismatchFor(link, 'run_name_mismatch');
    if (run['run_type'] !== (isModel ? 'llm' : 'chain')) return mismatchFor(link, 'run_type_mismatch');
    const outputs = record(run['outputs']);
    if (outputs?.['status'] !== 'completed') return mismatchFor(link, 'output_status_mismatch');
    if (run['status'] !== undefined && run['status'] !== 'success' && run['status'] !== 'completed') return mismatchFor(link, 'run_status_mismatch');
    if (!isModel) continue;
    const usage = record(outputs['usage_metadata']);
    if (usage === undefined) return mismatchFor(link, 'usage_metadata_missing');
    if (usage['input_tokens'] !== 12) return mismatchFor(link, 'input_tokens_mismatch');
    if (usage['output_tokens'] !== 5) return mismatchFor(link, 'output_tokens_mismatch');
    if (usage['total_tokens'] !== 17) return mismatchFor(link, 'total_tokens_mismatch');
    if (record(usage['input_token_details'])?.['cache_read'] !== 4) return mismatchFor(link, 'cached_input_tokens_mismatch');
  }
  return undefined;
}

function mismatchFor(link: TraceLink, reason: TraceProbeMismatchReason): TraceProbeMismatch {
  return { reason, span: link.spanKey === 'trace-probe-model' ? 'model' : 'root' };
}

function payloadMismatchFor(link: TraceLink, inspection: LangSmithRunPayloadInspection): TraceProbeMismatch {
  return {
    ...mismatchFor(link, inspection.issue),
    ...(inspection.topLevelShape === undefined ? {} : { shape: inspection.topLevelShape }),
    ...(inspection.unexpectedTopLevelFieldCount === undefined ? {} : {
      unexpectedTopLevelFieldCount: inspection.unexpectedTopLevelFieldCount,
    }),
  };
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
