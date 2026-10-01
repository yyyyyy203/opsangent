import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettlementSimulator } from '../../dist/infrastructure/simulator/settlement-simulator.js';
import { startSimulatorMetricsServer } from '../../dist/infrastructure/simulator/http-server.js';
import { PrometheusSettlementSource } from '../../dist/infrastructure/prometheus/settlement-source.js';
import { startSettlementMcpServer } from '../../dist/infrastructure/mcp/settlement-server.js';
import { startAgentWebRuntime } from '../../dist/bootstrap/agent-web-runtime.js';

const dataDirectory = await mkdtemp(join(tmpdir(), 'agentops-real-web-e2e-'));
const agentPort = Number(process.env.AGENTOPS_E2E_AGENT_PORT ?? 45100);
const webPort = Number(process.env.AGENTOPS_E2E_WEB_PORT ?? 45173);
const controlPort = Number(process.env.AGENTOPS_E2E_CONTROL_PORT ?? 45101);
const simulator = new SettlementSimulator();
simulator.select('settlement_failure');
const simulatorServer = await startSimulatorMetricsServer(simulator, { host: '0.0.0.0', port: 19108 });
const source = new PrometheusSettlementSource({ url: 'http://127.0.0.1:19090' });
const mcp = await startSettlementMcpServer(source, { port: 0 });
let runtime = await startRuntime();

const control = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/__restart') {
    response.writeHead(404).end();
    return;
  }
  void restartRuntime().then(() => response.writeHead(200).end('ok')).catch(() => response.writeHead(500).end());
});
await new Promise((resolve, reject) => {
  control.once('error', reject);
  control.listen(controlPort, '127.0.0.1', () => {
    control.removeListener('error', reject);
    resolve();
  });
});

process.stdout.write(`${JSON.stringify({ status: 'ready', url: runtime.url, controlPort })}\n`);

let restarting = null;
async function restartRuntime() {
  if (restarting !== null) return restarting;
  restarting = (async () => {
    await runtime.close();
    runtime = await startRuntime();
  })();
  try {
    await restarting;
  } finally {
    restarting = null;
  }
}

async function startRuntime() {
  await waitForSnapshot();
  return startAgentWebRuntime({
    dataDirectory,
    workspaceRoots: [dataDirectory],
    model: new RealWebParentModel(),
    metrics: { profileId: 'simulation', mcpUrl: mcp.url, childModel: new RealWebChildModel() },
    host: '127.0.0.1',
    port: agentPort,
    allowedOrigins: [`http://127.0.0.1:${webPort}`],
  });
}

async function waitForSnapshot() {
  const signal = AbortSignal.timeout(45_000);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await source.query(signal);
    if (result.status === 'available' && result.counts.total === 100 && result.counts.failed === 15) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Real Prometheus did not scrape the settlement failure fixture.');
}

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    control.closeAllConnections();
    await new Promise((resolve) => control.close(() => resolve()));
    await runtime.close();
    await mcp.close();
    await simulatorServer.close();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });

class RealWebParentModel {
  async *stream(messages, _tools, options) {
    if (!hasToolResult(messages)) {
      const end = Math.floor(Date.now() / 1_000);
      const call = {
        id: `real-web-parent-${options.runId}`,
        name: 'metrics_subagent',
        input: {
          profileId: 'simulation',
          service: 'checkout',
          start: new Date((end - 300) * 1_000).toISOString(),
          end: new Date(end * 1_000).toISOString(),
          question: '结算失败率是否升高？',
        },
      };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    const text = '真实 Prometheus 指标已完成确定性核验。';
    yield { type: 'text_delta', delta: text };
    return { text, toolCalls: [] };
  }
}

class RealWebChildModel {
  async *stream(messages, _tools, options) {
    if (!hasToolResultNamed(messages, 'metrics.settlement')) {
      const call = { id: `real-web-metric-${options.runId}`, name: 'metrics.settlement', input: { service: 'checkout' } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    if (hasToolResultNamed(messages, 'source_report')) {
      const text = '来源报告已提交。';
      yield { type: 'text_delta', delta: text };
      return { text, toolCalls: [] };
    }
    const evidenceId = findEvidenceId(messages);
    if (evidenceId === undefined) {
      const text = '数据源当前不可用。';
      yield { type: 'text_delta', delta: text };
      return { text, toolCalls: [] };
    }
    const call = {
      id: `real-web-report-${options.runId}`,
      name: 'source_report',
      input: {
        summary: '结算指标已核验。',
        findings: [{ kind: 'observation', statement: '结算指标已核验。', evidenceIds: [evidenceId] }],
        businessTraceIds: [],
        missingEvidence: [],
      },
    };
    yield { type: 'tool_call', call };
    return { toolCalls: [call] };
  }
}

function hasToolResult(messages) {
  return messages.some((message) => message.blocks.some((block) => block.type === 'tool_result'));
}

function hasToolResultNamed(messages, name) {
  return messages.some((message) => message.blocks.some((block) => block.type === 'tool_result'
    && block.result.toolName === name));
}

function findEvidenceId(messages) {
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_result' || block.result.toolName !== 'metrics.settlement') continue;
      const response = block.result.response;
      const evidenceId = response?.evidenceIds?.[0];
      if (typeof evidenceId === 'string') return evidenceId;
      const evidenceRef = response?.blocks?.find((item) => item.type === 'evidence_ref');
      if (evidenceRef?.type === 'evidence_ref') return evidenceRef.evidenceId;
    }
  }
  return undefined;
}
