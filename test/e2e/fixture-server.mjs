import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startAgentWebRuntime } from '../../dist/bootstrap/agent-web-runtime.js';

const dataDirectory = await mkdtemp(join(tmpdir(), 'agentops-web-e2e-'));
const agentPort = Number(process.env.AGENTOPS_E2E_AGENT_PORT ?? 45100);
const webPort = Number(process.env.AGENTOPS_E2E_WEB_PORT ?? 45173);
const fixtureTool = {
  name: 'fixture.metrics',
  description: 'E2E-only deterministic read fixture.',
  kind: 'evidence',
  source: 'mcp',
  inputSchema: z.object({ service: z.string() }),
  requireUserConfirm: true,
  isConcurrencySafe: () => true,
  call: async (input) => ({
    blocks: [{ type: 'json', value: { service: input.service, failureRate: 0.02, source: 'fixture' } }],
  }),
};
class FixtureModel {
  async *stream(messages, _tools, options) {
    const hasToolResult = messages.some((message) => message.role === 'tool'
      || (Array.isArray(message.blocks) && message.blocks.some((block) => block.type === 'tool_result')));
    if (!hasToolResult) {
      const call = { id: `fixture-call-${options.runId}`, name: 'fixture.metrics', input: { service: 'settlement' } };
      yield { type: 'tool_call', call };
      return { toolCalls: [call] };
    }
    const text = '模拟诊断完成：结算失败率已核验。';
    yield { type: 'text_delta', delta: text };
    return { text, toolCalls: [] };
  }
}
const model = new FixtureModel();
const runtime = await startAgentWebRuntime({
  dataDirectory,
  workspaceRoots: [dataDirectory],
  model,
  tools: [fixtureTool],
  host: '127.0.0.1',
  port: agentPort,
  allowedOrigins: [`http://127.0.0.1:${webPort}`],
});

process.stdout.write(`${JSON.stringify({ status: 'ready', url: runtime.url })}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await runtime.close(); }
  finally { await rm(dataDirectory, { recursive: true, force: true }); }
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
