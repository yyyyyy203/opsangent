import { describe, expect, it } from 'vitest';
import { SettlementSimulator, type SettlementScenario } from '../src/infrastructure/simulator/settlement-simulator.js';
import { startSimulatorMetricsServer } from '../src/infrastructure/simulator/http-server.js';
import { PrometheusSettlementSource } from '../src/infrastructure/prometheus/settlement-source.js';
import { assessSettlementMetrics, settlementLabRule } from '../src/profiles/settlement.js';
import { startSettlementMcpServer } from '../src/infrastructure/mcp/settlement-server.js';
import { HttpMcpConnection } from '../src/infrastructure/mcp/http-connection.js';
import { bindSettlementEvidenceTool } from '../src/bootstrap/settlement-evidence-tool.js';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { InMemoryEvidenceStore } from '../src/storage/in-memory-evidence-store.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';

/** Opt-in: requires the repository's dedicated Compose service on loopback port 19090. */
describe.skipIf(process.env.AGENTOPS_REAL_PROMETHEUS !== '1')('real Prometheus acceptance', () => {
  it('scrapes three snapshots and persists evidence through real MCP HTTP and Harness', async () => {
    const simulator = new SettlementSimulator();
    const server = await startSimulatorMetricsServer(simulator, { host: '0.0.0.0', port: 19108 });
    const source = new PrometheusSettlementSource({ url: 'http://127.0.0.1:19090' });
    const cases: { scenario: SettlementScenario; total: number; failed: number; status: string }[] = [
      { scenario: 'settlement_failure', total: 100, failed: 15, status: 'breached' },
      { scenario: 'normal', total: 100, failed: 0, status: 'healthy' },
      { scenario: 'low_sample', total: 10, failed: 8, status: 'insufficient_data' },
    ];
    const signal = AbortSignal.timeout(45000);
    let mcp: Awaited<ReturnType<typeof startSettlementMcpServer>> | undefined;
    let connection: HttpMcpConnection | undefined;
    try {
      mcp = await startSettlementMcpServer(source, { port: 0 });
      connection = new HttpMcpConnection({ url: mcp.url });
      await connection.connect(signal);
      const evidence = new InMemoryEvidenceStore();
      const tool = await bindSettlementEvidenceTool({ connection, evidence, signal,
        executor: new ResilientExecutor(new SourceCircuitBreaker()) });
      for (const fixture of cases) {
        simulator.select(fixture.scenario);
        let verified = false;
        for (let attempt = 0; attempt < 12; attempt++) {
          const result = await source.query(signal);
          if (result.status === 'available' && result.counts.total === fixture.total && result.counts.failed === fixture.failed) {
            expect(assessSettlementMetrics(result.counts, settlementLabRule).status).toBe(fixture.status);
            expect(result.end - result.start).toBe(300);
            verified = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        expect(verified, `real scrape for ${fixture.scenario}`).toBe(true);
        const runtime = createInspectionRuntime({ model: new ScriptedModel([
          { toolCalls: [{ id: 'query-1', name: tool.name, input: { service: 'checkout' } }] }, { toolCalls: [] },
        ]), workspaceRoots: [], tools: [tool], allowedToolNames: [tool.name] });
        const run = await runtime.agent.reply({ message: 'inspect', profileId: 'simulation', signal });
        const context = await runtime.checkpoints.load(run.runId);
        const block = context?.messages.flatMap((message) => message.blocks).find((item) => item.type === 'tool_result');
        expect(block?.type === 'tool_result' && block.result.status).toBe('success');
        const evidenceId = block?.type === 'tool_result' ? block.result.response?.evidenceIds?.[0] : undefined;
        expect(evidenceId).toBeDefined();
        expect(await evidence.get(evidenceId!)).toMatchObject({ runId: run.runId, source: 'metric', summary: {
          status: fixture.status, total: fixture.total, failed: fixture.failed,
        }, raw: { status: 'success', data: { resultType: 'vector' } } });
      }
    } finally { await connection?.close(); await mcp?.close(); await server.close(); }
  }, 50000);
});
