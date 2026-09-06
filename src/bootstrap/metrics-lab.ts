import { PrometheusSettlementSource } from '../infrastructure/prometheus/settlement-source.js';
import { startSettlementMcpServer } from '../infrastructure/mcp/settlement-server.js';
import { startSimulatorAdminServer } from '../infrastructure/simulator/admin-server.js';
import { startSimulatorMetricsServer } from '../infrastructure/simulator/http-server.js';
import { SettlementSimulator, type SettlementScenario } from '../infrastructure/simulator/settlement-simulator.js';

export interface MetricsLabOptions {
  prometheusUrl: string;
  metricsHost?: string;
  metricsPort?: number;
  adminPort?: number;
  mcpPort?: number;
  initialScenario?: SettlementScenario;
}

/** Owns local lab lifecycle. Prometheus itself remains owned by Compose. */
export async function startMetricsLab(options: MetricsLabOptions) {
  const simulator = new SettlementSimulator();
  simulator.select(options.initialScenario ?? 'normal');
  const metrics = await startSimulatorMetricsServer(simulator, { host: options.metricsHost ?? '0.0.0.0', port: options.metricsPort ?? 19108 });
  let admin: Awaited<ReturnType<typeof startSimulatorAdminServer>> | undefined;
  let mcp: Awaited<ReturnType<typeof startSettlementMcpServer>> | undefined;
  try {
    admin = await startSimulatorAdminServer(simulator, { port: options.adminPort ?? 19109 });
    const source = new PrometheusSettlementSource({ url: options.prometheusUrl });
    mcp = await startSettlementMcpServer(source, { port: options.mcpPort ?? 19110 });
  } catch (error) {
    await admin?.close();
    await metrics.close();
    throw error;
  }
  const publicMetricsHost = options.metricsHost === '127.0.0.1' ? '127.0.0.1' : 'localhost';
  return {
    metricsUrl: `http://${publicMetricsHost}:${metrics.port}`,
    adminUrl: `http://127.0.0.1:${admin.port}`,
    mcpUrl: mcp.url,
    async close(): Promise<void> {
      await Promise.allSettled([mcp.close(), admin.close(), metrics.close()]);
    },
  };
}
