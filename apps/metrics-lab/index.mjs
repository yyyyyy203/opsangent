import { startMetricsLab } from '../../dist/bootstrap/metrics-lab.js';
import process from 'node:process';

const lab = await startMetricsLab({
  prometheusUrl: process.env.AGENTOPS_PROMETHEUS_URL ?? 'http://127.0.0.1:19090',
  initialScenario: process.env.AGENTOPS_SCENARIO ?? 'normal',
});
process.stdout.write(`${JSON.stringify({ status: 'ready', metricsUrl: lab.metricsUrl, adminUrl: lab.adminUrl, mcpUrl: lab.mcpUrl })}\n`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await lab.close();
  process.exitCode = 0;
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
