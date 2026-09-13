import { describe, expect, it } from 'vitest';
import type { McpConnection } from '../src/mcp/types.js';
import { ResilientExecutor, SourceCircuitBreaker, SourceFailure } from '../src/mcp/resilience.js';
import type { NormalizedLogRecord, ToolResponse } from '../src/contracts/index.js';
import {
  McpElkPageClient,
  PagedEvidenceSource,
  ResilientElkPageClient,
  type ElkEvidenceQuery,
  type ElkPageClient,
} from '../src/infrastructure/elk/paged-evidence-source.js';

const query: ElkEvidenceQuery = {
  service: 'checkout',
  start: '2026-09-13T00:00:00.000Z',
  end: '2026-09-13T01:00:00.000Z',
};

function record(message: string, second: number): NormalizedLogRecord {
  return {
    timestamp: new Date(Date.UTC(2026, 8, 13, 0, 0, second)).toISOString(),
    service: 'checkout',
    level: 'ERROR',
    message,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe('PagedEvidenceSource', () => {
  it('rejects a source page above 512 KiB before it reaches the recorder', async () => {
    const client: ElkPageClient = {
      fetchPage: () => Promise.resolve({ records: [record('x'.repeat(512 * 1024), 1)] }),
    };
    const source = new PagedEvidenceSource(client);

    await expect(collect(source.pages(query))).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
  });

  it('follows opaque cursors and keeps the source snapshot stable', async () => {
    const cursors: (string | undefined)[] = [];
    const client: ElkPageClient = {
      fetchPage: ({ cursor }) => {
        cursors.push(cursor);
        return Promise.resolve(cursor === undefined
          ? { records: [record('first', 1)], nextCursor: 'opaque-2', sourceSnapshotId: 'pit-1' }
          : { records: [record('second', 2)], sourceSnapshotId: 'pit-1' });
      },
    };
    const pages = await collect(new PagedEvidenceSource(client).pages(query));

    expect(cursors).toEqual([undefined, 'opaque-2']);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.nextCursor).toBe('opaque-2');
    expect(pages[1]?.sourceSnapshotId).toBe('pit-1');
  });

  it('rejects a repeated cursor or a changed source snapshot as a protocol error', async () => {
    const repeatedCursor: ElkPageClient = {
      fetchPage: () => Promise.resolve({ records: [record('loop', 1)], nextCursor: 'same', sourceSnapshotId: 'pit-1' }),
    };
    await expect(collect(new PagedEvidenceSource(repeatedCursor).pages(query))).rejects.toMatchObject({
      code: 'MCP_PROTOCOL_ERROR',
    });

    let call = 0;
    const changedSnapshot: ElkPageClient = {
      fetchPage: () => {
        call += 1;
        return Promise.resolve(call === 1
          ? { records: [record('first', 1)], nextCursor: 'next', sourceSnapshotId: 'pit-1' }
          : { records: [record('second', 2)], sourceSnapshotId: 'pit-2' });
      },
    };
    await expect(collect(new PagedEvidenceSource(changedSnapshot).pages(query))).rejects.toMatchObject({
      code: 'MCP_PROTOCOL_ERROR',
    });
  });

  it('decodes one bounded structured page from the injected MCP connection', async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const connection: McpConnection = {
      connect: () => Promise.resolve(),
      close: () => Promise.resolve(),
      listTools: () => Promise.resolve([]),
      call: (name, input): Promise<ToolResponse> => {
        calls.push({ name, input });
        return Promise.resolve({ blocks: [{ type: 'json', value: calls.length === 1 ? {
          records: [record('from-mcp', 1)],
          nextCursor: 'opaque-next',
          sourceSnapshotId: 'pit-1',
        } : {
          records: [record('from-mcp-2', 2)],
          sourceSnapshotId: 'pit-1',
        } }] });
      },
    };
    const client = new McpElkPageClient(connection);
    const pages = await collect(new PagedEvidenceSource(client).pages(query));

    expect(calls).toEqual([{
      name: 'logs.search_page',
      input: { service: 'checkout', start: query.start, end: query.end },
    }, {
      name: 'logs.search_page',
      input: {
        service: 'checkout', start: query.start, end: query.end,
        cursor: 'opaque-next', sourceSnapshotId: 'pit-1',
      },
    }]);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.nextCursor).toBe('opaque-next');
    expect(pages[0]?.records[0]?.message).toBe('from-mcp');
    expect(pages[1]?.records[0]?.message).toBe('from-mcp-2');
  });

  it('does not turn malformed MCP data into an empty page', async () => {
    const connection: McpConnection = {
      connect: () => Promise.resolve(),
      close: () => Promise.resolve(),
      listTools: () => Promise.resolve([]),
      call: () => Promise.resolve({ blocks: [{ type: 'json', value: { records: 'not-an-array' } }] }),
    };
    const client = new McpElkPageClient(connection);

    await expect(client.fetchPage({ query, signal: new AbortController().signal })).rejects.toBeInstanceOf(SourceFailure);
    await expect(client.fetchPage({ query, signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'MCP_PROTOCOL_ERROR',
    });
  });

  it('retries transient page failures and preserves the opaque cursor on each attempt', async () => {
    const attempts: { cursor?: string; sourceSnapshotId?: string }[] = [];
    let calls = 0;
    const delegate: ElkPageClient = {
      fetchPage: ({ cursor, sourceSnapshotId }) => {
        attempts.push({ ...(cursor === undefined ? {} : { cursor }), ...(sourceSnapshotId === undefined ? {} : { sourceSnapshotId }) });
        calls += 1;
        if (calls === 1) return Promise.reject(new SourceFailure('MCP_TIMEOUT'));
        return Promise.resolve({ records: [record('retried', 1)], sourceSnapshotId: 'pit-1' });
      },
    };
    const executor = new ResilientExecutor(new SourceCircuitBreaker({ threshold: 3, now: () => 0 }), {
      maxRetries: 1,
      now: () => 0,
      random: () => 1,
      sleep: () => Promise.resolve(),
    });
    const client = new ResilientElkPageClient(delegate, { executor, now: () => 0, deadlineMs: 1_000 });
    const page = await client.fetchPage({ query, cursor: 'opaque-2', sourceSnapshotId: 'pit-1', signal: new AbortController().signal });

    expect(page.records[0]?.message).toBe('retried');
    expect(attempts).toEqual([{ cursor: 'opaque-2', sourceSnapshotId: 'pit-1' }, { cursor: 'opaque-2', sourceSnapshotId: 'pit-1' }]);
  });

  it('opens the injected circuit after repeated source failures', async () => {
    const executor = new ResilientExecutor(new SourceCircuitBreaker({ threshold: 1, now: () => 0 }), {
      maxRetries: 0,
      now: () => 0,
    });
    const client = new ResilientElkPageClient({
      fetchPage: () => Promise.reject(new SourceFailure('MCP_SERVER_ERROR')),
    }, { executor, now: () => 0, deadlineMs: 1_000 });
    const signal = new AbortController().signal;

    await expect(client.fetchPage({ query, signal })).rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    await expect(client.fetchPage({ query, signal })).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
  });
});
