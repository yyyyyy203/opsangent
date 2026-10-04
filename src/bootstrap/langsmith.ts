import { Client } from 'langsmith';
import { NoopObservability } from '../observability/noop-observability.js';
import {
  ExportDiagnosticsRecorder,
  type ExportDiagnostics,
} from '../observability/export-diagnostics.js';
import { LangSmithObservability } from '../observability/langsmith-observability.js';
import type { Observability } from '../contracts/index.js';

const DEFAULT_ENDPOINT = 'https://api.smith.langchain.com';
const REQUEST_TIMEOUT_MS = 1_000;
const FLUSH_TIMEOUT_MS = 2_000;
const MAX_PENDING = 256;
const MAX_TRACE_LINKS = 256;
const MAX_INGEST_MEMORY_BYTES = 1_048_576;
const MAX_BATCH_BYTES = 65_536;
const MAX_BATCH_OPERATIONS = 32;

export type LangSmithEventConfig = { readonly enabled: false } | {
  readonly enabled: true;
  readonly apiKey: string;
  readonly projectName: string;
  readonly endpoint: string;
};

export interface TraceLink {
  readonly spanKey: string;
  readonly agentRunId: string;
  readonly remoteRunId: string;
  readonly traceId: string;
  readonly parentRemoteRunId?: string;
}

export interface LangSmithEventExporter {
  readonly eventObservability: Observability;
  getDiagnostics(): ExportDiagnostics;
  getTraceLinks(): readonly TraceLink[];
}

export interface LangSmithEventDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export function readLangSmithEventConfig(
  env: Readonly<Record<string, string | undefined>>,
): LangSmithEventConfig {
  const enabledValue = env.LANGSMITH_TRACING?.trim().toLowerCase();
  if (enabledValue === undefined || enabledValue === 'false' || enabledValue === '0') {
    return { enabled: false };
  }
  if (enabledValue !== 'true' && enabledValue !== '1') throw invalidConfig();

  const apiKey = env.LANGSMITH_API_KEY?.trim();
  const projectName = env.LANGSMITH_PROJECT?.trim();
  const rawEndpoint = env.LANGSMITH_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
  if (apiKey === undefined || apiKey.length === 0 || apiKey.length > 4_096
    || projectName === undefined || projectName.length === 0 || projectName.length > 128
    || hasControlChars(projectName)) {
    throw invalidConfig();
  }

  try {
    const endpoint = new URL(rawEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== ''
      || endpoint.search !== '' || endpoint.hash !== '') throw invalidConfig();
    return {
      enabled: true,
      apiKey,
      projectName,
      endpoint: endpoint.toString().replace(/\/$/u, ''),
    };
  } catch {
    throw invalidConfig();
  }
}

export function createLangSmithEventObservability(
  config: LangSmithEventConfig,
  dependencies: LangSmithEventDependencies = {},
): LangSmithEventExporter {
  const diagnostics = new ExportDiagnosticsRecorder();
  const traceLinks = new Map<string, TraceLink>();
  if (!config.enabled) {
    return {
      eventObservability: new NoopObservability(),
      getDiagnostics: () => diagnostics.snapshot(),
      getTraceLinks: () => [],
    };
  }

  const endpoint = validateDirectConfig(config);
  const exporterAbort = new AbortController();
  const timedFetch = createTimedFetch(
    dependencies.fetch ?? globalThis.fetch,
    exporterAbort.signal,
    diagnostics,
  );
  const client = new Client({
    apiUrl: endpoint,
    apiKey: config.apiKey.trim(),
    timeout_ms: REQUEST_TIMEOUT_MS,
    callerOptions: { maxRetries: 0 },
    autoBatchTracing: true,
    blockOnRootRunFinalization: false,
    maxIngestMemoryBytes: MAX_INGEST_MEMORY_BYTES,
    batchSizeBytesLimit: MAX_BATCH_BYTES,
    batchSizeLimit: MAX_BATCH_OPERATIONS,
    traceBatchConcurrency: 1,
    omitTracedRuntimeInfo: true,
    debug: false,
    fetchImplementation: timedFetch,
  });
  const observer = new LangSmithObservability({
    projectName: config.projectName,
    client,
    enabled: true,
    diagnostics,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    maxPending: MAX_PENDING,
    onTraceLink: (link) => {
      if (traceLinks.size >= MAX_TRACE_LINKS && !traceLinks.has(link.spanKey)) {
        const oldest = traceLinks.keys().next().value;
        if (oldest !== undefined) traceLinks.delete(oldest);
      }
      traceLinks.set(link.spanKey, link);
    },
    flushDeadlineMs: FLUSH_TIMEOUT_MS,
    abortController: exporterAbort,
  });

  return {
    eventObservability: observer,
    getDiagnostics: () => diagnostics.snapshot(),
    getTraceLinks: () => [...traceLinks.values()].map((link) => ({ ...link })),
  };
}

