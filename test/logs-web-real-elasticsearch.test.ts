import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import { createLazyElkEvidenceSource } from '../src/bootstrap/lazy-elk-evidence-source.js';
import { startLogsLab } from '../src/bootstrap/logs-lab.js';
import { createElasticsearchLogSource } from '../src/infrastructure/elk/elasticsearch-log-source.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';
import type {
  AgentMessage,
  ChatModel,
  ModelCallOptions,
  ModelResponse,
  ModelStreamEvent,
  Tool,
} from '../src/contracts/index.js';
import type { SettlementScenario } from '../src/infrastructure/simulator/settlement-simulator.js';

const enabled = process.env.AGENTOPS_REAL_LOGS_WEB === '1';
const elasticsearchUrl = 'http://127.0.0.1:19200';
const prometheusUrl = 'http://127.0.0.1:19290';
const cursorSecret = 'agentops-real-logs-cursor-secret-0123456789';

/** Opt-in only: requires the isolated agentops-logs Compose project. No paid model is used. */
describe.skipIf(!enabled)('real Elasticsearch Logs Web acceptance', () => {
  it('runs normal, settlement failure, and low-sample scenarios through both Web Subagents, then restarts', async () => {
  const cases: readonly {
      scenario: SettlementScenario;
      total: number;
      failed: number;
      exceptionCount: number;
      metricStatus: 'healthy' | 'breached' | 'insufficient_data';
    }[] = [
      { scenario: 'normal', total: 100, failed: 0, exceptionCount: 0, metricStatus: 'healthy' },
      { scenario: 'settlement_failure', total: 100, failed: 15, exceptionCount: 15, metricStatus: 'breached' },
      { scenario: 'low_sample', total: 10, failed: 8, exceptionCount: 8, metricStatus: 'insufficient_data' },
    ];

    for (const fixture of cases) {
      const lab = await startLogsLab({
        elasticsearchUrl,
        prometheusUrl,
        cursorSecret,
        initialScenario: fixture.scenario,
        metricsPort: 19_208,
        metricsMcpPort: 0,
        logsMcpPort: 0,
        statusPort: 0,
      });
      const root = await mkdtemp(join(tmpdir(), `agentops-real-logs-${fixture.scenario}-`));
      let runtime: Awaited<ReturnType<typeof startAgentWebRuntime>> | undefined;
      let restarted: Awaited<ReturnType<typeof startAgentWebRuntime>> | undefined;
      try {
        const window = labWindow(lab);
        const models = createModels(window);
        runtime = await createWeb(root, lab.metricsMcpUrl, lab.logsMcpUrl, window, models);
        const runId = `real-logs-${fixture.scenario}`;
        await startRun(runtime.url, runId);
        await waitForStatus(runtime.url, runId, 'completed');

        const detail = await getJson<PublicRunDetail>(runtime.url, `/runs/${runId}`);
        expect(detail).toMatchObject({ status: 'completed', childRunIds: [expect.any(String), expect.any(String)] });
        const children = await Promise.all(detail.childRunIds.map(async (childRunId) => {
          const child = await getJson<PublicRunDetail>(runtime!.url, `/runs/${encodeURIComponent(childRunId)}`);
          const evidence = await getJson<PublicEvidencePage>(runtime!.url, `/runs/${encodeURIComponent(childRunId)}/evidence`);
          const messages = await getJson<unknown>(runtime!.url, `/runs/${encodeURIComponent(childRunId)}/messages?limit=50`);
          return { child, evidence, messages };
        }));
        expect(detail.evidenceIds).toHaveLength(2);
        const metricsChild = children.find(({ evidence }) => evidence.items.some((item) => item.source === 'metric'));
        const logsChild = children.find(({ evidence }) => evidence.items.some((item) => item.source === 'log'));
        expect(metricsChild?.child).toMatchObject({ status: 'completed', parentRunId: runId });
        expect(logsChild?.child).toMatchObject({ status: 'completed', parentRunId: runId });
        expect(metricsChild?.evidence.items).toHaveLength(1);
        expect(logsChild?.evidence.items).toHaveLength(1);
        expect(metricsChild?.evidence.items[0]).toMatchObject({ source: 'metric', retrievable: false });
        expect(logsChild?.evidence.items[0]).toMatchObject({ source: 'log', state: 'committed', retrievable: false });
        expect(logsChild?.evidence.items[0]?.recordCount).toBe(fixture.total);
        expect(models.logs.observedAggregates).toHaveLength(1);
        expect(models.logs.observedAggregates[0]).toMatchObject({
          recordCount: fixture.total,
          exceptionSignatures: fixture.exceptionCount === 0
            ? []
            : [{ value: 'SQLTimeoutException', count: fixture.exceptionCount }],
        });
        expect(metricsChild?.evidence.items[0]?.summary).toMatchObject({
          status: fixture.metricStatus,
          total: fixture.total,
          failed: fixture.failed,
        });

        const parentMessages = await getJson<unknown>(runtime.url, `/runs/${runId}/messages?limit=50`);
        const serialized = JSON.stringify({ detail, children, parentMessages });
        expect(serialized).not.toContain('Checkout settled');
        expect(serialized).not.toContain('SQLTimeoutException');
        expect(serialized).not.toContain('pit-');
        expect(serialized).not.toContain('RAW_LOG_CANARY');
        const beforeRestart = detail.usage;
        const callCounts = [models.parent.calls, models.metrics.calls, models.logs.calls];
        await runtime.close();
        runtime = undefined;

        const restartModels = createModels(window);
        restarted = await createWeb(root, lab.metricsMcpUrl, lab.logsMcpUrl, window, restartModels);
        const restored = await getJson<PublicRunDetail>(restarted.url, `/runs/${runId}`);
        expect(restored.usage).toEqual(beforeRestart);
        expect(restored.evidenceIds).toEqual(detail.evidenceIds);
        expect(restored.childRunIds).toEqual(detail.childRunIds);
        expect([models.parent.calls, models.metrics.calls, models.logs.calls]).toEqual(callCounts);
        expect([restartModels.parent.calls, restartModels.metrics.calls, restartModels.logs.calls]).toEqual([0, 0, 0]);
        for (const childRunId of restored.childRunIds) {
          const evidence = await getJson<PublicEvidencePage>(restarted.url, `/runs/${encodeURIComponent(childRunId)}/evidence`);
          expect(evidence.items).toHaveLength(1);
          expect(evidence.items[0]?.retrievable).toBe(false);
        }
      } finally {
        await restarted?.close();
        await runtime?.close();
        await lab.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 180_000);

  it('reads paginated log evidence through the real HTTP MCP and Elasticsearch endpoints', async () => {
    const lab = await startLogsLab({
      elasticsearchUrl,
      prometheusUrl,
      cursorSecret,
      initialScenario: 'normal',
      metricsPort: 19_208,
      metricsMcpPort: 0,
      logsMcpPort: 0,
      statusPort: 0,
    });
    const shutdown: Array<() => Promise<void>> = [];
    const source = createLazyElkEvidenceSource({
      mcpUrl: lab.logsMcpUrl,
      executor: new ResilientExecutor(new SourceCircuitBreaker()),
      now: Date.now,
      registerShutdownHook: (callback) => shutdown.push(callback),
    });
    try {
      const endMs = Date.parse(lab.expiresAt) - 120_000;
      const end = new Date(endMs).toISOString();
      const start = new Date(endMs - 300_000).toISOString();
      let recordCount = 0;
      try {
        for await (const page of source.pages({ service: 'checkout', start, end }, { requestId: 'real-http-mcp-page' })) {
          recordCount += page.records.length;
        }
      } catch (error) {
        throw new Error(`Real Logs MCP page read failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      expect(recordCount).toBe(100);
    } finally {
      await Promise.allSettled(shutdown.map((close) => close()));
      await lab.close();
    }
  }, 90_000);

  it('keeps Metrics usable when the Logs MCP endpoint is offline', async () => {
    const lab = await startLogsLab({
      elasticsearchUrl,
      prometheusUrl,
      cursorSecret,
      initialScenario: 'settlement_failure',
      metricsPort: 19_208,
      metricsMcpPort: 0,
      logsMcpPort: 0,
      statusPort: 0,
    });
    const root = await mkdtemp(join(tmpdir(), 'agentops-real-logs-offline-'));
    let runtime: Awaited<ReturnType<typeof startAgentWebRuntime>> | undefined;
    try {
      const window = labWindow(lab);
      const models = createModels(window);
      runtime = await createWeb(root, lab.metricsMcpUrl, 'http://127.0.0.1:1/mcp', window, models);
      const runId = 'real-logs-offline-metrics-survives';
      await startRun(runtime.url, runId);
      await waitForStatus(runtime.url, runId, 'completed');
      const detail = await getJson<PublicRunDetail>(runtime.url, `/runs/${runId}`);
      expect(detail.evidenceIds).toHaveLength(1);
      const children = await Promise.all(detail.childRunIds.map((childRunId) =>
        getJson<PublicRunDetail>(runtime!.url, `/runs/${encodeURIComponent(childRunId)}`)));
      expect(children.some((child) => child.evidenceIds.length === 1)).toBe(true);
      expect(models.metrics.calls).toBeGreaterThan(0);
      expect(models.logs.calls).toBeGreaterThan(0);
    } finally {
      await runtime?.close();
      await lab.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('does not reopen a real Elasticsearch PIT after the PIT is explicitly expired', async () => {
    const lab = await startLogsLab({
      elasticsearchUrl,
      prometheusUrl,
      cursorSecret,
      initialScenario: 'normal',
      metricsPort: 19_208,
      metricsMcpPort: 0,
      logsMcpPort: 0,
      statusPort: 0,
    });
    let nowMs = Date.parse(lab.expiresAt) - 120_000;
    let openedPits = 0;
    let pitId: string | undefined;
    const trackedFetch: typeof globalThis.fetch = async (input, init) => {
      const target = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      const response = await fetch(input, init);
      if (target.pathname.endsWith('/_pit') && init?.method === 'POST') {
        openedPits += 1;
        const body = await response.clone().json() as { id?: unknown };
        if (typeof body.id === 'string') pitId = body.id;
      }
      return response;
    };
    const snapshotEndMs = nowMs;
    nowMs = snapshotEndMs;
    const source = createElasticsearchLogSource({
      url: elasticsearchUrl,
      index: `agentops-lab-logs-${lab.snapshotId}`,
      cursorSecret,
      fetch: trackedFetch,
      now: () => nowMs,
      onCleanupFailure: () => undefined,
    });
    try {
      const end = new Date(snapshotEndMs).toISOString();
      const start = new Date(snapshotEndMs - 300_000).toISOString();
      const first = await source.searchPage({ service: 'checkout', start, end, requestId: 'real-pit-expiry-check' }, new AbortController().signal);
      if (first.status !== 'available' || first.nextCursor === undefined || first.records.length === 0 || pitId === undefined) {
        throw new Error('real Elasticsearch did not return a paginated PIT result');
      }
      const expired = await fetch(`${elasticsearchUrl}/_pit`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: pitId }),
      });
      expect(expired.ok).toBe(true);
      const second = await source.searchPage({
        service: 'checkout', start, end, sourceSnapshotId: first.sourceSnapshotId, cursor: first.nextCursor,
      }, new AbortController().signal);
      expect(second).toMatchObject({ status: 'source_error', code: 'UNAVAILABLE', reason: 'snapshot_expired' });
      expect(openedPits).toBe(1);
    } finally {
      await source.close();
      await lab.close();
    }
  }, 90_000);
});

interface CurrentWindow { start: string; end: string }
interface Models { parent: ParentModel; metrics: MetricsModel; logs: LogsModel }
interface PublicRunDetail {
  runId: string;
  status: string;
  evidenceIds: readonly string[];
  childRunIds: readonly string[];
  usage?: unknown;
}
interface PublicEvidencePage {
  items: readonly {
    evidenceId: string;
    source: string;
    state: string;
    summary: Record<string, unknown>;
    recordCount?: number;
    retrievable: boolean;
  }[];
}

function labWindow(lab: { expiresAt: string }): CurrentWindow {
  const endMs = Date.parse(lab.expiresAt) - 120_000;
  return { start: new Date(endMs - 300_000).toISOString(), end: new Date(endMs).toISOString() };
}

function createModels(window: CurrentWindow): Models {
  return { parent: new ParentModel(window), metrics: new MetricsModel(), logs: new LogsModel(window) };
}

function createWeb(root: string, metricsMcpUrl: string, logsMcpUrl: string, window: CurrentWindow, models: Models) {
  void window;
  return startAgentWebRuntime({
    dataDirectory: root,
    workspaceRoots: [root],
    model: models.parent,
    metrics: { profileId: 'simulation', mcpUrl: metricsMcpUrl, childModel: models.metrics },
    logs: { profileId: 'simulation', mcpUrl: logsMcpUrl, childModel: models.logs, cursorSecret },
    port: 0,
  });
}

class ParentModel implements ChatModel {
  public calls = 0;
  public constructor(private readonly window: CurrentWindow) {}
  public async *stream(messages: AgentMessage[], _tools: Tool[], options: ModelCallOptions): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    this.calls += 1;
    await Promise.resolve();
    if (!hasToolResultNamed(messages, 'metrics_subagent')) {
      const call = { id: `metrics-parent-${options.runId}`, name: 'metrics_subagent', input: {
        profileId: 'simulation', service: 'checkout', ...this.window, question: '检查结算指标',
      } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    if (!hasToolResultNamed(messages, 'logs_subagent')) {
      const call = { id: `logs-parent-${options.runId}`, name: 'logs_subagent', input: {
        profileId: 'simulation', service: 'checkout', ...this.window, question: '调查结算日志',
      } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    const text = '指标与日志来源均已分别核验；日志事实不等于已确认根因。';
    yield { type: 'text_delta', delta: text };
    return { text, toolCalls: [] };
  }
}

class MetricsModel implements ChatModel {
  public calls = 0;
  public async *stream(messages: AgentMessage[], _tools: Tool[], options: ModelCallOptions): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    this.calls += 1;
    await Promise.resolve();
    if (!hasToolResultNamed(messages, 'metrics.settlement')) {
      const call = { id: `metrics-query-${options.runId}`, name: 'metrics.settlement', input: { service: 'checkout' } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    const evidenceId = findEvidenceId(messages, 'metrics.settlement');
    if (evidenceId !== undefined && !hasToolResultNamed(messages, 'source_report')) {
      const call = { id: `metrics-report-${options.runId}`, name: 'source_report', input: {
        summary: '指标事实已核验。',
        findings: [{ kind: 'observation', statement: '结算窗口指标已核验。', evidenceIds: [evidenceId] }],
        businessTraceIds: [], missingEvidence: [],
      } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    const text = '指标取证完成。';
    yield { type: 'text_delta', delta: text };
    return { text, toolCalls: [] };
  }
}

class LogsModel implements ChatModel {
  public calls = 0;
  public readonly observedAggregates: Array<{
    evidenceId: string;
    recordCount: number;
    exceptionSignatures: Array<{ value: string; count: number }>;
  }> = [];
  private readonly observedAggregateIds = new Set<string>();

  public constructor(private readonly window: CurrentWindow) {}
  public async *stream(messages: AgentMessage[], _tools: Tool[], options: ModelCallOptions): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    this.calls += 1;
    await Promise.resolve();
    const aggregate = findJsonValue(messages, 'logs.aggregate_evidence');
    if (isRecord(aggregate) && typeof aggregate.evidenceId === 'string' && !this.observedAggregateIds.has(aggregate.evidenceId)) {
      this.observedAggregateIds.add(aggregate.evidenceId);
      this.observedAggregates.push({
        evidenceId: aggregate.evidenceId,
        recordCount: typeof aggregate.recordCount === 'number' ? aggregate.recordCount : -1,
        exceptionSignatures: Array.isArray(aggregate.exceptionSignatures)
          ? aggregate.exceptionSignatures.filter((item): item is { value: string; count: number } => isRecord(item)
            && typeof item.value === 'string' && typeof item.count === 'number')
          : [],
      });
    }
    if (!hasToolResultNamed(messages, 'logs.capture')) {
      const call = { id: `logs-capture-${options.runId}`, name: 'logs.capture', input: { service: 'checkout', ...this.window } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    const evidenceId = findEvidenceId(messages, 'logs.capture');
    if (evidenceId === undefined) {
      const text = '日志来源未返回可验证证据。';
      yield { type: 'text_delta', delta: text };
      return { text, toolCalls: [] };
    }
    if (!hasToolResultNamed(messages, 'logs.aggregate_evidence')) {
      const call = { id: `logs-aggregate-${options.runId}`, name: 'logs.aggregate_evidence', input: { evidenceId } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    if (!hasToolResultNamed(messages, 'source_report')) {
      const capture = findJsonValue(messages, 'logs.capture');
      const traceIds = isRecord(capture) && Array.isArray(capture.traceIds)
        ? capture.traceIds.filter((value): value is string => typeof value === 'string') : [];
      const call = { id: `logs-report-${options.runId}`, name: 'source_report', input: {
        summary: '日志采集与聚合已完成。',
        findings: [{ kind: 'observation', statement: '已采集并聚合日志证据。', evidenceIds: [evidenceId] }],
        businessTraceIds: traceIds,
        missingEvidence: [],
      } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    const text = '日志来源调查完成。';
    yield { type: 'text_delta', delta: text };
    return { text, toolCalls: [] };
  }
}

async function startRun(url: string, runId: string): Promise<void> {
  const response = await fetch(`${url}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, profileId: 'simulation', message: '检查结算失败是否与日志异常相关' }),
  });
  expect(response.status).toBe(202);
}

async function waitForStatus(url: string, runId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const run = await getJson<PublicRunDetail>(url, `/runs/${encodeURIComponent(runId)}`);
    if (run.status === expected) return;
    if (['failed', 'cancelled'].includes(run.status)) throw new Error(`Web Run ended as ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Web Run ${runId} did not reach ${expected}`);
}

async function getJson<T>(url: string, path: string): Promise<T> {
  const response = await fetch(`${url}${path}`);
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function hasToolResultNamed(messages: readonly AgentMessage[], name: string): boolean {
  return messages.some((message) => message.blocks.some((block) => block.type === 'tool_result'
    && block.result.toolName === name));
}

function findEvidenceId(messages: readonly AgentMessage[], toolName: string): string | undefined {
  const response = findToolResponse(messages, toolName);
  return response?.evidenceIds?.[0]
    ?? response?.blocks.find((block) => block.type === 'evidence_ref')?.evidenceId;
}

function findJsonValue(messages: readonly AgentMessage[], toolName: string): unknown {
  return findToolResponse(messages, toolName)?.blocks.find((block) => block.type === 'json')?.value;
}

function findToolResponse(messages: readonly AgentMessage[], toolName: string) {
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result' && block.result.toolName === toolName) return block.result.response;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
