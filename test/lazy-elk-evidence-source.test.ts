import { describe, expect, it, vi } from 'vitest';
import type { NormalizedLogRecord } from '../src/contracts/index.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';
import type { McpConnection } from '../src/mcp/types.js';
import type { McpToolDescriptor } from '../src/tool/adapters/mcp-tool-adapter.js';
import { logsCloseSnapshotInputJsonSchema, logsSearchPageInputJsonSchema } from '../src/mcp/logs-protocol.js';
import { startLogsMcpServer } from '../src/infrastructure/mcp/logs-server.js';
import { createLazyElkEvidenceSource } from '../src/bootstrap/lazy-elk-evidence-source.js';

const record: NormalizedLogRecord = {
  timestamp: '2026-10-03T00:04:00Z', service: 'checkout', level: 'ERROR', message: 'timeout',
};

function executor(now: () => number) {
  return new ResilientExecutor(new SourceCircuitBreaker({ now }), {
    now,
    maxRetries: 0,
  });
}

async function consumePages(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const pages: unknown[] = [];
  for await (const page of source) pages.push(page);
  return pages;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('lazy ELK evidence source', () => {
  it('connects only on first use and keeps read, pagination, and request identity bounded', async () => {
    const searchPage = vi.fn(() => Promise.resolve({
      status: 'available' as const,
      records: [record],
      sourceSnapshotId: 'snapshot-1',
    }));
    const closeSnapshot = vi.fn(() => Promise.resolve());
    const closeBackend = vi.fn(() => Promise.resolve());
    const server = await startLogsMcpServer({ searchPage, closeSnapshot, close: closeBackend }, { port: 0 });
    const now = () => 1_000;
    let shutdown: (() => Promise<void>) | undefined;
    try {
      const source = createLazyElkEvidenceSource({
        mcpUrl: server.url,
        executor: executor(now),
        now,
        registerShutdownHook: (callback) => { shutdown = callback; },
      });
      const ledger = { remaining: 8 };
      const pages: unknown[] = [];
      for await (const page of source.pages({
        service: 'checkout', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:05:00Z',
      }, { deadline: 9_000, networkAttemptBudget: ledger, requestId: 'capture-1' })) pages.push(page);

      expect(pages).toHaveLength(1);
      expect(searchPage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'capture-1' }), expect.any(AbortSignal));
      expect(closeSnapshot).toHaveBeenCalledWith({ sourceSnapshotId: 'snapshot-1' }, expect.any(AbortSignal));
      expect(ledger.remaining).toBe(3); // SDK initialization requests, discovery, and one search page
      expect(shutdown).toBeDefined();
      await shutdown?.();
      await expect(consumePages(source.pages({
          service: 'checkout', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:05:00Z',
        }, { deadline: 9_000, requestId: 'capture-after-shutdown' }))).rejects.toMatchObject({ code: 'ABORTED' });
      expect(closeBackend).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('rejects a remote tool set that is not the exact readonly logs contract', async () => {
    const call = vi.fn(() => Promise.resolve({ blocks: [] }));
    const connect = vi.fn(() => Promise.resolve());
    const listTools = vi.fn(() => Promise.resolve([{
      name: 'logs.search_page',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }]));
    const close = vi.fn(() => Promise.resolve());
    const connection: McpConnection = {
      connect,
      listTools,
      call,
      close,
    };
    const now = () => 1_000;
    const source = createLazyElkEvidenceSource({
      mcpUrl: 'http://127.0.0.1:19211/mcp',
      executor: executor(now),
      now,
      registerShutdownHook: () => undefined,
      connectionFactory: () => connection,
    });

    const pages = source.pages({
      service: 'checkout', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:05:00Z',
    }, { deadline: 9_000, requestId: 'capture-1' });
    await expect(consumePages(pages)).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    expect(call).not.toHaveBeenCalled();
  });

  it('does not connect when the shared network-attempt budget is already exhausted', async () => {
    const connect = vi.fn(() => Promise.resolve());
    const connection: McpConnection = {
      connect,
      listTools: vi.fn(() => Promise.resolve([])),
      call: vi.fn(() => Promise.resolve({ blocks: [] })),
      close: vi.fn(() => Promise.resolve()),
    };
    const now = () => 1_000;
    const source = createLazyElkEvidenceSource({
      mcpUrl: 'http://127.0.0.1:19211/mcp',
      executor: executor(now),
      now,
      registerShutdownHook: () => undefined,
      connectionFactory: () => connection,
    });

    await expect(consumePages(source.pages({
        service: 'checkout', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:05:00Z',
      }, { deadline: 9_000, networkAttemptBudget: { remaining: 0 }, requestId: 'capture-1' }))).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(connect).not.toHaveBeenCalled();

    const expiredConnect = vi.fn(() => Promise.resolve());
    const expiredConnection: McpConnection = {
      connect: expiredConnect,
      listTools: vi.fn(() => Promise.resolve([])),
      call: vi.fn(() => Promise.resolve({ blocks: [] })),
      close: vi.fn(() => Promise.resolve()),
    };
    const expiredSource = createLazyElkEvidenceSource({
      mcpUrl: 'http://127.0.0.1:19211/mcp',
      executor: executor(now),
      now,
      registerShutdownHook: () => undefined,
      connectionFactory: () => expiredConnection,
    });
    await expect(consumePages(expiredSource.pages({
        service: 'checkout', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:05:00Z',
      }, { deadline: 999, requestId: 'capture-expired' }))).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(expiredConnect).not.toHaveBeenCalled();
  });

  it('bounds concurrent waiters by each caller deadline and AbortSignal', async () => {
    let releaseConnect: (() => void) | undefined;
    const pendingConnect = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const descriptors: McpToolDescriptor[] = [
      { name: 'logs.search_page', inputSchema: logsSearchPageInputJsonSchema, annotations: {
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      } },
      { name: 'logs.close_snapshot', inputSchema: logsCloseSnapshotInputJsonSchema, annotations: {
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      } },
    ];
    const connection: McpConnection = {
      connect: () => pendingConnect,
      listTools: () => Promise.resolve(descriptors),
      call: (name) => Promise.resolve({ blocks: [{ type: 'json', value: name === 'logs.close_snapshot'
        ? { status: 'closed' }
        : { status: 'available', records: [], sourceSnapshotId: 'snapshot-1' } }] }),
      close: () => Promise.resolve(),
    };
    const now = () => 1_000;
    let shutdown: (() => Promise<void>) | undefined;
    const source = createLazyElkEvidenceSource({
      mcpUrl: 'http://127.0.0.1:19211/mcp',
      executor: executor(now),
      now,
      registerShutdownHook: (callback) => { shutdown = callback; },
      connectionFactory: () => connection,
    });
    const query = { service: 'checkout', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:05:00Z' };
    const primary = consumePages(source.pages(query, { deadline: 9_000, requestId: 'primary' }));
    await Promise.resolve();
    const expired = consumePages(source.pages(query, { deadline: 1_001, requestId: 'expired-waiter' }));
    const expiredResult = expired.then(() => 'resolved', (error: { code?: unknown }) => `error:${String(error.code)}`);
    const abort = new AbortController();
    const aborted = consumePages(source.pages(query, { signal: abort.signal, deadline: 9_000, requestId: 'aborted-waiter' }));
    const abortedResult = aborted.then(() => 'resolved', (error: { code?: unknown }) => `error:${String(error.code)}`);
    abort.abort();

    const expiredOutcome = await Promise.race([
      expiredResult,
      delay(20).then(() => 'still-waiting'),
    ]);
    const abortedOutcome = await Promise.race([
      abortedResult,
      delay(20).then(() => 'still-waiting'),
    ]);
    releaseConnect?.();
    await primary;
    await Promise.allSettled([expired, aborted]);
    await shutdown?.();

    expect(expiredOutcome).toBe('error:BUDGET_EXCEEDED');
    expect(abortedOutcome).toBe('error:ABORTED');
  });
});
