import { describe, expect, it } from 'vitest';
import type { Tool, ToolCallOptions, ToolResponse, ToolResponseChunk } from '../src/contracts/index.js';
import { bindSettlementEvidenceTool } from '../src/bootstrap/settlement-evidence-tool.js';
import { startSettlementMcpServer } from '../src/infrastructure/mcp/settlement-server.js';
import { HttpMcpConnection } from '../src/infrastructure/mcp/http-connection.js';
import type { SettlementSnapshot } from '../src/infrastructure/prometheus/settlement-source.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';
import { InMemoryEvidenceStore } from '../src/storage/in-memory-evidence-store.js';

async function invoke(tool: Tool, options: ToolCallOptions): Promise<ToolResponse> {
  if (tool.call === undefined) throw new Error('Settlement tool call is unavailable');
  const invocation = tool.call({ service: 'checkout' }, options);
  if (typeof invocation !== 'object' || invocation === null || !(Symbol.asyncIterator in invocation)) {
    throw new Error('Settlement tool must stream its result');
  }
  const iterator = invocation as AsyncGenerator<ToolResponseChunk, ToolResponse>;
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();
  return next.value;
}

describe('settlement evidence recovery', () => {
  it('derives one stable evidence identity and rejects changed raw content for the same capture', async () => {
    let current: SettlementSnapshot = {
      status: 'available', counts: { total: 100, failed: 15 }, start: 700, end: 1000,
      raw: { marker: 'original-raw' },
    };
    const server = await startSettlementMcpServer({ query: () => Promise.resolve(current) }, { port: 0 });
    const connection = new HttpMcpConnection({ url: server.url });
    const evidence = new InMemoryEvidenceStore();
    const signal = new AbortController().signal;
    await connection.connect(signal);
    const tool = await bindSettlementEvidenceTool({
      connection,
      evidence,
      signal,
      executor: new ResilientExecutor(new SourceCircuitBreaker(), { sleep: () => Promise.resolve() }),
      now: () => 1_010_000,
    });
    const options: ToolCallOptions = {
      runId: 'child-run-1', stepId: 'step-1', toolCallId: 'metric-call-1', signal, mode: 'dry_run',
    };

    try {
      const first = await invoke(tool, options);
      const evidenceId = first.evidenceIds?.[0];
      if (evidenceId === undefined) throw new Error('Missing evidence ID');
      const second = await invoke(tool, options);

      expect(second.evidenceIds).toEqual([evidenceId]);
      expect(await evidence.get(evidenceId)).toMatchObject({
        evidenceId,
        captureKey: 'metric:child-run-1:metric-call-1:0',
        raw: { marker: 'original-raw' },
      });

      current = { ...current, raw: { marker: 'changed-raw' } };
      await expect(invoke(tool, options)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
      expect(await evidence.get(evidenceId)).toMatchObject({ raw: { marker: 'original-raw' } });
    } finally {
      await connection.close();
      await server.close();
    }
  });
});
