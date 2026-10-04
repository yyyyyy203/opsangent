import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLogsLab } from '../../dist/bootstrap/logs-lab.js';
import { startAgentWebRuntime } from '../../dist/bootstrap/agent-web-runtime.js';

if (process.env.AGENTOPS_REAL_LOGS_WEB !== '1') {
  throw new Error('Set AGENTOPS_REAL_LOGS_WEB=1 to start the isolated Logs browser fixture.');
}

const agentPort = Number(process.env.AGENTOPS_E2E_AGENT_PORT ?? 45200);
const webPort = Number(process.env.AGENTOPS_E2E_WEB_PORT ?? 45273);
const controlPort = Number(process.env.AGENTOPS_E2E_CONTROL_PORT ?? 45201);
// Synthetic, local-only canaries; the browser test checks their exact values
// never cross any public boundary. Keep the Evidence key stable across restarts.
const labCursorSecret = 'test-only-logs-lab-hmac-canary-0123456789';
const evidenceCursorSecret = 'test-only-evidence-cursor-canary-9876543210';
if (labCursorSecret === evidenceCursorSecret
  || Buffer.byteLength(labCursorSecret, 'utf8') < 32
  || Buffer.byteLength(evidenceCursorSecret, 'utf8') < 32) {
  throw new Error('LOGS_E2E_SECRETS_INVALID');
}
const totals = { parent: 0, metrics: 0, logs: 0 };
const observed = [];
const observedEvidence = new Set();
const reportReceipts = [];
const observedReports = new Set();
let logsOffline = false;
let pauseParent = false;
const parentResumeWaiters = new Set();
let lab;
let runtime;
let control;
let root;
let shuttingDown = false;
let restarting;

process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });

async function assertBackendsReady() {
  for (const [name, url] of [
    ['Elasticsearch', 'http://127.0.0.1:19200/_cluster/health'],
    ['Prometheus', 'http://127.0.0.1:19290/-/ready'],
  ]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) continue;
    } catch { /* Report one actionable fixture error below. */ }
    throw new Error(`${name} backend is unavailable. Start the dedicated agentops-logs Compose project before running this opt-in test.`);
  }
}

function windowForLab() {
  const endMs = Date.parse(lab.expiresAt) - 120_000;
  return { start: new Date(endMs - 300_000).toISOString(), end: new Date(endMs).toISOString() };
}

async function startRuntime() {
  const window = windowForLab();
  return startAgentWebRuntime({
    dataDirectory: root,
    workspaceRoots: [root],
    model: new ParentModel(window),
    metrics: { profileId: 'simulation', mcpUrl: lab.metricsMcpUrl, childModel: new MetricsModel() },
    logs: {
      profileId: 'simulation',
      mcpUrl: logsOffline ? 'http://127.0.0.1:1/mcp' : lab.logsMcpUrl,
      childModel: new LogsModel(window),
      cursorSecret: evidenceCursorSecret,
    },
    host: '127.0.0.1',
    port: agentPort,
    allowedOrigins: [`http://127.0.0.1:${webPort}`],
  });
}

async function restartRuntime() {
  if (restarting) return restarting;
  restarting = (async () => {
    await runtime.close();
    runtime = undefined;
    runtime = await startRuntime();
  })();
  try { await restarting; } finally { restarting = undefined; }
}

