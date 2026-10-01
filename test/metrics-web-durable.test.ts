import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentMessage,
  ChatModel,
  ModelCallOptions,
  ModelResponse,
  ModelStreamEvent,
  Observability,
  SpanHandle,
  SpanStart,
  Tool,
} from '../src/contracts/index.js';
import { startSettlementMcpServer } from '../src/infrastructure/mcp/settlement-server.js';
import { startAgentWebRuntime, type AgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { stableSourceChildRunId } from '../src/bootstrap/source-subagent-identity.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('durable Web Metrics integration', () => {
  it('persists parent/child Runs and bounded evidence across Web restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-web-durable-'));
    roots.push(root);
    const runId = 'web-durable-run';
    const parentToolCallId = 'metrics-parent-call';
    const metricToolCallId = 'metrics-tool-call';
    const childRunId = stableSourceChildRunId('metrics', runId, parentToolCallId);
    const evidenceId = stableMetricEvidenceId(childRunId, metricToolCallId);
    const end = Math.floor(Date.parse('2026-10-02T12:34:56.789Z') / 1_000);
    const start = end - 300;
    const rawMarker = 'raw-prometheus-only-marker';
    const mcp = await startSettlementMcpServer({
      query: (signal) => {
        signal.throwIfAborted();
        return Promise.resolve({
          status: 'available' as const,
          start,
          end,
          counts: { total: 100, failed: 15 },
          raw: { data: { rawMarker, exposition: 'settlement_window_requests{outcome="failure"} 15' } },
        });
      },
    }, { port: 0 });
    const observability = new RecordingObservability();
    const parentModel = new ScriptedModel([
      { toolCalls: [{ id: parentToolCallId, name: 'metrics_subagent', input: {
        profileId: 'simulation', service: 'checkout',
        start: new Date(start * 1_000).toISOString(), end: new Date(end * 1_000).toISOString(),
        question: '结算失败率是否升高？',
      } }] },
      { text: '已完成指标取证。', toolCalls: [] },
    ]);
    const childModel = new ScriptedModel([
      { toolCalls: [{ id: metricToolCallId, name: 'metrics.settlement', input: { service: 'checkout' } }] },
      { toolCalls: [{ id: 'source-report-call', name: 'source_report', input: {
        summary: '指标取证完成。',
        findings: [{ kind: 'observation', statement: '结算失败率超过阈值。', evidenceIds: [evidenceId] }],
        businessTraceIds: [], missingEvidence: [],
      } }] },
      { text: '来源报告已提交。', toolCalls: [] },
    ]);
    let runtime: AgentWebRuntime | undefined;
    try {
      runtime = await startAgentWebRuntime({
        dataDirectory: root,
        workspaceRoots: [root],
        model: parentModel,
        clock: { now: () => new Date('2026-10-02T12:34:56.789Z') },
        observability,
        metrics: { profileId: 'simulation', mcpUrl: mcp.url, childModel },
        port: 0,
      });
      await startRun(runtime.url, runId);
      await waitForStatus(runtime.url, runId, 'completed');

      const parent = await getJson(runtime.url, `/runs/${runId}`);
      expect(parent).toMatchObject({ runId, profileId: 'simulation', status: 'completed', childRunIds: [childRunId] });
      expect(parent.evidenceIds).toContain(evidenceId);

      const child = await getJson(runtime.url, `/runs/${encodeURIComponent(childRunId)}`);
      expect(child).toMatchObject({ runId: childRunId, parentRunId: runId, status: 'completed', evidenceIds: [evidenceId] });

      const evidence = await getJson(runtime.url, `/runs/${encodeURIComponent(childRunId)}/evidence`);
      expect(JSON.stringify(evidence)).toContain(evidenceId);
      expect(JSON.stringify(evidence)).not.toContain(rawMarker);

      const parentMessages = await getJson(runtime.url, `/runs/${runId}/messages?limit=50`);
      const childMessages = await getJson(runtime.url, `/runs/${encodeURIComponent(childRunId)}/messages?limit=50`);
      expect(JSON.stringify(parentMessages)).not.toContain(rawMarker);
      expect(JSON.stringify(childMessages)).not.toContain(rawMarker);

      const sse = await readSse(runtime.url, runId);
      expect(sse.status).toBe(200);
      expect(sse.body).toContain('RUN_FINISHED');
      expect(sse.body).not.toContain(rawMarker);
      expect(JSON.stringify(observability.outputs)).not.toContain(rawMarker);
    } finally {
      await runtime?.close();
      await mcp.close();
    }

    runtime = await startAgentWebRuntime({
      dataDirectory: root,
      workspaceRoots: [root],
      model: new ScriptedModel([]),
      clock: { now: () => new Date('2026-10-02T12:34:56.789Z') },
      metrics: { profileId: 'simulation', mcpUrl: mcp.url },
      port: 0,
    });
    try {
      await expect(getJson(runtime.url, `/runs/${runId}`)).resolves.toMatchObject({
        runId, status: 'completed', childRunIds: [childRunId], evidenceIds: [evidenceId],
      });
      await expect(getJson(runtime.url, `/runs/${encodeURIComponent(childRunId)}`)).resolves.toMatchObject({
        runId: childRunId, parentRunId: runId, status: 'completed', evidenceIds: [evidenceId],
      });
    } finally {
      await runtime.close();
    }
  });

  it('maps schema drift, source timeout, and disconnected MCP to unavailable evidence', async () => {
    const schemaDrift = await startSchemaDriftMcpServer();
    const timeout = await startSettlementMcpServer({
      query: () => Promise.reject(Object.assign(new Error('source timeout'), { name: 'TimeoutError' })),
    }, { port: 0 });
    const disconnected = await startSettlementMcpServer({
      query: () => Promise.resolve({
        status: 'available' as const,
        start: 0,
        end: 300,
        counts: { total: 100, failed: 0 },
        raw: { data: { marker: 'disconnected-source' } },
      }),
    }, { port: 0 });
    const disconnectedUrl = disconnected.url;
    await disconnected.close();
    const cases = [
      ['schema-drift', schemaDrift.url],
      ['timeout', timeout.url],
      ['disconnected', disconnectedUrl],
    ] as const;
    try {
      for (const [name, mcpUrl] of cases) {
        const root = await mkdtemp(join(tmpdir(), `opsangent-web-unavailable-${name}-`));
        roots.push(root);
        const runtime = await startAgentWebRuntime({
          dataDirectory: root,
          workspaceRoots: [root],
          model: new ScriptedModel([
            { toolCalls: [{ id: `${name}-parent-call`, name: 'metrics_subagent', input: metricsRequest() }] },
            { text: '数据源不可用。', toolCalls: [] },
          ]),
          clock: fixedClock(),
          metrics: { profileId: 'simulation', mcpUrl, childModel: new ScriptedModel([
            { toolCalls: [{ id: `${name}-metric-call`, name: 'metrics.settlement', input: { service: 'checkout' } }] },
            { text: '数据源不可用。', toolCalls: [] },
          ]) },
          port: 0,
        });
        try {
          const runId = `web-unavailable-${name}`;
          await startRun(runtime.url, runId);
          await waitForStatus(runtime.url, runId, 'completed');
          const parent = await getJson(runtime.url, `/runs/${runId}`);
          const messages = await getJson(runtime.url, `/runs/${runId}/messages?limit=50`);
          const evidence = await getJson(runtime.url, `/runs/${runId}/evidence`);
          expect(parent).toMatchObject({ status: 'completed', evidenceIds: [] });
          expect(parent.childRunIds).toHaveLength(1);
          expect(JSON.stringify(messages)).not.toContain('healthy');
          expect(JSON.stringify(messages)).not.toContain('正常');
          expect(evidence.items).toEqual([]);
        } finally {
          await runtime.close();
        }
      }
    } finally {
      await schemaDrift.close();
      await timeout.close();
    }
  }, 30_000);

  it('isolates two parent Runs and their child evidence in one Web runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-web-isolation-'));
    roots.push(root);
    const end = Math.floor(Date.parse('2026-10-02T12:34:56.789Z') / 1_000);
    const start = end - 300;
    const mcp = await startSettlementMcpServer({
      query: (signal) => {
        signal.throwIfAborted();
        return Promise.resolve({
          status: 'available' as const,
          start,
          end,
          counts: { total: 100, failed: 15 },
          raw: { data: { isolationMarker: 'private-isolation-raw' } },
        });
      },
    }, { port: 0 });
    const parentA = 'web-isolation-a';
    const parentB = 'web-isolation-b';
    const parentToolA = 'metrics-parent-a';
    const parentToolB = 'metrics-parent-b';
    const metricToolA = 'metrics-tool-a';
    const metricToolB = 'metrics-tool-b';
    const childA = stableSourceChildRunId('metrics', parentA, parentToolA);
    const childB = stableSourceChildRunId('metrics', parentB, parentToolB);
    const evidenceA = stableMetricEvidenceId(childA, metricToolA);
    const evidenceB = stableMetricEvidenceId(childB, metricToolB);
    const runtime = await startAgentWebRuntime({
      dataDirectory: root,
      workspaceRoots: [root],
      model: new ScriptedModel([
        { toolCalls: [{ id: parentToolA, name: 'metrics_subagent', input: metricsRequest(start, end) }] },
        { text: 'A 完成。', toolCalls: [] },
        { toolCalls: [{ id: parentToolB, name: 'metrics_subagent', input: metricsRequest(start, end) }] },
        { text: 'B 完成。', toolCalls: [] },
      ]),
      clock: fixedClock(),
      metrics: { profileId: 'simulation', mcpUrl: mcp.url, childModel: new ScriptedModel([
        { toolCalls: [{ id: metricToolA, name: 'metrics.settlement', input: { service: 'checkout' } }] },
        { toolCalls: [{ id: 'source-report-a', name: 'source_report', input: sourceReportInput(evidenceA) }] },
        { text: 'A 来源报告已提交。', toolCalls: [] },
        { toolCalls: [{ id: metricToolB, name: 'metrics.settlement', input: { service: 'checkout' } }] },
        { toolCalls: [{ id: 'source-report-b', name: 'source_report', input: sourceReportInput(evidenceB) }] },
        { text: 'B 来源报告已提交。', toolCalls: [] },
      ]) },
      port: 0,
    });
    try {
      await startRun(runtime.url, parentA);
      await waitForStatus(runtime.url, parentA, 'completed');
      await startRun(runtime.url, parentB);
      await waitForStatus(runtime.url, parentB, 'completed');
      const detailA = await getJson(runtime.url, `/runs/${parentA}`);
      const detailB = await getJson(runtime.url, `/runs/${parentB}`);
      const messagesA = await getJson(runtime.url, `/runs/${parentA}/messages?limit=50`);
      const messagesB = await getJson(runtime.url, `/runs/${parentB}/messages?limit=50`);
      expect(detailA).toMatchObject({ childRunIds: [childA], evidenceIds: [evidenceA] });
      expect(detailB).toMatchObject({ childRunIds: [childB], evidenceIds: [evidenceB] });
      expect(childA).not.toBe(childB);
      expect(evidenceA).not.toBe(evidenceB);
      expect(JSON.stringify(messagesA)).not.toContain(evidenceB);
      expect(JSON.stringify(messagesA)).not.toContain('private-isolation-raw');
      expect(JSON.stringify(messagesB)).not.toContain(evidenceA);
      expect(JSON.stringify(messagesB)).not.toContain('private-isolation-raw');
    } finally {
      await runtime.close();
      await mcp.close();
    }
  });

  it('returns partial after child retry/resume without duplicating metric capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-web-partial-'));
    roots.push(root);
    const end = Math.floor(Date.parse('2026-10-02T12:34:56.789Z') / 1_000);
    const start = end - 300;
    let sourceCalls = 0;
    const mcp = await startSettlementMcpServer({
      query: (signal) => {
        signal.throwIfAborted();
        sourceCalls += 1;
        return Promise.resolve({
          status: 'available' as const,
          start,
          end,
          counts: { total: 100, failed: 15 },
          raw: { data: { partialMarker: 'private-partial-raw' } },
        });
      },
    }, { port: 0 });
    const runId = 'web-partial-run';
    const parentToolCallId = 'metrics-partial-parent-call';
    const metricToolCallId = 'metrics-partial-tool-call';
    const childRunId = stableSourceChildRunId('metrics', runId, parentToolCallId);
    const evidenceId = stableMetricEvidenceId(childRunId, metricToolCallId);
    const runtime = await startAgentWebRuntime({
      dataDirectory: root,
      workspaceRoots: [root],
      model: new ScriptedModel([
        { toolCalls: [{ id: parentToolCallId, name: 'metrics_subagent', input: metricsRequest(start, end) }] },
        { text: '仅完成部分指标取证。', toolCalls: [] },
      ]),
      clock: fixedClock(),
      metrics: { profileId: 'simulation', mcpUrl: mcp.url, childModel: new FailAfterMetricModel(metricToolCallId) },
      port: 0,
    });
    try {
      await startRun(runtime.url, runId);
      await waitForStatus(runtime.url, runId, 'completed');
      const parent = await getJson(runtime.url, `/runs/${runId}`);
      const child = await getJson(runtime.url, `/runs/${encodeURIComponent(childRunId)}`);
      const evidence = await getJson(runtime.url, `/runs/${encodeURIComponent(childRunId)}/evidence?limit=50`);
      expect(parent.evidenceIds).toEqual([evidenceId]);
      expect(child).toMatchObject({ runId: childRunId, evidenceIds: [evidenceId] });
      expect(evidence.items).toHaveLength(1);
      expect(JSON.stringify(evidence)).not.toContain('private-partial-raw');
      expect(sourceCalls).toBe(1);
    } finally {
      await runtime.close();
      await mcp.close();
    }
  });
});

