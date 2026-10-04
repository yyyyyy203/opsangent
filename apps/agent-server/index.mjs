import process from 'node:process';
import { startAgentWebRuntime } from '../../dist/bootstrap/agent-web-runtime.js';
import {
  createLangSmithEventObservability,
  readLangSmithEventConfig,
} from '../../dist/bootstrap/langsmith.js';

const dataDirectory = required('AGENTOPS_DATA_DIR');
const workspaceRoots = required('AGENTOPS_WORKSPACE_ROOTS').split(';').map((value) => value.trim()).filter(Boolean);
if (workspaceRoots.length === 0) throw new Error('AGENTOPS_WORKSPACE_ROOTS must contain at least one absolute path.');
const webProfile = required('AGENTOPS_WEB_PROFILE');
const metricsMcpUrl = required('AGENTOPS_METRICS_MCP_URL');
const logsMcpUrl = optional('AGENTOPS_LOGS_MCP_URL');
const langSmith = createLangSmithEventObservability(readLangSmithEventConfig(process.env));
const modelName = process.env.AGENTOPS_MODEL ?? 'deepseek-chat';
const modelProvider = process.env.AGENTOPS_MODEL_PROVIDER?.trim() || 'openai-compatible';
if (webProfile !== 'simulation') throw new Error('AGENTOPS_WEB_PROFILE must be simulation.');
const allowedOrigins = optionalList('AGENTOPS_ALLOWED_ORIGINS');
const logs = logsMcpUrl === undefined ? undefined : {
  profileId: 'simulation',
  mcpUrl: logsMcpUrl,
  cursorSecret: required('AGENTOPS_EVIDENCE_CURSOR_SECRET'),
};
const runtime = await startAgentWebRuntime({
  dataDirectory,
  workspaceRoots,
  eventObservability: langSmith.eventObservability,
  modelIdentity: { provider: modelProvider, model: modelName },
  metrics: { profileId: 'simulation', mcpUrl: metricsMcpUrl },
  ...(logs === undefined ? {} : { logs }),
  ...(process.env.AGENTOPS_HOST === undefined ? {} : { host: process.env.AGENTOPS_HOST }),
  ...(process.env.AGENTOPS_PORT === undefined ? {} : { port: parsePort(process.env.AGENTOPS_PORT) }),
  ...(allowedOrigins.length === 0 ? {} : { allowedOrigins }),
});

process.stdout.write(`${JSON.stringify({ status: 'ready', url: runtime.url })}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await runtime.close();
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value;
}

function optional(name) {
  return process.env[name];
}

function optionalList(name) {
  const value = process.env[name];
  return value === undefined ? [] : value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parsePort(value) {
  if (!/^\d+$/.test(value)) throw new Error('AGENTOPS_PORT must be an integer.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('AGENTOPS_PORT must be between 0 and 65535.');
  return port;
}
