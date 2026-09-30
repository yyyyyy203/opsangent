import { describe, expect, it } from 'vitest';
import { SettlementSimulator, type SettlementScenario } from '../src/infrastructure/simulator/settlement-simulator.js';
import { startSimulatorMetricsServer } from '../src/infrastructure/simulator/http-server.js';
import { PrometheusSettlementSource } from '../src/infrastructure/prometheus/settlement-source.js';
import { startSettlementMcpServer } from '../src/infrastructure/mcp/settlement-server.js';
import { HttpMcpConnection } from '../src/infrastructure/mcp/http-connection.js';
import { bindSettlementEvidenceTool } from '../src/bootstrap/settlement-evidence-tool.js';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { createMetricsSubagentTool } from '../src/bootstrap/metrics-subagent.js';
import { settlementMetricsLabProfile } from '../src/profiles/settlement.js';
import { InMemoryEvidenceStore } from '../src/storage/in-memory-evidence-store.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';
import type { SourceChildAgentFactory } from '../src/application/source-subagent-runner.js';

/** Opt-in: requires the repository's dedicated Compose service on loopback port 19090. */
describe.skipIf(process.env.AGENTOPS_REAL_PROMETHEUS !== '1')('real Prometheus acceptance', () => {
  it('runs all simulator cases through real Prometheus, MCP HTTP and Metrics Subagent', async () => {
    const simulator = new SettlementSimulator();
    const server = await startSimulatorMetricsServer(simulator, { host: '0.0.0.0', port: 19108 });
    const source = new PrometheusSettlementSource({ url: 'http://127.0.0.1:19090' });
    const cases: readonly {
      scenario: SettlementScenario;
      total: number;
      failed: number;
      status: 'healthy' | 'breached' | 'insufficient_data';
      rate: string;
    }[] = [
      { scenario: 'settlement_failure', total: 100, failed: 15, status: 'breached', rate: '15.00%' },
      { scenario: 'normal', total: 100, failed: 0, status: 'healthy', rate: '0.00%' },
      { scenario: 'low_sample', total: 10, failed: 8, status: 'insufficient_data', rate: '80.00%' },
    ];
    const signal = AbortSignal.timeout(45000);
    let mcp: Awaited<ReturnType<typeof startSettlementMcpServer>> | undefined;
    let connection: HttpMcpConnection | undefined;
    let currentEvidenceId = '';
    try {
      mcp = await startSettlementMcpServer(source, { port: 0 });
      connection = new HttpMcpConnection({ url: mcp.url });
      await connection.connect(signal);
      const evidence = new InMemoryEvidenceStore();
      const settlementTool = await bindSettlementEvidenceTool({
        connection,
        evidence,
        signal,
        id: () => currentEvidenceId,
        executor: new ResilientExecutor(new SourceCircuitBreaker()),
      });

      for (const fixture of cases) {
        currentEvidenceId = `real-metric-evidence-${fixture.scenario}`;
        simulator.select(fixture.scenario);
        const snapshot = await waitForRealSnapshot(source, fixture, signal);
        const start = new Date(snapshot.start * 1_000).toISOString();
        const end = new Date(snapshot.end * 1_000).toISOString();
        const childToolNames: string[][] = [];
        const childRuntimes: Array<ReturnType<typeof createInspectionRuntime>> = [];
        let parent: ReturnType<typeof createInspectionRuntime> | undefined;

        try {
          const childFactory: SourceChildAgentFactory = {
            create: (input) => {
              childToolNames.push(input.tools.map((tool) => tool.name));
              const child = createInspectionRuntime({
                model: new ScriptedModel([
                  { toolCalls: [{ id: `metric-${fixture.scenario}`, name: 'metrics.settlement', input: { service: 'checkout' } }] },
                  { toolCalls: [{ id: `report-${fixture.scenario}`, name: 'source_report', input: {
                    summary: '模型声称失败率 99%，数据库是根因 raw-only-marker',
                    findings: [{ kind: 'inference', statement: '数据库是根因 raw-only-marker', evidenceIds: [currentEvidenceId] }],
                    businessTraceIds: [],
                    missingEvidence: [],
                  } }] },
                  { text: '完成', toolCalls: [] },
                ]),
                workspaceRoots: [],
                tools: [...input.tools],
                allowedToolNames: input.tools.map((tool) => tool.name),
              });
              childRuntimes.push(child);
              return child.agent;
            },
          };

          parent = createInspectionRuntime({
            model: new ScriptedModel([
              { toolCalls: [{ id: `parent-${fixture.scenario}`, name: 'metrics_subagent', input: {
                profileId: 'simulation',
                service: 'checkout',
                start,
                end,
                question: '结算失败率是否升高？',
              } }] },
              { text: '完成', toolCalls: [] },
            ]),
            workspaceRoots: [],
            toolFactories: [
              (ports) => [createMetricsSubagentTool({
                profile: settlementMetricsLabProfile,
                settlementTool,
                childAgentFactory: childFactory,
                clock: ports.clock,
                lifecycle: { ...ports.events, ids: ports.ids },
              })],
            ],
            allowedToolNames: ['metrics_subagent'],
          });

          expect(parent.toolkit.list().map((tool) => tool.name)).toEqual(['metrics_subagent']);
          const result = await parent.agent.reply({ message: '检查结算', profileId: 'simulation', signal });
          expect(result.status).toBe('completed');
          expect(childToolNames).toEqual([['metrics.settlement', 'source_report']]);

          const context = await parent.checkpoints.load(result.runId);
          if (context === null) throw new Error('parent checkpoint missing');
          const parentResponse = context.messages
            .flatMap((message) => message.blocks)
            .find((block) => block.type === 'tool_result' && block.result.toolName === 'metrics_subagent');
          if (parentResponse?.type !== 'tool_result' || parentResponse.result.response === undefined) {
            throw new Error('parent metrics ToolResult missing');
          }
          const resultBlock = parentResponse.result.response.blocks.find((block) => block.type === 'json');
          if (resultBlock?.type !== 'json' || !isRecord(resultBlock.value)) throw new Error('parent metrics result missing');
          expect(resultBlock.value).toMatchObject({
            source: 'metrics',
            status: 'complete',
            evidenceIds: [currentEvidenceId],
            missingEvidence: [],
            coverage: 1,
          });
          expect(resultBlock.value.summary).toContain(`失败率 ${fixture.rate}`);
          expect(JSON.stringify(resultBlock.value)).not.toContain('99%');
          expect(JSON.stringify(resultBlock.value)).not.toContain('数据库是根因');
          expect(JSON.stringify(resultBlock.value)).not.toContain('raw-only-marker');

          const finding: unknown = Array.isArray(resultBlock.value.findings)
            ? (resultBlock.value.findings as unknown[])[0] : undefined;
          expect(finding).toMatchObject({ kind: 'observation', evidenceIds: [currentEvidenceId] });
          expect(JSON.stringify(finding)).toContain(`失败率 ${fixture.rate}`);
          expect(JSON.stringify(finding)).not.toContain('raw-only-marker');

          const storedEvidence = await evidence.get(currentEvidenceId);
          if (storedEvidence === null) throw new Error('stored metric evidence missing');
          expect(storedEvidence.source).toBe('metric');
          expect(storedEvidence.summary).toMatchObject({ status: fixture.status, total: fixture.total, failed: fixture.failed });
          expect(storedEvidence.raw).toBeDefined();
          const rawSerialized = JSON.stringify(storedEvidence?.raw) ?? '';
          expect(rawSerialized).toContain('settlement_window_requests');

          const parentContextSerialized = JSON.stringify(context);
          expect(parentContextSerialized).not.toContain('settlement_window_requests');
          expect(parentContextSerialized).not.toContain('raw-only-marker');

          const publicFrames = await readPublicFrames(parent, result.runId);
          const publicSerialized = JSON.stringify(publicFrames);
          expect(publicSerialized).not.toContain('settlement_window_requests');
          expect(publicSerialized).not.toContain('raw-only-marker');

          const allEvents = (await Promise.all((await parent.eventStoreV2.listRunIds?.() ?? []).map(async (runId) =>
            parent!.eventStoreV2.readRun(runId, 0, 500)))).flat();
          const lifecycleEvents = allEvents.filter((event) => event.type.startsWith('SUBAGENT_'));
          expect(lifecycleEvents.map((event) => event.type)).toEqual(['SUBAGENT_STARTED', 'SUBAGENT_COMPLETED']);
          const lifecycleSerialized = JSON.stringify(lifecycleEvents.map((event) => event.payload));
          expect(lifecycleSerialized).not.toContain('settlement_window_requests');
          expect(lifecycleSerialized).not.toContain('raw-only-marker');
        } finally {
          await parent?.close();
          await Promise.all(childRuntimes.map((runtime) => runtime.close()));
        }
      }
    } finally {
      await connection?.close();
      await mcp?.close();
      await server.close();
    }
  }, 50000);
});

async function waitForRealSnapshot(
  source: PrometheusSettlementSource,
  fixture: { scenario: SettlementScenario; total: number; failed: number },
  signal: AbortSignal,
) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await source.query(signal);
    if (result.status === 'available' && result.counts.total === fixture.total && result.counts.failed === fixture.failed) {
      expect(result.end - result.start).toBe(300);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`real scrape for ${fixture.scenario} did not reach the expected snapshot`);
}

async function readPublicFrames(
  runtime: ReturnType<typeof createInspectionRuntime>,
  runId: string,
): Promise<unknown[]> {
  const controller = new AbortController();
  const frames: unknown[] = [];
  try {
    for await (const frame of runtime.eventStreamV2.open({ runId, signal: controller.signal })) {
      frames.push(frame);
      if (frame.event === 'RUN_FINISHED' || frame.event === 'RUN_FAILED' || frame.event === 'RUN_CANCELLED') controller.abort();
    }
  } finally {
    controller.abort();
  }
  return frames;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
