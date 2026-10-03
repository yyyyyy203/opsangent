import { startLogsLab } from '../../dist/bootstrap/logs-lab.js';
import process from 'node:process';

const scenario = process.env.AGENTOPS_LOGS_LAB_SCENARIO ?? 'normal';
if (!['normal', 'settlement_failure', 'low_sample'].includes(scenario)) throw new Error('INVALID_LAB_SCENARIO');
const cursorSecret = process.env.AGENTOPS_LOGS_LAB_CURSOR_SECRET;
if (!cursorSecret || Buffer.byteLength(cursorSecret, 'utf8') < 32) throw new Error('INVALID_LAB_CURSOR_SECRET');

const lab = await startLogsLab({
  elasticsearchUrl: process.env.AGENTOPS_ELASTICSEARCH_URL ?? 'http://127.0.0.1:19200',
  prometheusUrl: process.env.AGENTOPS_LOGS_LAB_PROMETHEUS_URL ?? 'http://127.0.0.1:19290',
  initialScenario: scenario,
  cursorSecret,
});
process.stdout.write(`${JSON.stringify({
  status: 'ready', scenario: lab.scenario, expiresAt: lab.expiresAt,
  metricsMcpUrl: lab.metricsMcpUrl, logsMcpUrl: lab.logsMcpUrl, statusUrl: lab.statusUrl,
})}\n`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await lab.close();
  process.exitCode = 0;
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