async function handleControl(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (request.method === 'GET' && request.url === '/__state') {
      response.writeHead(200).end(JSON.stringify({
        ready: runtime !== undefined,
        logsOffline,
        pauseParent,
        calls: totals,
        observed,
        reportReceipts,
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/__restart') {
      await restartRuntime();
      response.writeHead(200).end('{"ready":true}');
      return;
    }
    if (request.method === 'POST' && request.url === '/__mode') {
      const data = await readSmallJson(request);
      if (data === null || typeof data !== 'object'
        || (data.logsOffline !== undefined && typeof data.logsOffline !== 'boolean')
        || (data.pauseParent !== undefined && typeof data.pauseParent !== 'boolean')
        || (data.logsOffline === undefined && data.pauseParent === undefined)) {
        response.writeHead(400).end('{"error":"INVALID_MODE"}');
        return;
      }
      const requiresRestart = data.logsOffline !== undefined && data.logsOffline !== logsOffline;
      if (data.logsOffline !== undefined) logsOffline = data.logsOffline;
      if (data.pauseParent !== undefined) setParentPaused(data.pauseParent);
      if (requiresRestart) await restartRuntime();
      response.writeHead(200).end('{"ready":true}');
      return;
    }
    response.writeHead(404).end('{"error":"NOT_FOUND"}');
  } catch {
    if (!response.writableEnded) response.writeHead(500).end('{"error":"FIXTURE_CONTROL_FAILED"}');
  }
}

function setParentPaused(paused) {
  pauseParent = paused;
  if (!paused) {
    for (const resume of parentResumeWaiters) resume();
  }
}

function waitForParentResume(signal) {
  if (!pauseParent) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Run aborted.'));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      parentResumeWaiters.delete(onResume);
      signal?.removeEventListener('abort', onAbort);
    };
    const onResume = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(signal?.reason ?? new Error('Run aborted.')); };
    parentResumeWaiters.add(onResume);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (!pauseParent) onResume();
  });
}

async function readSmallJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_024) throw new Error('CONTROL_BODY_TOO_LARGE');
  }
  return JSON.parse(body);
}

async function close() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (control?.listening) {
      control.closeAllConnections();
      await new Promise((resolve) => control.close(resolve));
    }
    await runtime?.close();
    await lab?.close();
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
}

class ParentModel {
  constructor(window) { this.window = window; }
  async *stream(messages, _tools, options) {
    totals.parent++;
    await waitForParentResume(options.signal);
    if (!hasResult(messages, 'metrics_subagent')) {
      const call = { id: `parent-metrics-${options.runId}`, name: 'metrics_subagent', input: {
        profileId: 'simulation', service: 'checkout', ...this.window, question: '核验结算指标',
      } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call], usage: { inputTokens: 7, outputTokens: 3 } };
    }
    if (!hasResult(messages, 'logs_subagent')) {
      const call = { id: `parent-logs-${options.runId}`, name: 'logs_subagent', input: {
        profileId: 'simulation', service: 'checkout', ...this.window, question: '调查结算日志',
      } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call], usage: { inputTokens: 7, outputTokens: 3 } };
    }
    const text = '指标与日志证据已分别核验；仅据日志不能断定根因。';
    yield { type: 'text_delta', delta: text };
    return { text, toolCalls: [], usage: { inputTokens: 7, outputTokens: 3 } };
  }
}

class MetricsModel {
  async *stream(messages, _tools, options) {
    totals.metrics++;
    if (!hasResult(messages, 'metrics.settlement')) {
      const call = { id: `metric-query-${options.runId}`, name: 'metrics.settlement', input: { service: 'checkout' } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call], usage: { inputTokens: 5, outputTokens: 2 } };
    }
    const evidenceId = evidenceFrom(messages, 'metrics.settlement');
    if (evidenceId && !hasResult(messages, 'source_report')) {
      const call = { id: `metric-report-${options.runId}`, name: 'source_report', input: {
        summary: '结算指标已核验。',
        findings: [{ kind: 'observation', statement: '结算窗口指标已核验。', evidenceIds: [evidenceId] }],
        businessTraceIds: [], missingEvidence: [],
      } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call], usage: { inputTokens: 5, outputTokens: 2 } };
    }
    const text = '指标来源调查完成。';
    yield { type: 'text_delta', delta: text };
    return { text, toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 } };
  }
}

