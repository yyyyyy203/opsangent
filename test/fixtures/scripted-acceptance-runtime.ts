import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../../src/contracts/index.js';
import { startAgentWebRuntime } from '../../src/bootstrap/agent-web-runtime.js';
import { createLangSmithEventObservability } from '../../src/bootstrap/langsmith.js';
import { stableSourceChildRunId } from '../../src/bootstrap/source-subagent-identity.js';
import { startLogsMcpServer } from '../../src/infrastructure/mcp/logs-server.js';
import { startSettlementMcpServer } from '../../src/infrastructure/mcp/settlement-server.js';
import { ScriptedModel } from '../../src/model/scripted-model.js';
import type { ChatModel, Clock } from '../../src/contracts/index.js';

const FIXED_NOW = Date.parse('2026-10-04T12:00:00.000Z');
const WINDOW_START = '2026-10-04T11:55:00.000Z';
const WINDOW_END = '2026-10-04T12:00:00.000Z';
const RAW_METRICS_CANARY = 'RAW_METRIC_CANARY_90f2c4';
const RAW_LOGS_CANARY = 'RAW_LOG_CANARY_36b1a8';

export interface ScriptedAcceptanceRuntime {
  readonly web: Awaited<ReturnType<typeof startAgentWebRuntime>>;
  readonly dataDirectory: string;
  readonly exportBodies: string[];
  readonly rawMetricsCanary: string;
  readonly rawLogsCanary: string;
  metricsQueries(): number;
  logsQueries(): number;
  parentModelStarted(): Promise<void>;
  close(): Promise<void>;
}

