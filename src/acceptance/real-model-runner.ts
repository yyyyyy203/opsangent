import { Client } from 'langsmith';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { safeParseAgentMessageV2 } from '../contracts/message-v2/schema.js';
import { agentEventPayloadSchemas } from '../contracts/event-v2/catalog.js';
import { timestampV2Schema } from '../contracts/event-v2/common.js';
import type { JsonObject, JsonValue } from '../contracts/common.js';
import type { PublicEvidenceView } from '../contracts/read-model.js';
import type { SettlementMetricFact } from '../profiles/settlement.js';
import { startAgentWebRuntime } from '../bootstrap/agent-web-runtime.js';
import type { AgentWebRuntimeOptions } from '../bootstrap/agent-web-runtime.js';
import { startLogsLab } from '../bootstrap/logs-lab.js';
import { createLangSmithEventObservability } from '../bootstrap/langsmith.js';
import type { LangSmithEventConfig, TraceLink } from '../bootstrap/langsmith.js';
import { readAcceptanceSnapshot } from '../bootstrap/acceptance-reader.js';
import type { AcceptanceSnapshot } from './types.js';
import type { AcceptanceCheckCode, AcceptanceReport } from './types.js';
import { evaluateAcceptance } from './evaluator.js';
import { readSourceReports } from './source-reports.js';
import { createBoundedSmokeFetch } from '../model/bounded-smoke-fetch.js';
import { SmokeRequestBudget } from '../model/smoke-request-budget.js';
import { createOpenAICompatibleModel } from '../bootstrap/openai-compatible.js';
import type { CreateOpenAICompatibleModelOptions } from '../bootstrap/openai-compatible.js';
import type { ModelIdentity } from '../bootstrap/model-identity.js';
import type { ExportDiagnostics } from '../observability/export-diagnostics.js';
import { isSafeLangSmithRunPayload, verifyLangSmithTrace } from './langsmith-verifier.js';
import type { TraceVerification } from './types.js';
import { containsSensitivePublicContent, isForbiddenPublicFieldName } from './privacy-audit.js';

const SMOKE_REQUEST_LIMIT = 10;
const MAX_OUTPUT_TOKENS = 512;
const RUN_DEADLINE_MS = 90_000;
const MIN_SNAPSHOT_REMAINING_MS = 100_000;
const RUN_POLL_INTERVAL_MS = 500;
const HTTP_TIMEOUT_MS = 3_000;
const PUBLIC_SSE_TIMEOUT_MS = 5_000;
const PUBLIC_RESPONSE_MAX_BYTES = 512_000;
const PUBLIC_SSE_MAX_BYTES = 2_097_152;
const PUBLIC_PAGE_LIMIT = 3;
const LANGSMITH_BODY_MAX_BYTES = 1_048_576;
const REPORT_MAX_BYTES = 256_000;
const PUBLIC_EVENT_FIELDS = new Set([
  'schemaVersion', 'eventId', 'sequence', 'type', 'runId', 'sessionId', 'replyId', 'streamId', 'stepId',
  'correlationId', 'timestamp', 'durability', 'payload',
]);
const PUBLIC_EVIDENCE_FIELDS = new Set([
  'evidenceId', 'runId', 'source', 'state', 'capturedAt', 'summary', 'coverage', 'truncated', 'recordCount',
  'sourceBytes', 'storedBytes', 'chunkCount', 'timeRange', 'rawSha256', 'traceIdCount', 'retrievable',
]);
const PUBLIC_METRIC_SUMMARY_FIELDS = new Set([
  'status', 'total', 'failed', 'failureRate', 'threshold', 'minSamples', 'service', 'environment',
  'start', 'end', 'missingEvidence',
]);
const PUBLIC_LOG_SUMMARY_FIELDS = new Set([
  'recordCount', 'sourceBytes', 'storedBytes', 'coverage', 'truncated', 'missingEvidence', 'sourceSnapshotId',
]);
const PUBLIC_EVIDENCE_SOURCES: readonly PublicEvidenceView['source'][] = ['metric', 'log', 'trace', 'change'];
const PUBLIC_EVIDENCE_STATES: readonly PublicEvidenceView['state'][] = ['available', 'committed', 'partial'];
const PUBLIC_TERMINAL_EVENTS = new Set(['RUN_FINISHED', 'RUN_FAILED', 'RUN_CANCELLED']);
const LANGSMITH_BATCH_OPERATIONS = new Set(['post', 'patch', 'pre']);
const LANGSMITH_EXPORT_RUN_FIELDS = new Set([
  'id', 'name', 'run_type', 'trace_id', 'parent_run_id', 'inputs', 'outputs', 'extra', 'error',
  'start_time', 'end_time', 'tags', 'session_name', 'dotted_order', 'reference_example_id',
  'child_runs', 'attachments', 'events', 'serialized',
]);
const LANGSMITH_REMOTE_SELECTED_FIELDS = [
  'id', 'trace_id', 'parent_run_id', 'name', 'run_type', 'end_time', 'status', 'error', 'inputs', 'outputs', 'extra',
];
const LANGSMITH_SAFE_TAGS = new Set(['agentops', 'event-v2', 'inspection-smoke']);
const CHECK_CODES: readonly AcceptanceCheckCode[] = [
  'SOURCE_ALLOWLIST', 'SOURCE_CALL_LIMIT', 'METRIC_FACT_VALID', 'SOURCE_WINDOW_VALID',
  'MISSING_EVIDENCE_VISIBLE', 'EVIDENCE_OWNERSHIP', 'TERMINAL_COMPLETE', 'MODEL_HTTP_BUDGET',
  'USAGE_CONSISTENT', 'PUBLIC_DATA_SAFE', 'TRACE_EXPORT_SAFE',
];

