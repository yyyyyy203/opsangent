import { SourceFailure } from '../../mcp/resilience.js';

const DEFAULT_MAX_RESPONSE_BYTES = 1_024 * 1_024;

export interface ElasticsearchHttpOptions {
  url: string;
  fetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
}

export class ElasticsearchHttp {
  private readonly baseUrl: URL;
  private readonly fetch: typeof globalThis.fetch;
  private readonly maxResponseBytes: number;

  public constructor(options: ElasticsearchHttpOptions) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.url);
    } catch {
      throw new TypeError('Invalid Elasticsearch URL');
    }
    if (!['http:', 'https:'].includes(baseUrl.protocol)
      || baseUrl.username !== '' || baseUrl.password !== ''
      || baseUrl.search !== '' || baseUrl.hash !== '' || baseUrl.pathname !== '/') {
      throw new TypeError('Invalid Elasticsearch URL');
    }
    this.baseUrl = baseUrl;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0
      || this.maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES) {
      throw new RangeError('maxResponseBytes must be between 1 and 1048576');
    }
  }

  public async request(
    path: string,
    body: unknown,
    options: { method: 'POST' | 'DELETE' | 'PUT'; signal: AbortSignal },
  ): Promise<unknown> {
    if (options.signal.aborted) throw new SourceFailure('ABORTED');
    const url = this.resolvePath(path);
    let encodedBody: string;
    try {
      encodedBody = JSON.stringify(body);
      if (encodedBody === undefined) throw new TypeError('No JSON body');
    } catch {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }

    let response: Response;
    try {
      response = await this.fetch(url, {
        method: options.method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: encodedBody,
        redirect: 'manual',
        signal: options.signal,
      });
    } catch {
      throw new SourceFailure(options.signal.aborted ? 'ABORTED' : 'MCP_NETWORK_ERROR');
    }

    if (response.status >= 300 && response.status < 400) {
      await cancelBody(response);
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    if (!response.ok) {
      await cancelBody(response);
      if (response.status === 401 || response.status === 403) throw new SourceFailure('MCP_AUTH_ERROR');
      if (response.status === 404) throw new SourceFailure('UNAVAILABLE');
      if (response.status === 429) throw new SourceFailure('MCP_RATE_LIMITED');
      if (response.status >= 500) throw new SourceFailure('MCP_SERVER_ERROR');
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    if (options.signal.aborted) {
      await cancelBody(response);
      throw new SourceFailure('ABORTED');
    }
    if (response.body === null) return undefined;

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && /^\d+$/.test(contentLength)
      && Number(contentLength) > this.maxResponseBytes) {
      await cancelBody(response);
      throw new SourceFailure('BUDGET_EXCEEDED');
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!isJsonContentType(contentType)) {
      await cancelBody(response);
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }

    const bytes = await readBoundedBody(response, this.maxResponseBytes, options.signal);
    if (bytes.byteLength === 0) return undefined;
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
  }

  private resolvePath(path: string): URL {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#')) {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    const rawPath = path.split('?', 1)[0] ?? '';
    let decodedRawPath: string;
    try {
      decodedRawPath = decodeURIComponent(rawPath);
    } catch {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    if (decodedRawPath.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    let url: URL;
    try {
      url = new URL(path, this.baseUrl);
      const decodedPath = decodeURIComponent(url.pathname);
      if (decodedPath.split('/').some((segment) => segment === '.' || segment === '..')) {
        throw new Error('Traversal path');
      }
    } catch {
      throw new SourceFailure('MCP_PROTOCOL_ERROR');
    }
    if (url.origin !== this.baseUrl.origin) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    return url;
  }
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        throw new SourceFailure('ABORTED');
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new SourceFailure('BUDGET_EXCEEDED');
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof SourceFailure) throw error;
    throw new SourceFailure(signal.aborted ? 'ABORTED' : 'MCP_NETWORK_ERROR');
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isJsonContentType(value: string): boolean {
  return /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|\s*$)/i.test(value.trim());
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the primary status/validation failure.
  }
}
