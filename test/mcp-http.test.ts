import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpMcpConnection } from '../src/infrastructure/mcp/http-connection.js';
import { bindReadonlyMcpTools } from '../src/mcp/readonly-tools.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const remoteSchema = { type: 'object', properties: { service: { type: 'string' } }, required: ['service'], additionalProperties: false };
const manifest = { localName: 'metrics.query', remoteName: 'query', description: 'Read metrics', inputSchema: z.object({ service: z.string() }), expectedRemoteSchema: remoteSchema, readOnly: true as const, idempotent: true as const, concurrencySafe: true };

async function fixture(transientFailures = 0, failureStatus = 503, businessError = false) {
  const methods: string[] = [];
  let attempts = 0;
  const mcp = new Server({ name: 'test-source', version: '1' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
    { name: 'query', inputSchema: remoteSchema },
    { name: 'delete_everything', inputSchema: { type: 'object' } },
  ] }));
  mcp.setRequestHandler(CallToolRequestSchema, ({ params }) => ({ isError: businessError, content: [{ type: 'text', text: JSON.stringify({ service: params.arguments?.service, failureRate: 0.15 }) }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  await mcp.connect(transport as Transport);
  async function handle(req: IncomingMessage, res: ServerResponse) {
    let parsed: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) { if (Buffer.isBuffer(chunk)) chunks.push(chunk); }
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const method = (parsed as { method: string }).method;
      methods.push(method);
      if (method === 'tools/call' && ++attempts <= transientFailures) { res.writeHead(failureStatus); res.end(); return; }
    }
    await transport.handleRequest(req, res, parsed);
  }
  const http = createServer((req, res) => { void handle(req, res).catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, methods,
    async close() { await mcp.close(); http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); },
  };
}

describe('official SDK HTTP integration', () => {
  it.each([{ failures: 100, status: 401, business: false }, { failures: 0, status: 503, business: true }])('does not retry authentication or business failures: %j', async ({ failures, status, business }) => {
    const server = await fixture(failures, status, business);
    const connection = new HttpMcpConnection({ url: server.url });
    const signal = new AbortController().signal;
    try {
      await connection.connect(signal);
      const tools = await bindReadonlyMcpTools(connection, [manifest], { signal, executor: new ResilientExecutor(new SourceCircuitBreaker()) });
      const runtime = createInspectionRuntime({ model: new ScriptedModel([
        { toolCalls: [{ id: 'query-1', name: 'metrics.query', input: { service: 'checkout' } }] }, { toolCalls: [] },
      ]), workspaceRoots: [], tools, allowedToolNames: ['metrics.query'] });
      const run = await runtime.agent.reply({ message: 'inspect', profileId: 'test' });
      const result = (await runtime.checkpoints.load(run.runId))?.messages.flatMap((message) => message.blocks).find((block) => block.type === 'tool_result');
      expect(result?.type === 'tool_result' && result.result.status).toBe('failed');
      expect(server.methods.filter((method) => method === 'tools/call')).toHaveLength(1);
    } finally { await connection.close(); await server.close(); }
  });

  it('initializes, discovers an allowlist and retries transient calls through the real Harness', async () => {
    const server = await fixture(2);
    const connection = new HttpMcpConnection({ url: server.url });
    const signal = new AbortController().signal;
    try {
      await connection.connect(signal);
      const tools = await bindReadonlyMcpTools(connection, [manifest], {
        signal, executor: new ResilientExecutor(new SourceCircuitBreaker(), { sleep: () => Promise.resolve() }),
      });
      expect(tools.map((tool) => tool.name)).toEqual(['metrics.query']);
      const runtime = createInspectionRuntime({ model: new ScriptedModel([
        { toolCalls: [{ id: 'query-1', name: 'metrics.query', input: { service: 'checkout' } }] }, { toolCalls: [], text: 'done' },
      ]), workspaceRoots: [], tools, allowedToolNames: ['metrics.query'] });
      const result = await runtime.agent.reply({ message: 'inspect', profileId: 'simulation' });
      expect(result.status).toBe('completed');
      const blocks = (await runtime.checkpoints.load(result.runId))?.messages.flatMap((message) => message.blocks);
      const resultBlock = blocks?.find((block) => block.type === 'tool_result');
      expect(resultBlock?.type === 'tool_result' && resultBlock.result.response?.blocks).toEqual([
        { type: 'text', text: '{"service":"checkout","failureRate":0.15}' },
      ]);
      expect(server.methods.filter((method) => method === 'tools/call')).toHaveLength(3);
      expect(server.methods).toContain('initialize');
      expect(server.methods).toContain('notifications/initialized');
    } finally { await connection.close(); await server.close(); }
  });

  it('rejects schema drift instead of registering a changed remote tool', async () => {
    const server = await fixture();
    const connection = new HttpMcpConnection({ url: server.url });
    const signal = new AbortController().signal;
    try {
      await connection.connect(signal);
      await expect(bindReadonlyMcpTools(connection, [{ ...manifest, expectedRemoteSchema: { type: 'object' } }], {
        signal, executor: new ResilientExecutor(new SourceCircuitBreaker()),
      })).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
      expect(server.methods).not.toContain('tools/call');
    } finally { await connection.close(); await server.close(); }
  });
});
