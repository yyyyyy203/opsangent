import { describe, expect, it, vi } from 'vitest';
import type { Clock, Tool, ToolCallOptions, ToolResponse, ToolResponseChunk } from '../src/contracts/index.js';
import { DefaultEvidenceRecorder } from '../src/application/evidence-recorder.js';
import { createLazySettlementEvidenceTool } from '../src/bootstrap/lazy-settlement-tool.js';
import { HttpMcpConnection } from '../src/infrastructure/mcp/http-connection.js';
import { startSettlementMcpServer } from '../src/infrastructure/mcp/settlement-server.js';
import type { SettlementSnapshot } from '../src/infrastructure/prometheus/settlement-source.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';
import { settlementInput, settlementInputSchema, settlementRemoteName } from '../src/mcp/settlement-protocol.js';
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
  const sourceExecutor = executor();
  const lazy = createLazySettlementEvidenceTool({
    mcpUrl: server.url,
    recorder: new DefaultEvidenceRecorder({ evidence }),
    executor: sourceExecutor,
    clock,
  });
  return { server, evidence, lazy, sourceExecutor };
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
    expect(lazy.tool.inputSchema).toBe(settlementInput);
    expect(settlementInput.safeParse({ service: 'checkout' }).success).toBe(true);
    expect(settlementInput.safeParse({ service: 'checkout', extra: 'denied' }).success).toBe(false);
    expect(settlementInput.safeParse({ service: 'other' }).success).toBe(false);
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

  it('uses the same deadline and network attempt ledger for connect, manifest, and call', async () => {
    const f = await fixture();
    try {
      const networkAttemptBudget = { remaining: 3 };
      const result = await invoke(f.lazy.tool, {
        runId: 'run-1', stepId: 'step-1', toolCallId: 'call-budget', signal: new AbortController().signal,
        mode: 'dry_run', deadline: clock.now().getTime() + 10_000, networkAttemptBudget,
      });

      expect(result.evidenceIds).toHaveLength(1);
      expect(networkAttemptBudget.remaining).toBe(0);
    } finally {
      await f.lazy.close();
      await f.server.close();
    }
  });

  it('passes one deadline and attempt ledger through connect and manifest listing', async () => {
    const f = await fixture();
    const executeSpy = vi.spyOn(f.sourceExecutor, 'execute');
    const attemptBudget = { remaining: 2 };
    const deadline = clock.now().getTime() + 30_000;
    try {
      await expect(invoke(f.lazy.tool, {
        runId: 'run-1', stepId: 'step-1', toolCallId: 'call-1', signal: new AbortController().signal,
        mode: 'dry_run', deadline, networkAttemptBudget: attemptBudget,
      })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

      expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({ deadline, attemptBudget });
      expect(executeSpy.mock.calls[1]?.[1]).toMatchObject({ deadline, attemptBudget });
      expect(attemptBudget.remaining).toBe(0);
    } finally {
      executeSpy.mockRestore();
      await f.lazy.close();
      await f.server.close();
    }
  });

  it.each([
    { name: 'missing remote tool', descriptors: [] },
    { name: 'schema-mismatched remote tool', descriptors: [{ name: settlementRemoteName, inputSchema: { type: 'object' } }] },
  ])('$name returns a safe protocol error without widening the local schema', async ({ descriptors }) => {
    const connect = vi.spyOn(HttpMcpConnection.prototype, 'connect').mockResolvedValue(undefined);
    const listTools = vi.spyOn(HttpMcpConnection.prototype, 'listTools').mockResolvedValue(descriptors);
    const close = vi.spyOn(HttpMcpConnection.prototype, 'close').mockResolvedValue(undefined);
    const lazy = createLazySettlementEvidenceTool({
      mcpUrl: 'http://metrics.example.test/mcp',
      recorder: new DefaultEvidenceRecorder({ evidence: new InMemoryEvidenceStore() }),
      executor: executor(),
      clock,
    });
    try {
      await expect(invoke(lazy.tool, {
        runId: 'run-1', stepId: 'step-1', toolCallId: 'call-1', signal: new AbortController().signal, mode: 'dry_run',
      })).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
      expect(lazy.tool.inputSchema).toBe(settlementInput);
      expect(settlementInput.safeParse({ service: 'checkout', extra: 'denied' }).success).toBe(false);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(listTools).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await lazy.close();
      connect.mockRestore();
      listTools.mockRestore();
      close.mockRestore();
    }
  });

  it('propagates a hanging manifest lookup as MCP_TIMEOUT', async () => {
    const connect = vi.spyOn(HttpMcpConnection.prototype, 'connect').mockResolvedValue(undefined);
    const listTools = vi.spyOn(HttpMcpConnection.prototype, 'listTools').mockImplementation(() => new Promise(() => {}));
    const close = vi.spyOn(HttpMcpConnection.prototype, 'close').mockResolvedValue(undefined);
    const lazy = createLazySettlementEvidenceTool({
      mcpUrl: 'http://metrics.example.test/mcp',
      recorder: new DefaultEvidenceRecorder({ evidence: new InMemoryEvidenceStore() }),
      executor: new ResilientExecutor(new SourceCircuitBreaker({ now: () => clock.now().getTime() }), {
        maxRetries: 0, timeoutMs: 10, now: () => clock.now().getTime(), sleep: () => Promise.resolve(),
      }),
      clock,
    });
    try {
      await expect(invoke(lazy.tool, {
        runId: 'run-1', stepId: 'step-1', toolCallId: 'call-1', signal: new AbortController().signal, mode: 'dry_run',
      })).rejects.toMatchObject({ code: 'MCP_TIMEOUT' });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await lazy.close();
      connect.mockRestore();
      listTools.mockRestore();
      close.mockRestore();
    }
  });

  it('does not return a bound tool when close races an in-flight connect', async () => {
    let started!: () => void;
    let release!: () => void;
    const connectStarted = new Promise<void>((resolve) => { started = resolve; });
    const connect = vi.spyOn(HttpMcpConnection.prototype, 'connect').mockImplementation(async (signal) => {
      started();
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(new Error('connect aborted')), { once: true });
      });
    });
    const listTools = vi.spyOn(HttpMcpConnection.prototype, 'listTools').mockResolvedValue([{
      name: settlementRemoteName, inputSchema: settlementInputSchema,
    }]);
    const close = vi.spyOn(HttpMcpConnection.prototype, 'close').mockResolvedValue(undefined);
    const lazy = createLazySettlementEvidenceTool({
      mcpUrl: 'http://metrics.example.test/mcp',
      recorder: new DefaultEvidenceRecorder({ evidence: new InMemoryEvidenceStore() }),
      executor: executor(),
      clock,
    });
    const call = invoke(lazy.tool, {
      runId: 'run-1', stepId: 'step-1', toolCallId: 'call-1', signal: new AbortController().signal, mode: 'dry_run',
    });
    try {
      await connectStarted;
      const closing = lazy.close();
      release();
      await expect(call).rejects.toMatchObject({ code: 'ABORTED' });
      await closing;
      expect(close).toHaveBeenCalledTimes(1);
      expect(listTools).not.toHaveBeenCalled();
    } finally {
      await lazy.close();
      connect.mockRestore();
      listTools.mockRestore();
      close.mockRestore();
    }
  });

  it('closes the connection once through direct and registered shutdown cleanup', async () => {
    const cleanup: Array<() => void | Promise<void>> = [];
    const f = await fixture();
    const close = vi.spyOn(HttpMcpConnection.prototype, 'close').mockResolvedValue(undefined);
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
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      await f.lazy.close();
      await f.server.close();
    }
  });
});