export async function startScriptedAcceptanceRuntime(input: {
  readonly logs: 'available' | 'unavailable';
  readonly captureWindow?: 'requested' | 'mismatch';
  readonly parentBehavior?: 'normal' | 'wait_for_abort';
}): Promise<ScriptedAcceptanceRuntime> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'agentops-scripted-acceptance-'));
  const clock: Clock = { now: () => new Date(FIXED_NOW) };
  const exportBodies: string[] = [];
  let signalParentModelStarted: () => void = () => undefined;
  const parentModelStarted = new Promise<void>((resolve) => { signalParentModelStarted = resolve; });
  const exportFetch: typeof globalThis.fetch = async (request, init) => {
    const outgoing = new Request(request, init);
    exportBodies.push(await outgoing.text());
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const tracing = createLangSmithEventObservability({
    enabled: true,
    apiKey: 'scripted-acceptance-test-key',
    projectName: 'scripted-acceptance',
    endpoint: 'https://smith.invalid',
  }, { fetch: exportFetch, now: () => FIXED_NOW });

  let metricQueryCount = 0;
  let logQueryCount = 0;
  const metricsMcp = await startSettlementMcpServer({
    query: () => {
      metricQueryCount += 1;
      return Promise.resolve({
        status: 'available',
        start: FIXED_NOW / 1_000 - 300,
        end: FIXED_NOW / 1_000,
        counts: { total: 100, failed: 15 },
        raw: { marker: RAW_METRICS_CANARY },
      });
    },
  }, { port: 0 });

  const logsMcp = await startLogsMcpServer({
    searchPage: () => {
      logQueryCount += 1;
      if (input.logs === 'unavailable') {
        return Promise.resolve({ status: 'source_error', code: 'MCP_AUTH_ERROR' });
      }
      return Promise.resolve({
        status: 'available',
        sourceSnapshotId: 'scripted-snapshot-id',
        records: [{
          timestamp: '2026-10-04T11:59:00.000Z',
          service: 'checkout',
          level: 'ERROR',
          message: RAW_LOGS_CANARY,
        }],
      });
    },
    closeSnapshot: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }, { port: 0 });

  let web: Awaited<ReturnType<typeof startAgentWebRuntime>> | undefined;
  try {
    const parentRunId = input.parentBehavior === 'wait_for_abort'
      ? 'acceptance-runtime-cancelled'
      : input.captureWindow === 'mismatch'
        ? 'acceptance-runtime-window-mismatch'
        : input.logs === 'unavailable'
      ? 'acceptance-runtime-logs-offline'
      : 'acceptance-runtime-parent';
    const metricsParentToolCallId = 'metrics-parent-call';
    const logsParentToolCallId = 'logs-parent-call';
    const metricsChildRunId = stableSourceChildRunId('metrics', parentRunId, metricsParentToolCallId);
    const logsChildRunId = stableSourceChildRunId('logs', parentRunId, logsParentToolCallId);
    const metricEvidenceId = `metric-evidence-${createHash('sha256')
      .update(`${metricsChildRunId}\u0000metrics-query-call`).digest('hex').slice(0, 32)}`;
    const logsCaptureInput = {
      service: 'checkout',
      start: input.captureWindow === 'mismatch' ? '2026-10-04T11:50:00.000Z' : WINDOW_START,
      end: input.captureWindow === 'mismatch' ? '2026-10-04T11:55:00.000Z' : WINDOW_END,
    };
    const logsCaptureKey = `log:${logsChildRunId}:logs-capture-call:${digest(logsCaptureInput)}`;
    const logEvidenceId = `log-evidence-${digest(logsCaptureKey)}`;

    const metricModel = new ScriptedModel([
      { toolCalls: [{ id: 'metrics-query-call', name: 'metrics.settlement', input: { service: 'checkout' } }], usage: { inputTokens: 300, outputTokens: 24 } },
      { toolCalls: [{ id: 'metrics-report-call', name: 'source_report', input: {
        summary: '已完成结算指标取证。',
        findings: [{ kind: 'observation', statement: '结算失败率超过 Profile 阈值。', evidenceIds: [metricEvidenceId] }],
        businessTraceIds: [], missingEvidence: [],
      } }], usage: { inputTokens: 180, outputTokens: 32 } },
      { text: '指标取证完成。', toolCalls: [], usage: { inputTokens: 140, outputTokens: 14 } },
    ]);
    const logsModel = new ScriptedModel(input.logs === 'unavailable' ? [
      { toolCalls: [{ id: 'logs-capture-call', name: 'logs.capture', input: logsCaptureInput }], usage: { inputTokens: 260, outputTokens: 22 } },
      { text: '日志来源当前不可用，无法提供日志证据。', toolCalls: [], usage: { inputTokens: 160, outputTokens: 18 } },
    ] : [
      { toolCalls: [{ id: 'logs-capture-call', name: 'logs.capture', input: logsCaptureInput }], usage: { inputTokens: 260, outputTokens: 22 } },
      { toolCalls: [{ id: 'logs-report-call', name: 'source_report', input: {
        summary: '已完成日志摘要取证。',
        findings: [{ kind: 'observation', statement: '采集到结算服务错误日志摘要。', evidenceIds: [logEvidenceId] }],
        businessTraceIds: [], missingEvidence: [],
      } }], usage: { inputTokens: 180, outputTokens: 32 } },
      { text: '日志取证完成。', toolCalls: [], usage: { inputTokens: 140, outputTokens: 14 } },
    ]);
    const parentModel: ChatModel = input.parentBehavior === 'wait_for_abort' ? {
      async *stream(_messages, _tools, options) {
        signalParentModelStarted();
        yield { type: 'usage', inputTokens: 0, outputTokens: 0 };
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => reject(options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error('SCRIPTED_PARENT_ABORTED'));
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort, { once: true });
        });
        return { text: '', toolCalls: [] };
      },
    } : new ScriptedModel([
      { toolCalls: [
        { id: metricsParentToolCallId, name: 'metrics_subagent', input: {
          profileId: 'simulation', service: 'checkout', start: WINDOW_START, end: WINDOW_END, question: '检查结算失败率',
        } },
        { id: logsParentToolCallId, name: 'logs_subagent', input: {
          profileId: 'simulation', service: 'checkout', start: WINDOW_START, end: WINDOW_END, question: '调查结算相关日志',
        } },
      ], usage: { inputTokens: 500, outputTokens: 64 } },
      { text: '结算指标显示失败率升高；日志来源结果需结合其可用性和时间窗口解释。', toolCalls: [], usage: { inputTokens: 700, outputTokens: 96 } },
    ]);

    web = await startAgentWebRuntime({
      dataDirectory,
      workspaceRoots: [dataDirectory],
      model: parentModel,
      modelIdentity: { provider: 'test-provider', model: 'scripted-parent' },
      metrics: { profileId: 'simulation', mcpUrl: metricsMcp.url, childModel: metricModel,
        modelIdentity: { provider: 'test-provider', model: 'scripted-metrics-child' } },
      logs: { profileId: 'simulation', mcpUrl: logsMcp.url, childModel: logsModel,
        modelIdentity: { provider: 'test-provider', model: 'scripted-logs-child' },
        cursorSecret: 'scripted-acceptance-cursor-secret-0123456789' },
      eventObservability: tracing.eventObservability,
      clock,
      port: 0,
    });
    return {
      web,
      dataDirectory,
      parentModelStarted: () => parentModelStarted,
      exportBodies,
      rawMetricsCanary: RAW_METRICS_CANARY,
      rawLogsCanary: RAW_LOGS_CANARY,
      metricsQueries: () => metricQueryCount,
      logsQueries: () => logQueryCount,
      async close(): Promise<void> {
        try {
          await web?.close();
        } finally {
          await Promise.allSettled([metricsMcp.close(), logsMcp.close()]);
          await rm(dataDirectory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await Promise.allSettled([web?.close(), metricsMcp.close(), logsMcp.close()]);
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