export interface RealModelAcceptanceOptions {
  readonly authorization: 'explicit-smoke' | 'none';
  readonly dataDirectory: string;
  readonly workspaceRoot: string;
  readonly artifactDirectory: string;
  readonly modelConfig: CreateOpenAICompatibleModelOptions;
  readonly modelIdentity: ModelIdentity;
  readonly langSmithConfig: LangSmithEventConfig;
  readonly lab: {
    readonly elasticsearchUrl: string;
    readonly prometheusUrl: string;
    readonly labCursorSecret: string;
    readonly evidenceCursorSecret: string;
  };
  readonly codeRevision: string;
  readonly profileRevision: string;
}

export interface RealModelAcceptanceDependencies {
  readonly startLab?: typeof startLogsLab;
  readonly startWeb?: typeof startAgentWebRuntime;
  /** Model transport seam. It is always wrapped by the shared request budget. */
  readonly fetch?: typeof globalThis.fetch;
  /** Local-only HTTP seam for readiness and the Web host; never used for model calls. */
  readonly httpFetch?: typeof globalThis.fetch;
  /** LangSmith exporter seam; the request body is inspected before this fetch is called. */
  readonly langSmithFetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly readSnapshot?: typeof readAcceptanceSnapshot;
  readonly verifyTrace?: typeof verifyLangSmithTrace;
}

export type RealModelAcceptanceErrorCode =
  | 'SMOKE_NOT_AUTHORIZED'
  | 'PRECHECK_OPTIONS_INVALID'
  | 'PRECHECK_MODEL_CONFIG_INVALID'
  | 'PRECHECK_LAB_NOT_READY'
  | 'PRECHECK_SNAPSHOT_TOO_CLOSE'
  | 'PRECHECK_WEB_NOT_LOCAL'
  | 'RUN_START_REJECTED'
  | 'RUN_ID_INVALID'
  | 'RUN_TIMEOUT'
  | 'RUN_NOT_COMPLETE'
  | 'SNAPSHOT_INVALID'
  | 'ACCEPTANCE_REPORT_WRITE_FAILED';

export class RealModelAcceptanceError extends Error {
  public constructor(public readonly code: RealModelAcceptanceErrorCode) {
    super(code);
    this.name = 'RealModelAcceptanceError';
  }
}