class RecordingObservability implements Observability {
  public readonly starts: SpanStart[] = [];
  public readonly outputs: unknown[] = [];

  public startSpan(input: SpanStart): SpanHandle {
    this.starts.push(input);
    return {
      setAttributes: () => undefined,
      end: (output) => { this.outputs.push(output); },
      fail: (error) => { this.outputs.push(error); },
    };
  }

  public flush(): Promise<void> {
    return Promise.resolve();
  }
}

class FailAfterMetricModel implements ChatModel {
  private calls = 0;

  public constructor(private readonly metricToolCallId: string) {}

  public async *stream(
    _messages: AgentMessage[],
    _tools: Tool[],
    _options: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    void _messages;
    void _tools;
    void _options;
    await Promise.resolve();
    this.calls += 1;
    if (this.calls === 1) {
      const call = { id: this.metricToolCallId, name: 'metrics.settlement', input: { service: 'checkout' } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    throw Object.assign(new Error('transient child model failure'), {
      code: 'MCP_SERVER_ERROR',
      retryable: true,
    });
  }
}

function fixedClock() {
  return { now: () => new Date('2026-10-02T12:34:56.789Z') };
}

function metricsRequest(
  start = Math.floor(Date.parse('2026-10-02T12:29:56.789Z') / 1_000),
  end = Math.floor(Date.parse('2026-10-02T12:34:56.789Z') / 1_000),
): Record<string, unknown> {
  return {
    profileId: 'simulation',
    service: 'checkout',
    start: new Date(start * 1_000).toISOString(),
    end: new Date(end * 1_000).toISOString(),
    question: '结算失败率是否升高？',
  };
}

function sourceReportInput(evidenceId: string): Record<string, unknown> {
  return {
    summary: '指标取证完成。',
    findings: [{ kind: 'observation', statement: '结算失败率超过阈值。', evidenceIds: [evidenceId] }],
    businessTraceIds: [],
    missingEvidence: [],
  };
}

async function startSchemaDriftMcpServer(): Promise<{ url: string; close(): Promise<void> }> {
  const mcp = new Server({ name: 'schema-drift-source', version: '1.0.0' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{
    name: 'get_settlement_metrics',
    description: 'Schema drift fixture.',
    inputSchema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'], additionalProperties: false },
  }] }));
  mcp.setRequestHandler(CallToolRequestSchema, () => ({ content: [], structuredContent: { status: 'available' } }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  await mcp.connect(transport as Transport);
  const http = createServer((request, response) => {
    void handleMcpRequest(transport, request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.removeListener('error', reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Schema drift fixture failed to listen.');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close(): Promise<void> {
      await mcp.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function handleMcpRequest(
  transport: StreamableHTTPServerTransport,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  await transport.handleRequest(request, response, body);
}

async function startRun(url: string, runId: string): Promise<void> {
  const response = await fetch(`${url}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, profileId: 'simulation', message: '检查结算' }),
  });
  expect(response.status).toBe(202);
}

async function waitForStatus(url: string, runId: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${url}/runs/${encodeURIComponent(runId)}`);
    if (response.status === 200) {
      const body = await response.json() as { status?: string };
      if (body.status === status) return;
      if (body.status === 'failed') throw new Error(`Run failed while waiting for ${status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run did not reach ${status}.`);
}

async function getJson(url: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}${path}`);
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

async function readSse(url: string, runId: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const response = await fetch(`${url}/runs/${encodeURIComponent(runId)}/events`, { signal: controller.signal });
  if (response.body === null) throw new Error('SSE response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      body += decoder.decode(next.value, { stream: true });
      if (body.includes('event: RUN_FINISHED')) {
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    controller.abort();
  }
  return { status: response.status, body };
}

function stableMetricEvidenceId(runId: string, toolCallId: string): string {
  const digest = createHash('sha256').update(runId + '\u0000' + toolCallId).digest('hex').slice(0, 32);
  return `metric-evidence-${digest}`;
}