class LogsModel {
  constructor(window) { this.window = window; }
  async *stream(messages, _tools, options) {
    totals.logs++;
    const aggregate = jsonFrom(messages, 'logs.aggregate_evidence');
    if (aggregate?.evidenceId && !observedEvidence.has(aggregate.evidenceId)) {
      observedEvidence.add(aggregate.evidenceId);
      observed.push({
        recordCount: aggregate.recordCount,
        exceptionCount: aggregate.exceptionSignatures?.find((item) => item.value === 'SQLTimeoutException')?.count ?? 0,
      });
    }
    if (!hasResult(messages, 'logs.capture')) {
      const call = { id: `logs-capture-${options.runId}`, name: 'logs.capture', input: {
        service: 'checkout', ...this.window,
      } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call], usage: { inputTokens: 6, outputTokens: 4 } };
    }
    const evidenceId = evidenceFrom(messages, 'logs.capture');
    if (!evidenceId) {
      if (!hasResult(messages, 'source_report')) {
        const call = { id: `logs-report-${options.runId}`, name: 'source_report', input: {
          summary: '日志来源不可用，缺少日志证据。',
          findings: [], businessTraceIds: [], missingEvidence: ['logs_source_unavailable'],
        } };
        yield { type: 'tool_call', call };
        return { toolCalls: [call], usage: { inputTokens: 6, outputTokens: 4 } };
      }
      if (!observedReports.has(options.runId)) {
        observedReports.add(options.runId);
        const result = messages.flatMap((message) => message.blocks)
          .find((block) => block.type === 'tool_result' && block.result.toolName === 'source_report')?.result;
        reportReceipts.push({ runId: options.runId, accepted: jsonFrom(messages, 'source_report')?.accepted === true,
          status: result?.status ?? 'missing', errorCode: result?.error?.code ?? null });
      }
      const text = '日志来源不可用，缺少日志证据。';
      yield { type: 'text_delta', delta: text };
      return { text, toolCalls: [], usage: { inputTokens: 6, outputTokens: 4 } };
    }
    if (!hasResult(messages, 'logs.aggregate_evidence')) {
      const call = { id: `logs-aggregate-${options.runId}`, name: 'logs.aggregate_evidence', input: { evidenceId } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call], usage: { inputTokens: 6, outputTokens: 4 } };
    }
    if (!hasResult(messages, 'source_report')) {
      const capture = jsonFrom(messages, 'logs.capture');
      const call = { id: `logs-report-${options.runId}`, name: 'source_report', input: {
        summary: '日志采集与聚合已完成。',
        findings: [{ kind: 'observation', statement: '已采集并聚合日志证据。', evidenceIds: [evidenceId] }],
        businessTraceIds: Array.isArray(capture?.traceIds) ? capture.traceIds : [],
        missingEvidence: [],
      } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call], usage: { inputTokens: 6, outputTokens: 4 } };
    }
    const text = '日志来源调查完成。';
    yield { type: 'text_delta', delta: text };
    return { text, toolCalls: [], usage: { inputTokens: 6, outputTokens: 4 } };
  }
}

function hasResult(messages, name) {
  return messages.some((message) => message.blocks.some((block) => block.type === 'tool_result' && block.result.toolName === name));
}

function responseFrom(messages, name) {
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result' && block.result.toolName === name) return block.result.response;
    }
  }
  return undefined;
}

function evidenceFrom(messages, name) {
  const response = responseFrom(messages, name);
  return response?.evidenceIds?.[0] ?? response?.blocks?.find((block) => block.type === 'evidence_ref')?.evidenceId;
}

function jsonFrom(messages, name) {
  return responseFrom(messages, name)?.blocks?.find((block) => block.type === 'json')?.value;
}

try {
  await assertBackendsReady();
  root = await mkdtemp(join(tmpdir(), 'agentops-logs-browser-'));
  lab = await startLogsLab({
    elasticsearchUrl: 'http://127.0.0.1:19200',
    prometheusUrl: 'http://127.0.0.1:19290',
    cursorSecret: labCursorSecret,
    initialScenario: 'settlement_failure',
    metricsPort: 19208,
    metricsMcpPort: 0,
    logsMcpPort: 0,
    statusPort: 0,
  });
  runtime = await startRuntime();
  control = createServer((request, response) => { void handleControl(request, response); });
  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(controlPort, '127.0.0.1', () => {
      control.off('error', reject);
      resolve();
    });
  });
  process.stdout.write(JSON.stringify({ status: 'ready', agentPort, controlPort }) + '\n');
} catch (error) {
  process.stderr.write(`LOGS_E2E_START_FAILED ${error instanceof Error ? error.message : 'unknown'}\n`);
  await close();
  process.exitCode = 1;
}