/** Starts only the owned local Lab/Web resources and submits exactly one bounded parent Run. */
export async function runRealModelAcceptance(
  options: RealModelAcceptanceOptions,
  dependencies: RealModelAcceptanceDependencies = {},
): Promise<AcceptanceReport> {
  if (options.authorization !== 'explicit-smoke') throw new RealModelAcceptanceError('SMOKE_NOT_AUTHORIZED');
  validateOptions(options);
  try {
    await ensureRealDirectory(options.dataDirectory);
    await ensureRealDirectory(join(options.dataDirectory, 'acceptance'));
    await ensureRealDirectory(options.artifactDirectory);
  } catch {
    throw new RealModelAcceptanceError('PRECHECK_OPTIONS_INVALID');
  }

  const now = dependencies.now ?? Date.now;
  const httpFetch = dependencies.httpFetch ?? globalThis.fetch;
  const budget = new SmokeRequestBudget(SMOKE_REQUEST_LIMIT);
  let lab: Awaited<ReturnType<typeof startLogsLab>> | undefined;
  let web: Awaited<ReturnType<typeof startAgentWebRuntime>> | undefined;
  let runId: string | undefined;
  let tracing: ReturnType<typeof createLangSmithEventObservability> | undefined;
  let report: AcceptanceReport | undefined;
  let snapshotId = 'unavailable';
  let tracePayloadSafe = true;
  const sensitiveValues = [
    options.modelConfig.apiKey,
    options.lab.labCursorSecret,
    options.lab.evidenceCursorSecret,
    ...(options.langSmithConfig.enabled ? [options.langSmithConfig.apiKey] : []),
  ];

  try {
    lab = await (dependencies.startLab ?? startLogsLab)({
      elasticsearchUrl: options.lab.elasticsearchUrl,
      prometheusUrl: options.lab.prometheusUrl,
      cursorSecret: options.lab.labCursorSecret,
      initialScenario: 'settlement_failure',
    });
    snapshotId = lab.snapshotId;
    await verifyLabReady(lab, httpFetch, now());

    const boundedFetch = createBoundedSmokeFetch({
      budget,
      fetch: dependencies.fetch ?? globalThis.fetch,
      limit: SMOKE_REQUEST_LIMIT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      onAttempt: () => undefined,
    });
    const model = createOpenAICompatibleModel({ ...options.modelConfig, fetch: boundedFetch });
    tracing = createLangSmithEventObservability(options.langSmithConfig, {
      fetch: createLangSmithAuditedFetch(
        dependencies.langSmithFetch ?? globalThis.fetch,
        options.langSmithConfig,
        sensitiveValues,
        () => { tracePayloadSafe = false; },
      ),
    });
    const webOptions: AgentWebRuntimeOptions = {
      dataDirectory: options.dataDirectory,
      workspaceRoots: [options.workspaceRoot],
      model,
      modelIdentity: options.modelIdentity,
      sourceInvocationLimit: 1,
      metrics: { profileId: 'simulation', mcpUrl: lab.metricsMcpUrl },
      logs: {
        profileId: 'simulation',
        mcpUrl: lab.logsMcpUrl,
        cursorSecret: options.lab.evidenceCursorSecret,
      },
      eventObservability: tracing.eventObservability,
      host: '127.0.0.1',
      port: 0,
    };
    web = await (dependencies.startWeb ?? startAgentWebRuntime)(webOptions);
    assertLocalHttpUrl(web.url, 'PRECHECK_WEB_NOT_LOCAL');
    await verifyLabReady(lab, httpFetch, now());

    const startResponse = await fetchWithTimeout(httpFetch, `${web.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '请结合指标和日志巡检结算失败，证据不足时明确说明。',
        profileId: 'simulation',
        maxDurationMs: RUN_DEADLINE_MS,
        maxToolCalls: 12,
      }),
    });
    if (startResponse.status !== 202) throw new RealModelAcceptanceError('RUN_START_REJECTED');
    const started = await readObject(startResponse);
    runId = readRunId(started['runId']);
    if (runId === undefined) throw new RealModelAcceptanceError('RUN_ID_INVALID');

    const terminalStatus = await waitForTerminal(httpFetch, web.url, runId);
    await web.flushEventObservability();
    const traceLinks = tracing.getTraceLinks();
    const exportDiagnostics = tracing.getDiagnostics();
    if (terminalStatus !== 'completed') throw new RealModelAcceptanceError('RUN_NOT_COMPLETE');
    const snapshot = await (dependencies.readSnapshot ?? readAcceptanceSnapshot)({
      dataDirectory: options.dataDirectory,
      runId,
    });
    if (snapshot.parent.runId !== runId || snapshot.parent.childRunIds.length !== snapshot.children.length) {
      throw new RealModelAcceptanceError('SNAPSHOT_INVALID');
    }
    const publicBoundarySafe = await inspectPublicBoundaries(httpFetch, web.url, snapshot, sensitiveValues);
    await web.close();
    web = undefined;
    await lab.close();
    lab = undefined;

    const metricFact = readMetricFact(snapshot);
    const traceVerification = await verifyTraceLinks(options.langSmithConfig, traceLinks, snapshot, dependencies);
    report = evaluateAcceptance({
      ...snapshot,
      caseId: 'settlement_failure',
      codeRevision: options.codeRevision,
      profileRevision: options.profileRevision,
      snapshotId,
      reports: readSourceReports(snapshot.events),
      metricFact,
      budget: budget.snapshot(),
      exportDiagnostics,
      traceVerification,
      manualReview: { status: 'pending' },
      boundaryChecks: {
        publicDataSafe: isPublicSnapshotSafe(snapshot, sensitiveValues) && publicBoundarySafe,
        traceExportSafe: tracePayloadSafe && areTraceLinksSafe(traceLinks, exportDiagnostics, sensitiveValues),
      },
    });
    await writeAcceptanceReport(options, report);
    return report;
  } catch (error) {
    if (runId !== undefined && report === undefined) {
      const failure = createFailureReport(options, runId, snapshotId, budget.snapshot(), tracing?.getDiagnostics());
      await writeAcceptanceReport(options, failure).catch(() => undefined);
    }
    if (error instanceof RealModelAcceptanceError) throw error;
    throw new RealModelAcceptanceError('RUN_NOT_COMPLETE');
  } finally {
    await Promise.allSettled([web?.close() ?? Promise.resolve(), lab?.close() ?? Promise.resolve()]);
    if (report === undefined && tracing !== undefined) await tracing.eventObservability.flush().catch(() => undefined);
  }
}

function validateOptions(options: RealModelAcceptanceOptions): void {
  const paths = [options.dataDirectory, options.workspaceRoot, options.artifactDirectory];
  if (paths.some((path) => typeof path !== 'string' || path.trim() === '' || !isAbsolute(path) || path.includes('\0'))
    || !isValidRevision(options.codeRevision) || !isValidRevision(options.profileRevision)
    || !isSafeIdentifier(options.modelIdentity.provider) || !isSafeIdentifier(options.modelIdentity.model)
    || options.modelIdentity.model !== options.modelConfig.model
    || Buffer.byteLength(options.lab.labCursorSecret, 'utf8') < 32
    || Buffer.byteLength(options.lab.evidenceCursorSecret, 'utf8') < 32) {
    throw new RealModelAcceptanceError('PRECHECK_OPTIONS_INVALID');
  }
  try {
    const modelUrl = new URL(options.modelConfig.baseUrl);
    if (modelUrl.protocol !== 'https:' || modelUrl.username !== '' || modelUrl.password !== ''
      || modelUrl.search !== '' || modelUrl.hash !== ''
      || typeof options.modelConfig.apiKey !== 'string' || options.modelConfig.apiKey.trim() === ''
      || options.modelConfig.apiKey.length > 4_096 || !isSafeIdentifier(options.modelConfig.model)) {
      throw new Error('invalid model config');
    }
  } catch {
    throw new RealModelAcceptanceError('PRECHECK_MODEL_CONFIG_INVALID');
  }
  assertLoopbackBackend(options.lab.elasticsearchUrl, 19_200);
  assertLoopbackBackend(options.lab.prometheusUrl, 19_290);
  if (options.langSmithConfig.enabled) {
    try {
      const traceUrl = new URL(options.langSmithConfig.endpoint);
      if (traceUrl.protocol !== 'https:' || traceUrl.username !== '' || traceUrl.password !== ''
        || traceUrl.search !== '' || traceUrl.hash !== '' || options.langSmithConfig.apiKey.trim() === '') {
        throw new Error('invalid LangSmith config');
      }
    } catch {
      throw new RealModelAcceptanceError('PRECHECK_OPTIONS_INVALID');
    }
  }
}

function assertLoopbackBackend(value: string, port: number): void {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !isLoopback(url.hostname) || Number(url.port) !== port
      || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      throw new Error('invalid local backend');
    }
  } catch {
    throw new RealModelAcceptanceError('PRECHECK_OPTIONS_INVALID');
  }
}

async function verifyLabReady(
  lab: Awaited<ReturnType<typeof startLogsLab>>,
  fetcher: typeof globalThis.fetch,
  now: number,
): Promise<void> {
  const expiresAt = Date.parse(lab.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - now < MIN_SNAPSHOT_REMAINING_MS) {
    throw new RealModelAcceptanceError('PRECHECK_SNAPSHOT_TOO_CLOSE');
  }
  try {
    const response = await fetchWithTimeout(fetcher, lab.statusUrl, { method: 'GET' });
    if (!response.ok) throw new Error('not ready');
    const status = await readObject(response);
    if (status['readiness'] !== 'ready' || status['scenario'] !== 'settlement_failure'
      || status['snapshotId'] !== lab.snapshotId || status['expiresAt'] !== lab.expiresAt) {
      throw new Error('not ready');
    }
  } catch {
    throw new RealModelAcceptanceError('PRECHECK_LAB_NOT_READY');
  }
}

async function waitForTerminal(
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
  runId: string,
): Promise<string> {
  const deadline = Date.now() + RUN_DEADLINE_MS + 10_000;
  while (Date.now() < deadline) {
    const response = await fetchWithTimeout(fetcher, `${baseUrl}/runs/${encodeURIComponent(runId)}`, { method: 'GET' });
    if (!response.ok) throw new RealModelAcceptanceError('RUN_NOT_COMPLETE');
    const run = await readObject(response);
    if (run['runId'] !== runId || typeof run['status'] !== 'string') {
      throw new RealModelAcceptanceError('SNAPSHOT_INVALID');
    }
    if (['completed', 'failed', 'cancelled', 'paused', 'awaiting_confirmation'].includes(run['status'])) {
      return run['status'];
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, RUN_POLL_INTERVAL_MS));
  }
  throw new RealModelAcceptanceError('RUN_TIMEOUT');
}

async function fetchWithTimeout(
  fetcher: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  return fetcher(input, { ...init, signal });
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RealModelAcceptanceError('SNAPSHOT_INVALID');
  }
  return value as Record<string, unknown>;
}

function readRunId(value: unknown): string | undefined {
  return typeof value === 'string' && isSafeIdentifier(value) ? value : undefined;
}

function readMetricFact(snapshot: AcceptanceSnapshot): SettlementMetricFact {
  const evidence = snapshot.evidence.filter((item) => item.source === 'metric');
  const summary = evidence[0]?.summary;
  if (evidence.length !== 1 || summary === undefined
    || (summary['status'] !== 'healthy' && summary['status'] !== 'breached' && summary['status'] !== 'insufficient_data')
    || !isSafeCount(summary['total']) || !isSafeCount(summary['failed'])
    || (summary['failureRate'] !== null && !isFiniteNumber(summary['failureRate']))
    || !isFiniteNumber(summary['threshold']) || !isSafeCount(summary['minSamples'])
    || summary['service'] !== 'checkout' || summary['environment'] !== 'simulation'
    || !isSafeCount(summary['start']) || !isSafeCount(summary['end'])) {
    throw new RealModelAcceptanceError('SNAPSHOT_INVALID');
  }
  return {
    status: summary['status'], total: summary['total'], failed: summary['failed'],
    failureRate: summary['failureRate'], threshold: summary['threshold'],
    minSamples: summary['minSamples'], service: 'checkout', environment: 'simulation',
    start: summary['start'], end: summary['end'],
  };
}

async function verifyTraceLinks(
  config: LangSmithEventConfig,
  links: readonly TraceLink[],
  snapshot: AcceptanceSnapshot,
  dependencies: RealModelAcceptanceDependencies,
): Promise<TraceVerification> {
  if (!config.enabled) return { status: 'unavailable', checkedSpanCount: 0 };
  const client = new Client({
    apiUrl: config.endpoint,
    apiKey: config.apiKey,
    timeout_ms: 10_000,
    callerOptions: { maxRetries: 0 },
  });
  return (dependencies.verifyTrace ?? verifyLangSmithTrace)({ client, links, snapshot });
}

function isPublicSnapshotSafe(snapshot: AcceptanceSnapshot, secrets: readonly string[]): boolean {
  if (!snapshot.evidence.every((evidence) => evidence.retrievable === false)) return false;
  return isPublicBoundaryPayloadSafe(snapshot, secrets);
}

/** Checks a public JSON value without retaining it; unknown values fail closed. */
export function isPublicBoundaryPayloadSafe(value: unknown, sensitiveValues: readonly string[] = []): boolean {
  let visited = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    visited += 1;
    if (visited > 100_000 || depth > 32) return false;
    if (candidate === null || typeof candidate === 'boolean') return true;
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate === 'string') return !containsSensitivePublicContent(candidate, sensitiveValues);
    if (Array.isArray(candidate)) return candidate.length <= 20_000 && candidate.every((item) => visit(item, depth + 1));
    if (!isRecord(candidate)) return false;
    return Object.entries(candidate).every(([key, item]) => {
      if (isForbiddenPublicFieldName(key, sensitiveValues)) return false;
      if (key === 'rawSha256' && (typeof item !== 'string' || !/^[a-f\d]{64}$/iu.test(item))) return false;
      return visit(item, depth + 1);
    });
  };
  return visit(value, 0);
}

/** Validates the serialized SDK batch request, not just locally projected Span data. */
export function isSafeLangSmithExportBody(body: string, sensitiveValues: readonly string[] = []): boolean {
  if (Buffer.byteLength(body, 'utf8') > LANGSMITH_BODY_MAX_BYTES) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return false;
  }
  if (!isPublicBoundaryPayloadSafe(payload, sensitiveValues) || !isRecord(payload)
    || Object.keys(payload).some((key) => !LANGSMITH_BATCH_OPERATIONS.has(key))) return false;
  let runCount = 0;
  for (const [operation, candidate] of Object.entries(payload)) {
    if (!Array.isArray(candidate) || candidate.length > 512) return false;
    for (const run of candidate) {
      if (!isSafeLangSmithExportRun(run, operation)) return false;
      runCount += 1;
    }
  }
  return runCount > 0;
}

function isSafeLangSmithExportRun(value: unknown, operation: string): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => !LANGSMITH_EXPORT_RUN_FIELDS.has(key))
    || !isSafeIdentifier(value['id'])) return false;
  if (operation === 'post' && (!isSafeIdentifier(value['name'])
    || typeof value['run_type'] !== 'string'
    || !['chain', 'tool', 'llm', 'retriever'].includes(value['run_type']))) return false;
  if (value['name'] !== undefined && !isSafeIdentifier(value['name'])) return false;
  if (value['run_type'] !== undefined && (typeof value['run_type'] !== 'string'
    || !['chain', 'tool', 'llm', 'retriever'].includes(value['run_type']))) return false;
  if (value['trace_id'] !== undefined && !isSafeIdentifier(value['trace_id'])) return false;
  if (value['parent_run_id'] !== undefined && value['parent_run_id'] !== null && !isSafeIdentifier(value['parent_run_id'])) return false;
  if (value['session_name'] !== undefined && !isSafeLangSmithSessionName(value['session_name'])) return false;
  if (value['dotted_order'] !== undefined
    && (typeof value['dotted_order'] !== 'string' || !/^[A-Za-z0-9._:-]{1,1024}$/u.test(value['dotted_order']))) return false;
  if (value['reference_example_id'] !== undefined && value['reference_example_id'] !== null
    && !isSafeIdentifier(value['reference_example_id'])) return false;
  for (const key of ['child_runs', 'attachments', 'events'] as const) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length !== 0)) return false;
  }
  if (value['serialized'] !== undefined && value['serialized'] !== null
    && (!isRecord(value['serialized']) || Object.keys(value['serialized']).length !== 0)) return false;
  const remoteShape = Object.fromEntries(LANGSMITH_REMOTE_SELECTED_FIELDS
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .map((key) => [key, value[key]]));
  if (!isSafeLangSmithRunPayload(remoteShape)) return false;
  for (const key of ['start_time', 'end_time'] as const) {
    const timestamp = value[key];
    if (timestamp !== undefined && !(typeof timestamp === 'number' && Number.isFinite(timestamp))
      && !timestampV2Schema.safeParse(timestamp).success) return false;
  }
  return value['tags'] === undefined || (Array.isArray(value['tags']) && value['tags'].length <= 16
    && value['tags'].every((tag) => typeof tag === 'string' && LANGSMITH_SAFE_TAGS.has(tag)));
}

async function inspectPublicBoundaries(
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
  snapshot: AcceptanceSnapshot,
  sensitiveValues: readonly string[],
): Promise<boolean> {
  try {
    const runIds = [snapshot.parent.runId, ...snapshot.children.map((child) => child.runId)];
    if (new Set(runIds).size !== runIds.length) return false;
    const allowedRunIds = new Set(runIds);
    const allEvidenceIds = new Set(snapshot.evidence.map((item) => item.evidenceId));
    if (allEvidenceIds.size !== snapshot.evidence.length
      || snapshot.evidence.some((item) => !allowedRunIds.has(item.runId))) return false;

    for (const runId of runIds) {
      const messageItems = await readPublicPages(fetcher, baseUrl, runId, 'messages', sensitiveValues);
      const evidenceItems = await readPublicPages(fetcher, baseUrl, runId, 'evidence', sensitiveValues);
      if (messageItems === null || evidenceItems === null) return false;
      const visibleEvidenceIds = new Set<string>();
      const expectedEvidence = runId === snapshot.parent.runId
        ? snapshot.evidence
        : snapshot.evidence.filter((item) => item.runId === runId);
      if (expectedEvidence.some((item) => !isPublicEvidenceEnvelope(item))) return false;
      const expectedById = new Map(expectedEvidence.map((item) => [item.evidenceId, item]));
      for (const item of evidenceItems) {
        if (!isPublicEvidenceEnvelope(item) || !allowedRunIds.has(item['runId'])
          || visibleEvidenceIds.has(item['evidenceId'])) return false;
        const expected = expectedById.get(item['evidenceId']);
        if (expected === undefined || !matchesPublicEvidenceView(item, expected)) return false;
        visibleEvidenceIds.add(item['evidenceId']);
      }
      if (!sameStringSet(visibleEvidenceIds, new Set(expectedEvidence.map((item) => item.evidenceId)))) return false;

      const messageEvidenceIds = collectPublicEvidenceRefs(messageItems);
      if (messageEvidenceIds === null || [...messageEvidenceIds].some((id) => !visibleEvidenceIds.has(id))) return false;
      for (const evidenceId of visibleEvidenceIds) {
        const expected = expectedById.get(evidenceId);
        if (expected === undefined) return false;
        const detail = await readPublicJson(fetcher,
          `${baseUrl}/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(evidenceId)}`,
          sensitiveValues,
        );
        if (!isPublicEvidenceEnvelope(detail) || detail['evidenceId'] !== evidenceId
          || !allowedRunIds.has(detail['runId']) || !matchesPublicEvidenceView(detail, expected)) return false;
      }
      if (!await inspectPublicEventStream(fetcher, baseUrl, runId, sensitiveValues)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function readPublicPages(
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
  runId: string,
  resource: 'messages' | 'evidence',
  sensitiveValues: readonly string[],
): Promise<unknown[] | null> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < PUBLIC_PAGE_LIMIT; pageNumber += 1) {
    const url = new URL(`/runs/${encodeURIComponent(runId)}/${resource}`, baseUrl);
    url.searchParams.set('limit', '50');
    if (cursor !== undefined) url.searchParams.set('cursor', cursor);
    const response = await fetchWithTimeout(fetcher, url, { method: 'GET' });
    if (!response.ok) return null;
    const page = await readBoundedJson(response, PUBLIC_RESPONSE_MAX_BYTES, sensitiveValues);
    if (!isPublicPageEnvelope(page)) return null;
    for (const item of page['items']) {
      if (resource === 'messages' && !isPublicMessageEnvelope(item, runId)) return null;
      if (resource === 'evidence' && !isPublicEvidenceEnvelope(item)) return null;
      items.push(item);
    }
    if (items.length > 15_000) return null;
    const nextCursor = page['nextCursor'];
    if (nextCursor === undefined) return items;
    if (typeof nextCursor !== 'string' || nextCursor.length === 0 || nextCursor.length > 2_048
      || page['items'].length === 0) return null;
    cursor = nextCursor;
  }
  return null;
}

async function readPublicJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  sensitiveValues: readonly string[],
): Promise<unknown> {
  const response = await fetchWithTimeout(fetcher, url, { method: 'GET' });
  if (!response.ok) return null;
  return readBoundedJson(response, PUBLIC_RESPONSE_MAX_BYTES, sensitiveValues);
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  sensitiveValues: readonly string[],
): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) return null;
  const text = await readBoundedBody(response.body, maxBytes);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text) as unknown;
    return isPublicBoundaryPayloadSafe(value, sensitiveValues) ? value : null;
  } catch {
    return null;
  }
}

async function inspectPublicEventStream(
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
  runId: string,
  sensitiveValues: readonly string[],
): Promise<boolean> {
  const url = new URL(`/runs/${encodeURIComponent(runId)}/events`, baseUrl);
  url.searchParams.set('snapshots', 'none');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUBLIC_SSE_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(url, { method: 'GET', signal: controller.signal });
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')
      || response.body === null) return false;
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) return false;
      bytes += next.value.byteLength;
      if (bytes > PUBLIC_SSE_MAX_BYTES) return false;
      pending += decoder.decode(next.value, { stream: true });
      let separator = /\r?\n\r?\n/u.exec(pending);
      while (separator !== null) {
        const frame = pending.slice(0, separator.index);
        pending = pending.slice(separator.index + separator[0].length);
        const result = inspectSseFrame(frame, runId, sensitiveValues);
        if (result === 'invalid') return false;
        if (result === 'terminal') return true;
        separator = /\r?\n\r?\n/u.exec(pending);
      }
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => undefined);
  }
}

function inspectSseFrame(
  frame: string,
  runId: string,
  sensitiveValues: readonly string[],
): 'ignore' | 'invalid' | 'terminal' {
  let eventName = '';
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '');
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return eventName.length === 0 ? 'ignore' : 'invalid';
  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join('\n')) as unknown;
  } catch {
    return 'invalid';
  }
  if (!isPublicBoundaryPayloadSafe(payload, sensitiveValues)
    || !isPublicEventEnvelope(payload, runId)
    || payload.type !== eventName) return 'invalid';
  return PUBLIC_TERMINAL_EVENTS.has(eventName)
    ? 'terminal'
    : 'ignore';
}

/** Strictly validates the user-visible Message V2 contract at the HTTP boundary. */
export function isPublicMessageEnvelope(value: unknown, expectedRunId?: string): boolean {
  let messageValue = value;
  if (expectedRunId !== undefined) {
    if (!isRecord(value) || Object.keys(value).some((key) => !['message', 'version', 'truncated'].includes(key))
      || Object.keys(value).length !== 3 || !Number.isSafeInteger(value['version'])
      || (value['version'] as number) < 1 || typeof value['truncated'] !== 'boolean') return false;
    messageValue = value['message'];
  }
  const parsed = safeParseAgentMessageV2(messageValue);
  return parsed.success && parsed.data.visibility !== 'audit'
    && (expectedRunId === undefined || parsed.data.runId === expectedRunId);
}

/** Strictly validates the public query page envelope shared by messages and evidence. */
export function isPublicPageEnvelope(value: unknown): value is { items: unknown[]; nextCursor?: string } {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'items' && key !== 'nextCursor')
    || !Array.isArray(value['items'])) return false;
  return value['nextCursor'] === undefined
    || (typeof value['nextCursor'] === 'string' && value['nextCursor'].length > 0 && value['nextCursor'].length <= 2_048);
}

/** Strictly validates the stable public Evidence DTO; raw/sample fields are never accepted. */
export function isPublicEvidenceEnvelope(value: unknown): value is PublicEvidenceView {
  if (!isRecord(value) || Object.keys(value).some((key) => !PUBLIC_EVIDENCE_FIELDS.has(key))) return false;
  if (typeof value['evidenceId'] !== 'string' || value['evidenceId'].length === 0
    || typeof value['runId'] !== 'string' || value['runId'].length === 0
    || !isPublicEvidenceSource(value['source'])
    || !isPublicEvidenceState(value['state'])
    || typeof value['capturedAt'] !== 'string' || !timestampV2Schema.safeParse(value['capturedAt']).success
    || !isPublicJsonObject(value['summary']) || !isPublicEvidenceSummary(value['source'], value['summary'])
    || typeof value['traceIdCount'] !== 'number' || !Number.isSafeInteger(value['traceIdCount']) || value['traceIdCount'] < 0
    || value['retrievable'] !== false) return false;
  if (value['coverage'] !== undefined && (typeof value['coverage'] !== 'number'
    || !Number.isFinite(value['coverage']) || value['coverage'] < 0 || value['coverage'] > 1)) return false;
  if (value['truncated'] !== undefined && typeof value['truncated'] !== 'boolean') return false;
  for (const key of ['recordCount', 'sourceBytes', 'storedBytes', 'chunkCount'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0)) return false;
  }
  if (value['rawSha256'] !== undefined && (typeof value['rawSha256'] !== 'string' || !/^[a-f\d]{64}$/iu.test(value['rawSha256']))) return false;
  if (value['timeRange'] !== undefined && !isPublicEvidenceTimeRange(value['timeRange'])) return false;
  return true;
}

/** Public summaries are source-specific; unknown keys or unimplemented source shapes fail closed. */
function isPublicEvidenceSummary(source: PublicEvidenceView['source'], summary: JsonObject): boolean {
  if (source === 'metric') {
    const required = [...PUBLIC_METRIC_SUMMARY_FIELDS];
    const status = summary['status'];
    if (!hasExactlyRequiredFields(summary, PUBLIC_METRIC_SUMMARY_FIELDS, required)
      || (status !== 'healthy' && status !== 'breached' && status !== 'insufficient_data')) return false;
    const total = summary['total'];
    const failed = summary['failed'];
    const failureRate = summary['failureRate'];
    const threshold = summary['threshold'];
    const minSamples = summary['minSamples'];
    const start = summary['start'];
    const end = summary['end'];
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0
      || typeof failed !== 'number' || !Number.isSafeInteger(failed) || failed < 0 || failed > total
      || (failureRate !== null && (typeof failureRate !== 'number' || !Number.isFinite(failureRate) || failureRate < 0 || failureRate > 1))
      || typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1
      || typeof minSamples !== 'number' || !Number.isSafeInteger(minSamples) || minSamples < 1
      || typeof summary['service'] !== 'string' || summary['service'].length === 0 || summary['service'].length > 128
      || typeof summary['environment'] !== 'string' || summary['environment'].length === 0 || summary['environment'].length > 128
      || typeof start !== 'number' || !Number.isFinite(start)
      || typeof end !== 'number' || !Number.isFinite(end) || end <= start
      || !isBoundedStringArray(summary['missingEvidence'], 20)) return false;
    const expectedRate = total === 0 ? null : failed / total;
    if (failureRate !== expectedRate) return false;
    const expectedStatus = total < minSamples || failureRate === null
      ? 'insufficient_data'
      : failureRate > threshold ? 'breached' : 'healthy';
    return status === expectedStatus;
  }
  if (source === 'log') {
    const required = ['recordCount', 'sourceBytes', 'storedBytes', 'coverage', 'truncated', 'missingEvidence'];
    if (!hasExactlyRequiredFields(summary, PUBLIC_LOG_SUMMARY_FIELDS, required)) return false;
    for (const key of ['recordCount', 'sourceBytes', 'storedBytes'] as const) {
      const count = summary[key];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return false;
    }
    if (typeof summary['coverage'] !== 'number' || !Number.isFinite(summary['coverage'])
      || summary['coverage'] < 0 || summary['coverage'] > 1 || typeof summary['truncated'] !== 'boolean'
      || !isBoundedStringArray(summary['missingEvidence'], 50)) return false;
    return summary['sourceSnapshotId'] === undefined
      || (typeof summary['sourceSnapshotId'] === 'string' && summary['sourceSnapshotId'].length > 0
        && summary['sourceSnapshotId'].length <= 256);
  }
  return false;
}

function hasExactlyRequiredFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length >= required.length && keys.length <= allowed.size
    && keys.every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}

function isBoundedStringArray(value: unknown, maxItems: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256);
}

export function matchesPublicEvidenceView(value: unknown, expected: PublicEvidenceView): boolean {
  return isPublicEvidenceEnvelope(value) && isPublicEvidenceEnvelope(expected) && sameJsonValue(value, expected);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]));
}

function isPublicEvidenceSource(value: unknown): value is PublicEvidenceView['source'] {
  return typeof value === 'string' && PUBLIC_EVIDENCE_SOURCES.some((source) => source === value);
}

function isPublicEvidenceState(value: unknown): value is PublicEvidenceView['state'] {
  return typeof value === 'string' && PUBLIC_EVIDENCE_STATES.some((state) => state === value);
}

function isPublicEvidenceTimeRange(value: unknown): value is NonNullable<PublicEvidenceView['timeRange']> {
  return isRecord(value) && Object.keys(value).every((key) => key === 'start' || key === 'end')
    && typeof value['start'] === 'string' && timestampV2Schema.safeParse(value['start']).success
    && typeof value['end'] === 'string' && timestampV2Schema.safeParse(value['end']).success;
}

function isPublicJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isPublicJsonValue);
}

function isPublicJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPublicJsonValue);
  return isRecord(value) && Object.values(value).every(isPublicJsonValue);
}

/** Validates the projected SSE envelope; terminal payloads must match their published schema. */
export function isPublicEventEnvelope(value: unknown, expectedRunId: string): value is Record<string, unknown> {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !PUBLIC_EVENT_FIELDS.has(key))
    || value['schemaVersion'] !== 2
    || !isSafeIdentifier(value['eventId'])
    || !Number.isSafeInteger(value['sequence']) || (value['sequence'] as number) < 0
    || typeof value['type'] !== 'string' || !Object.prototype.hasOwnProperty.call(agentEventPayloadSchemas, value['type'])
    || value['runId'] !== expectedRunId
    || !isSafeIdentifier(value['correlationId'])
    || !timestampV2Schema.safeParse(value['timestamp']).success
    || (value['durability'] !== 'durable' && value['durability'] !== 'transient')
    || !isRecord(value['payload'])) return false;

  for (const key of ['sessionId', 'replyId', 'streamId', 'stepId'] as const) {
    if (value[key] !== undefined && !isSafeIdentifier(value[key])) return false;
  }
  const schema = agentEventPayloadSchemas[value['type'] as keyof typeof agentEventPayloadSchemas];
  return schema.safeParse(value['payload']).success;
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string | null> {
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString('utf8');
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function collectPublicEvidenceRefs(values: readonly unknown[]): Set<string> | null {
  const evidenceIds = new Set<string>();
  let valid = true;
  const visit = (value: unknown): void => {
    if (!valid || Array.isArray(value) || !isRecord(value)) return;
    if (value['type'] === 'evidence_ref') {
      if (typeof value['evidenceId'] !== 'string') { valid = false; return; }
      evidenceIds.add(value['evidenceId']);
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) for (const item of child) visit(item);
      else visit(child);
    }
  };
  for (const value of values) visit(value);
  return valid ? evidenceIds : null;
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function isSafeLangSmithSessionName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
    && !hasControlChars(value);
}

export function createLangSmithAuditedFetch(
  fetcher: typeof globalThis.fetch,
  config: LangSmithEventConfig,
  sensitiveValues: readonly string[],
  onUnsafe: () => void,
): typeof globalThis.fetch {
  if (!config.enabled) return fetcher;
  const expectedOrigin = new URL(config.endpoint).origin;
  return async (input, init) => {
    try {
      const request = input instanceof Request
        ? init === undefined ? input.clone() : new Request(input, init)
        : new Request(input, init);
      const requestUrl = new URL(request.url);
      if (requestUrl.origin !== expectedOrigin || requestUrl.username !== '' || requestUrl.password !== ''
        || requestUrl.search !== '' || requestUrl.hash !== '') {
        onUnsafe();
        return new Response('{"error":"TRACE_PAYLOAD_REJECTED"}', { status: 400 });
      }
      const body = await readBoundedBody(request.clone().body, LANGSMITH_BODY_MAX_BYTES);
      const sanitizedBody = body === null || body.length === 0 ? body : stripSdkRuntimeFromLangSmithExport(body);
      if (sanitizedBody === null || (sanitizedBody.length > 0 && !isSafeLangSmithExportBody(sanitizedBody, sensitiveValues))) {
        onUnsafe();
        return new Response('{"error":"TRACE_PAYLOAD_REJECTED"}', { status: 400 });
      }
      const forwarded = sanitizedBody === null || sanitizedBody === body
        ? request
        : new Request(request, { body: sanitizedBody });
      return await fetcher(forwarded);
    } catch {
      onUnsafe();
      return new Response('{"error":"TRACE_PAYLOAD_REJECTED"}', { status: 400 });
    }
  };
}

function stripSdkRuntimeFromLangSmithExport(body: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(payload)) return body;
  let changed = false;
  for (const operation of ['post', 'patch', 'pre'] as const) {
    const runs = payload[operation];
    if (!Array.isArray(runs)) continue;
    for (const run of runs) {
      if (!isRecord(run) || !isRecord(run['extra']) || !Object.prototype.hasOwnProperty.call(run['extra'], 'runtime')) continue;
      const extra = { ...run['extra'] };
      delete extra['runtime'];
      run['extra'] = extra;
      changed = true;
    }
  }
  return changed ? JSON.stringify(payload) : body;
}

function areTraceLinksSafe(
  links: readonly TraceLink[],
  diagnostics: ExportDiagnostics,
  secrets: readonly string[],
): boolean {
  const serialized = JSON.stringify(links);
  return diagnostics.pending === 0 && diagnostics.dropped === 0
    && secrets.filter((secret) => secret.length > 0).every((secret) => !serialized.includes(secret));
}

async function writeAcceptanceReport(options: RealModelAcceptanceOptions, report: AcceptanceReport): Promise<void> {
  const runId = readRunId(report.runId);
  if (runId === undefined) throw new RealModelAcceptanceError('ACCEPTANCE_REPORT_WRITE_FAILED');
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > REPORT_MAX_BYTES) {
    throw new RealModelAcceptanceError('ACCEPTANCE_REPORT_WRITE_FAILED');
  }
  try {
    const dataReportDirectory = await ensureRealDirectory(join(options.dataDirectory, 'acceptance'));
    const artifactDirectory = await ensureRealDirectory(options.artifactDirectory);
    await writeFile(join(dataReportDirectory, `${runId}.json`), serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await writeFile(join(artifactDirectory, `${runId}.json`), serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch {
    throw new RealModelAcceptanceError('ACCEPTANCE_REPORT_WRITE_FAILED');
  }
}

async function ensureRealDirectory(path: string): Promise<string> {
  const absolutePath = resolve(path);
  await mkdir(absolutePath, { recursive: true });
  const canonicalPath = await realpath(absolutePath);
  if (!samePath(absolutePath, canonicalPath)) throw new Error('INVALID_REPORT_DIRECTORY');
  return canonicalPath;
}

function createFailureReport(
  options: RealModelAcceptanceOptions,
  runId: string,
  snapshotId: string,
  budget: ReturnType<SmokeRequestBudget['snapshot']>,
  diagnostics?: ExportDiagnostics,
): AcceptanceReport {
  return {
    schemaVersion: 1,
    caseId: 'settlement_failure',
    codeRevision: safeRevision(options.codeRevision),
    profileRevision: safeRevision(options.profileRevision),
    snapshotId: isSafeIdentifier(snapshotId) ? snapshotId : 'unavailable',
    runId: isSafeIdentifier(runId) ? runId : 'unavailable',
    childRunIds: [],
    checks: CHECK_CODES.map((code) => ({ code, passed: false })),
    budget,
    usage: { completeness: 'unavailable' },
    exportDiagnostics: diagnostics ?? { pending: 0, dropped: 0, counts: {} },
    traceVerification: { status: 'unavailable', checkedSpanCount: 0 },
    manualReview: { status: 'pending' },
    verdict: 'failed',
  };
}

function assertLocalHttpUrl(value: string, code: RealModelAcceptanceErrorCode): void {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !isLoopback(url.hostname) || url.username !== '' || url.password !== '') {
      throw new Error('not a loopback URL');
    }
  } catch {
    throw new RealModelAcceptanceError(code);
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname.toLowerCase() === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isValidRevision(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !hasControlChars(value);
}

function hasControlChars(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function safeRevision(value: string): string {
  return isValidRevision(value) ? value : 'unverified';
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/^\\\\\?\\/u, '').replace(/[\\/]+$/u, '').toLowerCase();
  return normalize(left) === normalize(right);
}
