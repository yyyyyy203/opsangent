import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { settlementInput, settlementInputSchema, settlementRemoteName } from '../../mcp/settlement-protocol.js';
import { PrometheusQueryError, type SettlementSnapshot } from '../prometheus/settlement-source.js';

/** Local-only stateless MCP server; the source is injected, never instantiated here. */
export async function startSettlementMcpServer(source: { query(signal: AbortSignal): Promise<SettlementSnapshot> }, options: { port: number }) {
  const active = new Set<Server>();
  const shutdown = new AbortController();
  let host = '';
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    if (request.headers.origin !== undefined || request.headers.host !== host) { response.writeHead(403).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (active.size >= 16) { response.writeHead(503).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) { response.writeHead(400).end(); return; }
      size += chunk.length;
      if (size > 32768) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { response.writeHead(400).end(); return; }
    const disconnected = new AbortController();
    const mcp = new Server({ name: 'settlement-metrics', version: '1.0.0' }, { capabilities: { tools: {} } });
    active.add(mcp);
    response.once('close', () => {
      disconnected.abort();
      active.delete(mcp);
      void mcp.close().catch(() => { response.destroy(); });
    });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{
      name: settlementRemoteName, description: 'Read the settlement metric snapshot for checkout.', inputSchema: settlementInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      if (params.name !== settlementRemoteName || !settlementInput.safeParse(params.arguments).success) {
        return { isError: true, content: [{ type: 'text', text: 'INVALID_TOOL_INPUT' }] };
      }
      let result: unknown;
      try { result = await source.query(AbortSignal.any([extra.signal, shutdown.signal, disconnected.signal, AbortSignal.timeout(7000)])); }
      catch (error) { result = { status: 'source_error', code: sourceErrorCode(error) }; }
      return { content: [], structuredContent: result as Record<string, unknown> };
    });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    await mcp.connect(transport as Transport);
    await transport.handleRequest(request, response, body);
  }
  const http = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  http.requestTimeout = 10000;
  http.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('MCP_LISTEN_FAILED');
  host = `127.0.0.1:${address.port}`;
  return { url: `http://${host}/mcp`, async close() {
    shutdown.abort();
    await Promise.allSettled([...active].map((server) => server.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  } };
}

function sourceErrorCode(error: unknown): string {
  if (error instanceof PrometheusQueryError) {
    if (error.httpStatus === 401 || error.httpStatus === 403) return 'MCP_AUTH_ERROR';
    if (error.httpStatus !== undefined && error.httpStatus >= 500) return 'MCP_SERVER_ERROR';
    // Do not retry 429 prematurely without forwarding Retry-After in a future protocol revision.
    return 'MCP_PROTOCOL_ERROR';
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'MCP_TIMEOUT';
  if (error instanceof Error && error.name === 'AbortError') return 'ABORTED';
  if (error instanceof TypeError) return 'MCP_NETWORK_ERROR';
  return 'MCP_PROTOCOL_ERROR';
}
