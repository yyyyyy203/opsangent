import { request as httpRequest } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { HttpMcpConnection } from '../src/infrastructure/mcp/http-connection.js';
import type { McpToolDescriptor } from '../src/tool/adapters/mcp-tool-adapter.js';
import type { LogsPageBackend, LogsPageWireResult } from '../src/mcp/logs-protocol.js';
import { startLogsMcpServer } from '../src/infrastructure/mcp/logs-server.js';

const searchInput = {
  service: 'checkout',
  start: '2026-10-03T00:00:00Z',
  end: '2026-10-03T00:05:00Z',
  requestId: 'capture-1',
};

function rawStatus(url: string, options: { method: string; headers?: Record<string, string>; body?: string }): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: options.method,
      headers: options.headers,
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

function sourceFixture() {
  const searchPage = vi.fn((): Promise<LogsPageWireResult> => Promise.resolve({
    status: 'available', records: [], sourceSnapshotId: 'logical-snapshot-1',
  }));
  const closeSnapshot = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve());
  const source: LogsPageBackend = { searchPage, closeSnapshot, close };
  return { source, searchPage, closeSnapshot, close };
}

describe('Logs MCP server', () => {
  it('exposes exactly two fixed read-only tools and returns one structured result', async () => {
    const fixture = sourceFixture();
    const server = await startLogsMcpServer(fixture.source, { port: 0 });
    const connection = new HttpMcpConnection({ url: server.url });
    const signal = new AbortController().signal;
    try {
      await connection.connect(signal);
      const tools = await connection.listTools(signal);
      expect(tools.map((tool) => tool.name).sort()).toEqual(['logs.close_snapshot', 'logs.search_page']);
      expect(tools.every((tool) => {
        const annotations = (tool as McpToolDescriptor & { annotations?: Record<string, unknown> }).annotations;
        return annotations?.readOnlyHint === true
          && annotations.destructiveHint === false
          && annotations.idempotentHint === true
          && annotations.openWorldHint === false;
      })).toBe(true);

      const response = await connection.call('logs.search_page', searchInput, signal);
      expect(response.isError).toBeUndefined();
      expect(response.blocks).toEqual([{
        type: 'json', value: { status: 'available', records: [], sourceSnapshotId: 'logical-snapshot-1' },
      }]);
      expect(fixture.searchPage).toHaveBeenCalledWith(searchInput, expect.any(AbortSignal));

      const closed = await connection.call('logs.close_snapshot', { sourceSnapshotId: 'logical-snapshot-1' }, signal);
      expect(closed.blocks).toEqual([{ type: 'json', value: { status: 'closed' } }]);
      expect(fixture.closeSnapshot).toHaveBeenCalledWith(
        { sourceSnapshotId: 'logical-snapshot-1' }, expect.any(AbortSignal),
      );
    } finally {
      await connection.close();
      await server.close();
    }
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('rejects wrong origins, methods, paths, host headers and oversized bodies before tool dispatch', async () => {
    const fixture = sourceFixture();
    const server = await startLogsMcpServer(fixture.source, { port: 0, maxBodyBytes: 64 });
    try {
      await expect(fetch(server.url, { method: 'GET' })).resolves.toMatchObject({ status: 405 });
      await expect(fetch(server.url + '/other', { method: 'POST', body: '{}' })).resolves.toMatchObject({ status: 404 });
      await expect(fetch(server.url, { method: 'POST', headers: { origin: 'http://evil.invalid' }, body: '{}' }))
        .resolves.toMatchObject({ status: 403 });
      await expect(rawStatus(server.url, {
        method: 'POST', headers: { host: 'evil.invalid', 'content-type': 'application/json' }, body: '{}',
      })).resolves.toBe(403);
      await expect(fetch(server.url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(128),
      })).resolves.toMatchObject({ status: 413 });
    } finally {
      await server.close();
    }
    expect(fixture.searchPage).not.toHaveBeenCalled();
  });

  it('rejects malformed arguments and unknown tools without invoking the source', async () => {
    const fixture = sourceFixture();
    const server = await startLogsMcpServer(fixture.source, { port: 0 });
    const connection = new HttpMcpConnection({ url: server.url });
    const signal = new AbortController().signal;
    try {
      await connection.connect(signal);
      const malformed = await connection.call('logs.search_page', { ...searchInput, dsl: { match_all: {} } }, signal);
      const unknown = await connection.call('logs.query_everything', {}, signal);
      expect(malformed.isError).toBe(true);
      expect(unknown.isError).toBe(true);
      expect(fixture.searchPage).not.toHaveBeenCalled();
    } finally {
      await connection.close();
      await server.close();
    }
  });
});