function validateDirectConfig(config: Extract<LangSmithEventConfig, { enabled: true }>): string {
  if (config.apiKey.trim().length === 0 || config.apiKey.length > 4_096
    || config.projectName.trim().length === 0 || config.projectName.length > 128
    || hasControlChars(config.projectName)) throw invalidConfig();
  try {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== ''
      || endpoint.search !== '' || endpoint.hash !== '') throw invalidConfig();
    return endpoint.toString().replace(/\/$/u, '');
  } catch {
    throw invalidConfig();
  }
}

function invalidConfig(): Error {
  return new Error('LANGSMITH_CONFIG_INVALID');
}

function hasControlChars(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function createTimedFetch(
  fetchImplementation: typeof globalThis.fetch,
  exporterSignal: AbortSignal,
  diagnostics: ExportDiagnosticsRecorder,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (exporterSignal.aborted) throw new Error('TRACE_EXPORT_ABORTED');
    const requestController = new AbortController();
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let requestTimedOut = false;
    let exportAborted = false;
    let callerTimedOut = false;

    const abortFromExporter = (): void => {
      exportAborted = true;
      requestController.abort();
    };
    const abortFromRequest = (): void => {
      callerTimedOut = requestSignal?.reason instanceof Error
        && requestSignal.reason.name === 'TimeoutError';
      requestController.abort();
    };
    exporterSignal.addEventListener('abort', abortFromExporter, { once: true });
    requestSignal?.addEventListener('abort', abortFromRequest, { once: true });
    if (exporterSignal.aborted) abortFromExporter();
    if (requestSignal?.aborted) abortFromRequest();
    const timeout = setTimeout(() => {
      requestTimedOut = true;
      diagnostics.record('TRACE_REQUEST_TIMEOUT');
      requestController.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      diagnostics.beginRequest();
      const response = await fetchImplementation(input, { ...init, signal: requestController.signal });
      if (response.ok) return response;
      diagnostics.record('TRACE_NETWORK_ERROR');
      return new Response(JSON.stringify({ error: `TRACE_HTTP_${response.status}` }), {
        status: response.status,
        statusText: 'Trace export failed',
        headers: { 'content-type': 'application/json' },
      });
    } catch {
      if (callerTimedOut) diagnostics.record('TRACE_REQUEST_TIMEOUT');
      else if (!requestTimedOut && !exportAborted && !requestSignal?.aborted) {
        diagnostics.record('TRACE_NETWORK_ERROR');
      }
      throw new Error(requestTimedOut || callerTimedOut
        ? 'TRACE_REQUEST_TIMEOUT'
        : exportAborted || requestSignal?.aborted ? 'TRACE_EXPORT_ABORTED' : 'TRACE_NETWORK_ERROR');
    } finally {
      clearTimeout(timeout);
      diagnostics.endRequest();
      exporterSignal.removeEventListener('abort', abortFromExporter);
      requestSignal?.removeEventListener('abort', abortFromRequest);
    }
  };
}
