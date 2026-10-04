import { Client } from 'langsmith';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
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
import { verifyLangSmithTrace } from './langsmith-verifier.js';
import type { TraceVerification } from './types.js';

const SMOKE_REQUEST_LIMIT = 10;
const MAX_OUTPUT_TOKENS = 512;
const RUN_DEADLINE_MS = 90_000;
const MIN_SNAPSHOT_REMAINING_MS = 100_000;
const RUN_POLL_INTERVAL_MS = 500;
const HTTP_TIMEOUT_MS = 3_000;
const REPORT_MAX_BYTES = 256_000;
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
    tracing = createLangSmithEventObservability(options.langSmithConfig);
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
    await web.close();
    web = undefined;
    await lab.close();
    lab = undefined;

    if (terminalStatus !== 'completed') throw new RealModelAcceptanceError('RUN_NOT_COMPLETE');
    const snapshot = await (dependencies.readSnapshot ?? readAcceptanceSnapshot)({
      dataDirectory: options.dataDirectory,
      runId,
    });
    if (snapshot.parent.runId !== runId || snapshot.parent.childRunIds.length !== snapshot.children.length) {
      throw new RealModelAcceptanceError('SNAPSHOT_INVALID');
    }
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
        publicDataSafe: isPublicSnapshotSafe(snapshot, [
          options.modelConfig.apiKey,
          options.lab.labCursorSecret,
          options.lab.evidenceCursorSecret,
          ...(options.langSmithConfig.enabled ? [options.langSmithConfig.apiKey] : []),
        ]),
        traceExportSafe: areTraceLinksSafe(traceLinks, exportDiagnostics, [
          options.modelConfig.apiKey,
          options.lab.labCursorSecret,
          options.lab.evidenceCursorSecret,
          ...(options.langSmithConfig.enabled ? [options.langSmithConfig.apiKey] : []),
        ]),
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
  const serialized = JSON.stringify(snapshot);
  return secrets.filter((secret) => secret.length > 0).every((secret) => !serialized.includes(secret));
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

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/^\\\\\?\\/u, '').replace(/[\\/]+$/u, '').toLowerCase();
  return normalize(left) === normalize(right);
}
