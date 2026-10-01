import { describe, expect, it, vi } from 'vitest';
import type { Clock, Tool, ToolCallOptions, ToolResponse, ToolResponseChunk } from '../src/contracts/index.js';
import { DefaultEvidenceRecorder } from '../src/application/evidence-recorder.js';
import { createLazySettlementEvidenceTool } from '../src/bootstrap/lazy-settlement-tool.js';
import { startSettlementMcpServer } from '../src/infrastructure/mcp/settlement-server.js';
import type { SettlementSnapshot } from '../src/infrastructure/prometheus/settlement-source.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';
import { InMemoryEvidenceStore } from '../src/storage/in-memory-evidence-store.js';

const snapshot: SettlementSnapshot = {
  status: 'available', counts: { total: 100, failed: 15 }, start: 700, end: 1000,
  raw: { marker: 'private-raw' },
};

const clock: Clock = { now: () => new Date(1_010_000) };

function executor(maxRetries = 0): ResilientExecutor {
  return new ResilientExecutor(new SourceCircuitBreaker({ now: () => clock.now().getTime() }), {
    maxRetries, now: () => clock.now().getTime(), sleep: () => Promise.resolve(),
  });
}

async function invoke(tool: Tool, options: ToolCallOptions): Promise<ToolResponse> {
  if (tool.call === undefined) throw new Error('missing call');
  const returned = tool.call({ service: 'checkout' }, options);
  if (typeof returned !== 'object' || returned === null || !(Symbol.asyncIterator in returned)) throw new Error('expected stream');
  const iterator = returned as AsyncGenerator<ToolResponseChunk, ToolResponse>;
  let item = await iterator.next();
  while (!item.done) item = await iterator.next();
  return item.value;
}

async function fixture() {
  const server = await startSettlementMcpServer({ query: () => Promise.resolve(snapshot) }, { port: 0 });
  const evidence = new InMemoryEvidenceStore();
  const lazy = createLazySettlementEvidenceTool({
    mcpUrl: server.url,
    recorder: new DefaultEvidenceRecorder({ evidence }),
    executor: executor(),
    clock,
  });
  return { server, evidence, lazy };
}

describe('lazy settlement evidence tool', () => {
  it('registers a fixed local capability without connecting during construction', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const lazy = createLazySettlementEvidenceTool({
      mcpUrl: 'http://127.0.0.1:1/mcp',
      recorder: new DefaultEvidenceRecorder({ evidence: new InMemoryEvidenceStore() }),
      executor: executor(),
      clock,
    });

    expect(lazy.tool.name).toBe('metrics.settlement');
    expect(lazy.tool.kind).toBe('evidence');
    expect(lazy.tool.source).toBe('mcp');
    expect(lazy.tool.inputSchema).toMatchObject({ _def: { typeName: 'ZodObject' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    await lazy.close();
    fetchSpy.mockRestore();
  });

  it('connects and returns the existing deterministic evidence response on first call', async () => {
    const f = await fixture();
    try {
      const result = await invoke(f.lazy.tool, {
        runId: 'run-1', stepId: 'step-1', toolCallId: 'call-1', signal: new AbortController().signal, mode: 'dry_run',
      });

      expect(result.blocks.some((block) => block.type === 'evidence_ref' && typeof block.evidenceId === 'string')).toBe(true);
      expect(result.blocks.some((block) => {
        if (block.type !== 'json' || typeof block.value !== 'object' || block.value === null) return false;
        const value = block.value as { status?: unknown; service?: unknown };
        return value.status === 'breached' && value.service === 'checkout';
      })).toBe(true);
      expect(await f.evidence.get(result.evidenceIds?.[0] ?? '')).not.toBeNull();
    } finally {
      await f.lazy.close();
      await f.server.close();
    }
  });

  it('retries a failed first connection without replacing the local tool', async () => {
    const f = await fixture();
    const originalFetch = globalThis.fetch;
    let first = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (first) { first = false; throw new TypeError('temporary network failure'); }
      return originalFetch(input, init);
    });
    try {
      const options = { runId: 'run-1', stepId: 'step-1', toolCallId: 'call-1', signal: new AbortController().signal, mode: 'dry_run' as const };
      await expect(invoke(f.lazy.tool, options)).rejects.toMatchObject({ code: 'MCP_NETWORK_ERROR' });
      expect(f.lazy.tool.name).toBe('metrics.settlement');
      const result = await invoke(f.lazy.tool, { ...options, toolCallId: 'call-2' });
      expect(result.evidenceIds).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      await f.lazy.close();
      await f.server.close();
    }
  });

  it('shares a single manifest bind between concurrent first calls', async () => {
    const f = await fixture();
    try {
      const signal = new AbortController().signal;
      const [first, second] = await Promise.all([
        invoke(f.lazy.tool, { runId: 'run-1', stepId: 'step-1', toolCallId: 'call-1', signal, mode: 'dry_run' }),
        invoke(f.lazy.tool, { runId: 'run-1', stepId: 'step-1', toolCallId: 'call-2', signal, mode: 'dry_run' }),
      ]);
      expect(first.evidenceIds).toHaveLength(1);
      expect(second.evidenceIds).toHaveLength(1);
    } finally {
      await f.lazy.close();
      await f.server.close();
    }
  });

  it('closes the connection once through direct and registered shutdown cleanup', async () => {
    const cleanup: Array<() => void | Promise<void>> = [];
    const f = await fixture();
    const lazy = createLazySettlementEvidenceTool({
      mcpUrl: f.server.url,
      recorder: new DefaultEvidenceRecorder({ evidence: f.evidence }),
      executor: executor(),
      clock,
      onClose: (callback) => cleanup.push(callback),
    });
    try {
      await invoke(lazy.tool, { runId: 'run-1', stepId: 'step-1', toolCallId: 'call-1', signal: new AbortController().signal, mode: 'dry_run' });
      await Promise.all([lazy.close(), lazy.close(), ...cleanup.map((callback) => callback())]);
      expect(cleanup).toHaveLength(1);
    } finally {
      await f.lazy.close();
      await f.server.close();
    }
  });
});
