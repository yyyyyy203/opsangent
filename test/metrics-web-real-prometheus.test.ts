import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SettlementSimulator,
  type SettlementScenario,
} from '../src/infrastructure/simulator/settlement-simulator.js';
import { startSimulatorMetricsServer } from '../src/infrastructure/simulator/http-server.js';
import { PrometheusSettlementSource } from '../src/infrastructure/prometheus/settlement-source.js';
import { startSettlementMcpServer } from '../src/infrastructure/mcp/settlement-server.js';
import { startAgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import type {
  AgentMessage,
  ChatModel,
  ModelCallOptions,
  ModelResponse,
  ModelStreamEvent,
  Tool,
} from '../src/contracts/index.js';

const REAL_PROMETHEUS_WEB = process.env.AGENTOPS_REAL_PROMETHEUS_WEB === '1';
const PROMETHEUS_URL = 'http://127.0.0.1:19090';

/** Opt-in: requires Docker Prometheus and the local simulator scrape target. */
describe.skipIf(!REAL_PROMETHEUS_WEB)('real Prometheus Web acceptance', () => {
  it('runs normal, failure, and low-sample snapshots through the Web runtime', async () => {
    const simulator = new SettlementSimulator();
    const simulatorServer = await startSimulatorMetricsServer(simulator, { host: '0.0.0.0', port: 19108 });
    const source = new PrometheusSettlementSource({ url: PROMETHEUS_URL });
    const mcp = await startSettlementMcpServer(source, { port: 0 });
    const root = await mkdtemp(join(tmpdir(), 'agentops-real-web-'));
    const runtime = await startAgentWebRuntime({
      dataDirectory: root,
      workspaceRoots: [root],
      model: new RealWebParentModel(),
      metrics: { profileId: 'simulation', mcpUrl: mcp.url, childModel: new RealWebChildModel() },
      port: 0,
    });
    try {
      const cases: readonly RealCase[] = [
        { scenario: 'normal', total: 100, failed: 0, status: 'healthy', rate: 0 },
        { scenario: 'settlement_failure', total: 100, failed: 15, status: 'breached', rate: 0.15 },
        { scenario: 'low_sample', total: 10, failed: 8, status: 'insufficient_data', rate: 0.8 },
      ];
      for (const fixture of cases) {
        simulator.select(fixture.scenario);
        const snapshot = await waitForRealSnapshot(source, fixture);
        const runId = `real-web-${fixture.scenario}`;
        await startRun(runtime.url, runId);
        await waitForStatus(runtime.url, runId, 'completed');

        const detail = await getJson<PublicRunDetail>(runtime.url, `/runs/${runId}`);
        const childRunId = detail.childRunIds[0];
        if (childRunId === undefined) throw new Error('Metrics child Run is missing.');
        const child = await getJson<PublicRunDetail>(runtime.url, `/runs/${encodeURIComponent(childRunId)}`);
        const evidence = await getJson<PublicEvidencePage>(runtime.url, `/runs/${encodeURIComponent(childRunId)}/evidence`);
        const messages = await getJson<unknown>(runtime.url, `/runs/${runId}/messages?limit=50`);
        const childMessages = await getJson<unknown>(runtime.url, `/runs/${encodeURIComponent(childRunId)}/messages?limit=50`);
        const parentEvents = await readPublicEvents(runtime.url, runId);
        const childEvents = await readPublicEvents(runtime.url, childRunId);
        const serialized = JSON.stringify({ detail, child, evidence, messages, childMessages, parentEvents, childEvents });
        expect(detail).toMatchObject({ status: 'completed', childRunIds: [expect.any(String)] });
        expect(detail.evidenceIds).toHaveLength(1);
        expect(child).toMatchObject({ parentRunId: runId, evidenceIds: detail.evidenceIds });
        expect(evidence.items).toHaveLength(1);
        expect(evidence.items[0]).toMatchObject({
          evidenceId: detail.evidenceIds[0],
          source: 'metric',
          state: 'available',
        });
        expect(evidence.items[0]?.summary).toMatchObject({
          status: fixture.status,
          total: fixture.total,
          failed: fixture.failed,
          failureRate: fixture.rate,
        });
        expect(snapshot.counts).toEqual({ total: fixture.total, failed: fixture.failed });
        expect(serialized).not.toContain('settlement_window_requests');
        expect(serialized).not.toContain('raw-only-marker');
        expect(serialized).not.toContain('数据库是根因');
      }
    } finally {
      await runtime.close();
      await mcp.close();
      await simulatorServer.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('does not turn a stopped MCP source into a healthy Web result', async () => {
    const simulator = new SettlementSimulator();
    const simulatorServer = await startSimulatorMetricsServer(simulator, { host: '0.0.0.0', port: 19108 });
    const source = new PrometheusSettlementSource({ url: PROMETHEUS_URL });
    const mcp = await startSettlementMcpServer(source, { port: 0 });
    const disconnectedUrl = mcp.url;
    await mcp.close();
    const root = await mkdtemp(join(tmpdir(), 'agentops-real-web-disconnected-'));
    const runtime = await startAgentWebRuntime({
      dataDirectory: root,
      workspaceRoots: [root],
      model: new RealWebParentModel(),
      metrics: { profileId: 'simulation', mcpUrl: disconnectedUrl, childModel: new RealWebChildModel() },
      port: 0,
    });
    try {
      const runId = 'real-web-disconnected';
      await startRun(runtime.url, runId);
      await waitForStatus(runtime.url, runId, 'completed');
      const detail = await getJson<PublicRunDetail>(runtime.url, `/runs/${runId}`);
      const childRunId = detail.childRunIds[0];
      if (childRunId === undefined) throw new Error('Metrics child Run is missing.');
      const evidence = await getJson<PublicEvidencePage>(runtime.url, `/runs/${encodeURIComponent(childRunId)}/evidence`);
      const messages = await getJson<unknown>(runtime.url, `/runs/${runId}/messages?limit=50`);
      const childMessages = await getJson<unknown>(runtime.url, `/runs/${encodeURIComponent(childRunId)}/messages?limit=50`);
      expect(detail).toMatchObject({ status: 'completed', evidenceIds: [] });
      expect(detail.childRunIds).toHaveLength(1);
      expect(evidence.items).toEqual([]);
      const serialized = JSON.stringify({ detail, messages, childMessages });
      expect(serialized).not.toContain('healthy');
      expect(serialized).not.toContain('正常');
      expect(serialized).not.toContain('settlement_window_requests');
    } finally {
      await runtime.close();
      await simulatorServer.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

interface RealCase {
  scenario: SettlementScenario;
  total: number;
  failed: number;
  status: 'healthy' | 'breached' | 'insufficient_data';
  rate: number;
}

interface PublicRunDetail {
  status: string;
  evidenceIds: readonly string[];
  childRunIds: readonly string[];
}

interface PublicEvidencePage {
  items: readonly {
    evidenceId: string;
    source: string;
    state: string;
    summary: Record<string, unknown>;
  }[];
}

class RealWebParentModel implements ChatModel {
  public async *stream(
    messages: AgentMessage[],
    _tools: Tool[],
    options: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    await Promise.resolve();
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

class RealWebChildModel implements ChatModel {
  public async *stream(
    messages: AgentMessage[],
    _tools: Tool[],
    options: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    await Promise.resolve();
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

async function waitForRealSnapshot(
  source: PrometheusSettlementSource,
  fixture: Pick<RealCase, 'total' | 'failed'>,
): Promise<{ counts: { total: number; failed: number } }> {
  const signal = AbortSignal.timeout(45_000);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await source.query(signal);
    if (result.status === 'available' && result.counts.total === fixture.total && result.counts.failed === fixture.failed) return result;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`real Prometheus scrape did not reach ${fixture.total}/${fixture.failed}`);
}

async function startRun(url: string, runId: string): Promise<void> {
  const response = await fetch(`${url}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, profileId: 'simulation', message: '检查结算失败率' }),
  });
  expect(response.status).toBe(202);
}

async function waitForStatus(url: string, runId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await getJson<PublicRunDetail>(url, `/runs/${runId}`);
    if (result.status === expected) return;
    if (['failed', 'cancelled'].includes(result.status)) throw new Error(`Web Run ended as ${result.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Web Run ${runId} did not reach ${expected}`);
}

async function getJson<T>(url: string, path: string): Promise<T> {
  const response = await fetch(`${url}${path}`);
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function readPublicEvents(url: string, runId: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${url}/runs/${encodeURIComponent(runId)}/events?snapshots=none`, { signal: controller.signal });
    if (!response.ok || response.body === null) throw new Error(`SSE for ${runId} returned ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) throw new Error(`SSE for ${runId} closed before RUN_FINISHED.`);
      body += decoder.decode(next.value, { stream: true });
      if (body.includes('event: RUN_FINISHED')) return body;
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function hasToolResult(messages: readonly AgentMessage[]): boolean {
  return messages.some((message) => message.blocks.some((block) => block.type === 'tool_result'));
}

function hasToolResultNamed(messages: readonly AgentMessage[], name: string): boolean {
  return messages.some((message) => message.blocks.some((block) => block.type === 'tool_result'
    && block.result.toolName === name));
}

function findEvidenceId(messages: readonly AgentMessage[]): string | undefined {
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_result' || block.result.toolName !== 'metrics.settlement') continue;
      const response = block.result.response;
      const evidenceId = response?.evidenceIds?.[0];
      if (typeof evidenceId === 'string') return evidenceId;
      const evidenceRef = response?.blocks.find((item) => item.type === 'evidence_ref');
      if (evidenceRef?.type === 'evidence_ref') return evidenceRef.evidenceId;
    }
  }
  return undefined;
}
