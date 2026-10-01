import { describe, expect, it } from 'vitest';
import { DefaultEvidenceRecorder } from '../src/application/evidence-recorder.js';
import { bindSettlementEvidenceTool } from '../src/bootstrap/settlement-evidence-tool.js';
import { startSettlementMcpServer } from '../src/infrastructure/mcp/settlement-server.js';
import { HttpMcpConnection } from '../src/infrastructure/mcp/http-connection.js';
import type { SettlementSnapshot } from '../src/infrastructure/prometheus/settlement-source.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';
import { InMemoryEvidenceStore } from '../src/storage/in-memory-evidence-store.js';

describe('settlement evidence binding compatibility', () => {
  it('keeps the eager binding contract and fixed local schema', async () => {
    const snapshot: SettlementSnapshot = { status: 'available', counts: { total: 20, failed: 1 }, start: 700, end: 1000, raw: {} };
    const server = await startSettlementMcpServer({ query: () => Promise.resolve(snapshot) }, { port: 0 });
    const connection = new HttpMcpConnection({ url: server.url });
    const signal = new AbortController().signal;
    const evidence = new InMemoryEvidenceStore();
    try {
      await connection.connect(signal);
      const tool = await bindSettlementEvidenceTool({
        connection,
        recorder: new DefaultEvidenceRecorder({ evidence }),
        executor: new ResilientExecutor(new SourceCircuitBreaker(), { maxRetries: 0 }),
        signal,
        now: () => 1_010_000,
      });
      expect(tool.name).toBe('metrics.settlement');
      expect(tool.kind).toBe('evidence');
      expect(tool.source).toBe('mcp');
    } finally {
      await connection.close();
      await server.close();
    }
  });
});
