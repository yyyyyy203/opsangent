import { randomUUID } from 'node:crypto';
import { writeLogFixture } from '../infrastructure/elk/log-fixture-writer.js';
import { createElasticsearchLogSource } from '../infrastructure/elk/elasticsearch-log-source.js';
import { startLogsMcpServer } from '../infrastructure/mcp/logs-server.js';
import { startSettlementMcpServer } from '../infrastructure/mcp/settlement-server.js';
import { PrometheusSettlementSource } from '../infrastructure/prometheus/settlement-source.js';
import { generateScenarioLogs } from '../infrastructure/simulator/log-fixtures.js';
import { startSimulatorMetricsServer } from '../infrastructure/simulator/http-server.js';
import { startLogsLabStatusServer } from '../infrastructure/simulator/logs-lab-status-server.js';
import { SettlementSimulator, type SettlementScenario } from '../infrastructure/simulator/settlement-simulator.js';

interface LogsLabDependencies {
  startMetrics: typeof startSimulatorMetricsServer;
  writeFixture: typeof writeLogFixture;
  startMetricsMcp: typeof startSettlementMcpServer;
  startLogsMcp: typeof startLogsMcpServer;
  startStatus: typeof startLogsLabStatusServer;
}

export interface LogsLabOptions {
  elasticsearchUrl: string;
  prometheusUrl: string;
  cursorSecret: string;
  initialScenario?: SettlementScenario;
  now?: () => number;
  id?: () => string;
  metricsPort?: number;
  statusPort?: number;
  metricsMcpPort?: number;
  logsMcpPort?: number;
  /** Local test seam; production uses the fixed service constructors below. */
  dependencies?: Partial<LogsLabDependencies>;
}

export async function startLogsLab(options: LogsLabOptions): Promise<{
  metricsMcpUrl: string;
  logsMcpUrl: string;
  statusUrl: string;
  scenario: SettlementScenario;
  snapshotId: string;
  expiresAt: string;
  close(): Promise<void>;
}> {
  const now = options.now ?? Date.now;
  const scenario = options.initialScenario ?? 'normal';
  const snapshotId = options.id?.() ?? randomUUID();
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(snapshotId)) throw new TypeError('INVALID_LAB_SNAPSHOT_ID');
  if (Buffer.byteLength(options.cursorSecret, 'utf8') < 32) throw new TypeError('INVALID_LAB_CURSOR_SECRET');
  const simulator = new SettlementSimulator(now);
  simulator.select(scenario);
  const snapshot = simulator.currentSnapshot();
  const expiresAtMs = snapshot.end * 1000 + 120_000;
  const assertFresh = (): void => { if (now() > expiresAtMs) throw new Error('LAB_SNAPSHOT_STALE'); };
  assertFresh();
  const index = `agentops-lab-logs-${snapshotId}`;
  const dependencies = options.dependencies;
  const closers: Array<() => Promise<void>> = [];
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    const failures: unknown[] = [];
    for (const stop of [...closers].reverse()) {
      try { await stop(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'LOGS_LAB_CLOSE_FAILED');
  })();
  try {
    const metrics = await (dependencies?.startMetrics ?? startSimulatorMetricsServer)(simulator, {
      host: '0.0.0.0', port: options.metricsPort ?? 19_208,
    });
    closers.push(() => metrics.close());

    await (dependencies?.writeFixture ?? writeLogFixture)({
      url: options.elasticsearchUrl, index, records: generateScenarioLogs(snapshot, scenario),
      signal: new AbortController().signal,
    });
    assertFresh();

    const metricsSource = new PrometheusSettlementSource({ url: options.prometheusUrl, now });
    const metricsMcp = await (dependencies?.startMetricsMcp ?? startSettlementMcpServer)(metricsSource, {
      port: options.metricsMcpPort ?? 19_210,
    });
    closers.push(() => metricsMcp.close());

    const logsSource = createElasticsearchLogSource({
      url: options.elasticsearchUrl, index, cursorSecret: options.cursorSecret, now,
      onCleanupFailure: ({ code }) => { process.stderr.write(`LOGS_LAB_PIT_CLEANUP_FAILED ${code}\n`); },
    });
    closers.push(() => logsSource.close());
    const logsMcp = await (dependencies?.startLogsMcp ?? startLogsMcpServer)(logsSource, {
      port: options.logsMcpPort ?? 19_211,
    });
    closers.push(() => logsMcp.close());

    const status = await (dependencies?.startStatus ?? startLogsLabStatusServer)({
      scenario, snapshotId, expiresAt: expiresAtMs, ready: true,
    }, { port: options.statusPort ?? 19_209, now });
    closers.push(() => status.close());
    assertFresh();
    return {
      metricsMcpUrl: metricsMcp.url, logsMcpUrl: logsMcp.url, statusUrl: status.url,
      scenario, snapshotId, expiresAt: new Date(expiresAtMs).toISOString(), close,
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'LOGS_LAB_START_FAILED'); }
    throw error;
  }
}
