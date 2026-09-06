import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpConnection } from '../../mcp/types.js';
import { SourceFailure } from '../../mcp/resilience.js';
import type { McpToolDescriptor } from '../../tool/adapters/mcp-tool-adapter.js';
import type { ToolResponse } from '../../contracts/tool.js';

export interface HttpMcpOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Official protocol implementation is confined to this infrastructure adapter. */
export class HttpMcpConnection implements McpConnection {
  private client: Client | undefined;
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  public constructor(private readonly options: HttpMcpOptions) {
    this.url = new URL(options.url);
    if (!['https:', 'http:'].includes(this.url.protocol) || this.url.username || this.url.password || this.url.hash) throw new Error('Invalid MCP endpoint configuration.');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) throw new Error('Invalid MCP resource limits.');
  }

  public async connect(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new SourceFailure('ABORTED');
    if (this.client) throw new Error('MCP connection already initialized.');
    const client = new Client({ name: 'agentops-readonly', version: '0.1.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(this.url, {
      requestInit: { headers: this.options.headers ?? {}, redirect: 'error' },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 200, maxReconnectionDelay: 2_000, reconnectionDelayGrowFactor: 2 },
      fetch: async (url, init) => {
        let response: Response;
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const requestSignal = AbortSignal.any([timeout, ...(init?.signal ? [init.signal] : [])]);
        try { response = await fetch(url, { ...init, signal: requestSignal, redirect: 'error' }); }
        catch { throw new SourceFailure(timeout.aborted ? 'MCP_TIMEOUT' : 'MCP_NETWORK_ERROR'); }
        if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new SourceFailure('MCP_AUTH_ERROR'); }
        if (response.status === 429) {
          const header = response.headers.get('retry-after');
          const retryAfterMs = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1_000
            : header && Number.isFinite(Date.parse(header)) ? Math.max(0, Date.parse(header) - Date.now()) : undefined;
          await response.body?.cancel();
          throw new SourceFailure('MCP_RATE_LIMITED', retryAfterMs);
        }
        if (response.status >= 500) { await response.body?.cancel(); throw new SourceFailure('MCP_SERVER_ERROR'); }
        if (!response.body) return response;
        let bytes = 0;
        const limit = this.maxResponseBytes;
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > limit) throw new SourceFailure('MCP_PROTOCOL_ERROR');
            controller.enqueue(chunk);
          },
        }));
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    });
    try {
      // SDK 1.x getters include undefined while Transport uses exact optional fields.
      // The assertion is isolated to the official SDK boundary; runtime protocol is unchanged.
      await client.connect(transport as Transport, { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs });
      this.client = client;
    } catch (error) {
      await client.close();
      throw this.failure(error, signal);
    }
  }

  public async listTools(signal: AbortSignal): Promise<McpToolDescriptor[]> {
    const client = this.requireClient();
    const tools: McpToolDescriptor[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 20; page += 1) {
        const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs });
        for (const descriptor of result.tools) {
          if (tools.some((tool) => tool.name === descriptor.name) || tools.length >= 1_000) throw new SourceFailure('MCP_PROTOCOL_ERROR');
          tools.push({ name: descriptor.name, inputSchema: descriptor.inputSchema, ...(descriptor.description === undefined ? {} : { description: descriptor.description }) });
        }
        if (!result.nextCursor) return tools;
        if (cursors.has(result.nextCursor)) throw new SourceFailure('MCP_PROTOCOL_ERROR');
        cursor = result.nextCursor; cursors.add(cursor);
      }
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    } catch (error) { throw this.failure(error, signal); }
  }

  public async call(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResponse> {
    try {
      const result = CallToolResultSchema.parse(await this.requireClient().callTool({ name, arguments: input }, CallToolResultSchema, { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs }));
      const blocks: ToolResponse['blocks'] = [];
      for (const content of result.content) {
        if (content.type !== 'text') throw new SourceFailure('MCP_PROTOCOL_ERROR');
        blocks.push({ type: 'text', text: content.text });
      }
      if (result.structuredContent) blocks.push({ type: 'json', value: result.structuredContent });
      return { blocks, ...(result.isError === undefined ? {} : { isError: result.isError }) };
    } catch (error) { throw this.failure(error, signal); }
  }

  public async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close();
  }

  private requireClient(): Client {
    if (!this.client) throw new SourceFailure('MCP_NETWORK_ERROR');
    return this.client;
  }

  private failure(error: unknown, signal: AbortSignal): SourceFailure {
    if (signal.aborted) return new SourceFailure('ABORTED');
    if (error instanceof SourceFailure) return error;
    if (error instanceof McpError && error.code === Number(ErrorCode.RequestTimeout)) return new SourceFailure('MCP_TIMEOUT');
    if (error instanceof StreamableHTTPError && (error.code ?? 0) >= 500) return new SourceFailure('MCP_SERVER_ERROR');
    return new SourceFailure('MCP_PROTOCOL_ERROR');
  }
}
