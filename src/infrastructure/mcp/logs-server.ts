import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  logsCloseSnapshotInput,
  logsCloseSnapshotInputJsonSchema,
  logsPageWireResultSchema,
  logsSearchPageInput,
  logsSearchPageInputJsonSchema,
  type LogsPageBackend,
  type LogsPageWireResult,
} from '../../mcp/logs-protocol.js';
import type { AgentErrorCode } from '../../contracts/errors.js';
import { SourceFailure } from '../../mcp/resilience.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 19_211;
const DEFAULT_MAX_BODY_BYTES = 32 * 1_024;
const MAX_ACTIVE_REQUESTS = 16;
const TOOL_TIMEOUT_MS = 7_000;

export interface LogsMcpServerOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
}

/** Local-only, stateless MCP server exposing exactly the two read-only log operations. */
export async function startLogsMcpServer(
  source: LogsPageBackend,
  options: LogsMcpServerOptions = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (host !== DEFAULT_HOST) throw new TypeError('Logs MCP server must bind to 127.0.0.1');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new RangeError('Invalid Logs MCP port');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > 1_048_576) {
    throw new RangeError('maxBodyBytes must be between 1 and 1048576');
  }

  const shutdown = new AbortController();
  const active = new Set<Server>();
  const handlers = new Set<Promise<void>>();
  let expectedHost = '';
  let closePromise: Promise<void> | undefined;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    if (request.headers.origin !== undefined || request.headers.host !== expectedHost) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (active.size >= MAX_ACTIVE_REQUESTS) { response.writeHead(503).end(); return; }
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') { response.writeHead(415).end(); return; }

    const body = await readBoundedBody(request, maxBodyBytes);
    if (body === undefined) { response.writeHead(413).end(); return; }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
    } catch {
      response.writeHead(400).end();
      return;
    }

    const disconnected = new AbortController();
    const onResponseClose = (): void => disconnected.abort();
    response.once('close', onResponseClose);
    const mcp = new Server({ name: 'agentops-readonly-logs', version: '0.1.0' }, { capabilities: { tools: {} } });
    active.add(mcp);
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: 'logs.search_page',
          description: 'Read one bounded page of checkout logs from the configured time window.',
          inputSchema: logsSearchPageInputJsonSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        {
          name: 'logs.close_snapshot',
          description: 'Close a log query snapshot and release its server-side PIT resource.',
          inputSchema: logsCloseSnapshotInputJsonSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
      ],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      const signal = AbortSignal.any([
        extra.signal,
        shutdown.signal,
        disconnected.signal,
        AbortSignal.timeout(TOOL_TIMEOUT_MS),
      ]);
      if (params.name === 'logs.search_page') {
        const parsed = logsSearchPageInput.safeParse(params.arguments);
        if (!parsed.success) return invalidToolInput();
        let result: LogsPageWireResult;
        try {
          result = await source.searchPage(parsed.data, signal);
        } catch (error) {
          result = { status: 'source_error', code: sourceErrorCode(error) };
        }
        if (!logsPageWireResultSchema.safeParse(result).success) {
          result = { status: 'source_error', code: 'MCP_PROTOCOL_ERROR' };
        }
        return { content: [], structuredContent: result as unknown as Record<string, unknown> };
      }
      if (params.name === 'logs.close_snapshot') {
        const parsed = logsCloseSnapshotInput.safeParse(params.arguments);
        if (!parsed.success) return invalidToolInput();
        try {
          await source.closeSnapshot({ sourceSnapshotId: parsed.data.sourceSnapshotId }, signal);
          return { content: [], structuredContent: { status: 'closed' } };
        } catch {
          return { isError: true, content: [{ type: 'text', text: 'SNAPSHOT_CLOSE_FAILED' }] };
        }
      }
      return { isError: true, content: [{ type: 'text', text: 'UNKNOWN_TOOL' }] };
    });

    try {
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(transport as Transport);
      await transport.handleRequest(request, response, parsedBody);
    } finally {
      response.removeListener('close', onResponseClose);
      disconnected.abort();
      active.delete(mcp);
      await mcp.close().catch(() => undefined);
    }
  };

  const http = createServer((request, response) => {
    const handler = handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }).finally(() => handlers.delete(handler));
    handlers.add(handler);
  });
  http.requestTimeout = 10_000;
  http.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => { http.removeListener('error', reject); resolve(); });
  });
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('MCP_LISTEN_FAILED');
  expectedHost = `${host}:${address.port}`;
  const url = `http://${expectedHost}/mcp`;

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    shutdown.abort();
    const serverClosed = new Promise<void>((resolve, reject) => {
      http.close((error) => error ? reject(error) : resolve());
    });
    http.closeAllConnections();
    closePromise = (async () => {
      await Promise.allSettled([...handlers]);
      try {
        await source.close();
      } finally {
        await serverClosed;
      }
    })();
    return closePromise;
  };

  return { url, close };
}

function invalidToolInput() {
  return { isError: true as const, content: [{ type: 'text' as const, text: 'INVALID_TOOL_INPUT' }] };
}

function sourceErrorCode(error: unknown): Extract<AgentErrorCode,
  'ABORTED' | 'BUDGET_EXCEEDED' | 'INVALID_INPUT' | 'MCP_AUTH_ERROR' | 'MCP_NETWORK_ERROR'
  | 'MCP_PROTOCOL_ERROR' | 'MCP_RATE_LIMITED' | 'MCP_SERVER_ERROR' | 'MCP_TIMEOUT' | 'POLICY_DENIED' | 'UNAVAILABLE'> {
  const allowed = new Set<AgentErrorCode>([
    'ABORTED', 'BUDGET_EXCEEDED', 'INVALID_INPUT', 'MCP_AUTH_ERROR', 'MCP_NETWORK_ERROR',
    'MCP_PROTOCOL_ERROR', 'MCP_RATE_LIMITED', 'MCP_SERVER_ERROR', 'MCP_TIMEOUT', 'POLICY_DENIED', 'UNAVAILABLE',
  ]);
  return error instanceof SourceFailure && allowed.has(error.code)
    ? error.code as ReturnType<typeof sourceErrorCode>
    : 'MCP_PROTOCOL_ERROR';
}

async function readBoundedBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let completed = false;
    request.on('data', (chunk: Buffer | Uint8Array | string) => {
      if (completed) return;
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
        completed = true;
        reject(new Error('Invalid HTTP request body chunk'));
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > limit) {
        completed = true;
        chunks.length = 0;
        resolve(undefined);
        request.resume();
        return;
      }
      chunks.push(bytes);
    });
    request.once('end', () => {
      if (completed) return;
      completed = true;
      resolve(Buffer.concat(chunks));
    });
    request.once('aborted', () => {
      if (completed) return;
      completed = true;
      reject(new Error('HTTP request aborted'));
    });
    request.once('error', (error) => {
      if (completed) return;
      completed = true;
      reject(error);
    });
  });
}
