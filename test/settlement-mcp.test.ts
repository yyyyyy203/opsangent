import { describe, expect, it } from 'vitest';
import { startSettlementMcpServer } from '../src/infrastructure/mcp/settlement-server.js';
import { HttpMcpConnection } from '../src/infrastructure/mcp/http-connection.js';
import { bindSettlementEvidenceTool } from '../src/bootstrap/settlement-evidence-tool.js';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { InMemoryEvidenceStore } from '../src/storage/in-memory-evidence-store.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../src/mcp/resilience.js';
import { PrometheusQueryError, type SettlementSnapshot } from '../src/infrastructure/prometheus/settlement-source.js';

const snapshot: SettlementSnapshot = { status: 'available', counts: { total: 100, failed: 15 }, start: 700, end: 1000, raw: { original: 'raw-only-marker' } };
async function fixture(query: (signal: AbortSignal) => Promise<SettlementSnapshot>, failStorage = false) {
  const server = await startSettlementMcpServer({ query }, { port: 0 });
  const connection = new HttpMcpConnection({ url: server.url });
  const evidence = new InMemoryEvidenceStore();
  const signal = new AbortController().signal;
  await connection.connect(signal);
  const tool = await bindSettlementEvidenceTool({ connection, evidence: failStorage ? { get: (id) => evidence.get(id), save: () => Promise.reject(new Error('private-storage-detail')) } : evidence,
    signal, executor: new ResilientExecutor(new SourceCircuitBreaker(), { sleep: () => Promise.resolve() }),
    id: () => 'evidence-1', now: () => 1_010_000 });
  return { server, connection, tool, evidence, async close() { await connection.close(); await server.close(); } };
}
async function inspect(f: Awaited<ReturnType<typeof fixture>>, input: Record<string, unknown> = { service: 'checkout' }) {
  const runtime = createInspectionRuntime({ model: new ScriptedModel([
    { toolCalls: [{ id: 'call-1', name: f.tool.name, input }] }, { toolCalls: [] },
  ]), workspaceRoots: [], tools: [f.tool], allowedToolNames: [f.tool.name] });
  const run = await runtime.agent.reply({ message: 'inspect', profileId: 'simulation' });
  const context = await runtime.checkpoints.load(run.runId);
  const block = context?.messages.flatMap((message) => message.blocks).find((item) => item.type === 'tool_result');
  if (block?.type !== 'tool_result') throw new Error('Missing result');
  return { run, context, result: block.result };
}
describe('settlement MCP to Harness evidence integration', () => {
  it('persists raw evidence before returning a deterministic finding with a reference', async () => {
    const f = await fixture(() => Promise.resolve(snapshot));
    try {
      const { run, context, result } = await inspect(f);
      expect(result.status).toBe('success');
      expect(result.response?.evidenceIds).toEqual(['evidence-1']);
      expect(result.response?.blocks).toContainEqual({ type: 'evidence_ref', evidenceId: 'evidence-1' });
      expect(await f.evidence.get('evidence-1')).toMatchObject({ runId: run.runId, source: 'metric', raw: snapshot.raw, summary: { status: 'breached', failureRate: 0.15, missingEvidence: ['logs', 'traces'] } });
      expect(JSON.stringify(context)).not.toContain('raw-only-marker');
    } finally { await f.close(); }
  });
  it('retries upstream transient errors through the existing client budget', async () => {
    let calls = 0;
    const f = await fixture(() => ++calls < 3 ? Promise.reject(new PrometheusQueryError('PROMETHEUS_HTTP_ERROR', 503)) : Promise.resolve(snapshot));
    try { expect((await inspect(f)).result.status).toBe('success'); expect(calls).toBe(3); }
    finally { await f.close(); }
  });
  it('does not retry upstream authentication failures', async () => {
    let calls = 0;
    const f = await fixture(() => { calls++; return Promise.reject(new PrometheusQueryError('PROMETHEUS_HTTP_ERROR', 401)); });
    try { expect((await inspect(f)).result.error?.code).toBe('MCP_AUTH_ERROR'); expect(calls).toBe(1); }
    finally { await f.close(); }
  });
  it('returns insufficient evidence without inventing evidence references', async () => {
    const f = await fixture(() => Promise.resolve({ status: 'unavailable', reason: 'missing_series' }));
    try {
      const { result } = await inspect(f);
      expect(result.response?.blocks).toContainEqual({ type: 'json', value: { status: 'insufficient_data', reason: 'missing_series', missingEvidence: ['metrics', 'logs', 'traces'] } });
      expect(await f.evidence.get('evidence-1')).toBeNull();
    } finally { await f.close(); }
  });
  it('fails closed if evidence persistence fails', async () => {
    const f = await fixture(() => Promise.resolve(snapshot), true);
    try {
      const { result } = await inspect(f);
      expect(result.status).toBe('failed'); expect(result.error?.code).toBe('STORAGE_ERROR');
      expect(JSON.stringify(result)).not.toContain('private-storage-detail');
      expect(result.response?.evidenceIds).toBeUndefined();
    } finally { await f.close(); }
  });
  it('rejects out-of-scope queries before contacting the source', async () => {
    let calls = 0;
    const f = await fixture(() => { calls++; return Promise.resolve(snapshot); });
    try { expect((await inspect(f, { service: 'other' })).result.status).toBe('failed'); expect(calls).toBe(0); }
    finally { await f.close(); }
  });
  it('denies browser-origin requests and unknown paths', async () => {
    const f = await fixture(() => Promise.resolve(snapshot));
    try {
      expect((await fetch(f.server.url, { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
      expect((await fetch(f.server.url + '/other')).status).toBe(404);
    } finally { await f.close(); }
  });
});
