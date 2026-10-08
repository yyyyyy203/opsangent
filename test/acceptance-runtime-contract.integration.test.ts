import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'langsmith';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, ChatModel, ModelCallOptions, ModelResponse, ModelStreamEvent, Tool } from '../src/contracts/index.js';
import { startAgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import { readAcceptanceSnapshot } from '../src/bootstrap/acceptance-reader.js';
import { createLangSmithEventObservability } from '../src/bootstrap/langsmith.js';
import { startSettlementMcpServer } from '../src/infrastructure/mcp/settlement-server.js';
import { startLogsMcpServer } from '../src/infrastructure/mcp/logs-server.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { ModelFailure } from '../src/model/model-failure.js';
import { createSmokeModelPolicy } from '../src/acceptance/smoke-model-policy.js';
import { AcceptanceDiagnosticsRecorder } from '../src/acceptance/diagnostics.js';
import { createAuditedLangSmithFetch } from '../src/acceptance/langsmith-export-transport.js';
import { createLangSmithQueryFetch } from '../src/acceptance/langsmith-query-transport.js';
import { verifyLangSmithTrace } from '../src/acceptance/langsmith-verifier.js';
import { isPublicBoundaryPayloadSafe } from '../src/acceptance/real-model-runner.js';
import { evaluateAcceptance } from '../src/acceptance/evaluator.js';
import { readSourceReports } from '../src/acceptance/source-reports.js';
import { ACCEPTANCE_LANGSMITH_EXPORT_LIMITS } from '../src/observability/langsmith-export-policy.js';
import type { AcceptanceInput } from '../src/acceptance/types.js';
import { createLangSmithMemoryServer } from './fixtures/langsmith-memory-server.js';

const window = { start: '2026-10-08T01:11:15.000Z', end: '2026-10-08T01:16:15.000Z' };
const metricFact = { status: 'breached' as const, total: 100, failed: 15, failureRate: 0.15,
  threshold: 0.05, minSamples: 20, service: 'checkout', environment: 'simulation',
  start: Date.parse(window.start) / 1000, end: Date.parse(window.end) / 1000 } as const;
const rawCanary = 'PRIVATE_RAW_CONTRACT_CANARY';
const config = { enabled: true, apiKey: 'offline-trace-key', projectName: 'contract-test', endpoint: 'https://smith.invalid' } as const;
let happy: Awaited<ReturnType<typeof produce>>;
let truncated: Awaited<ReturnType<typeof produce>>;

beforeAll(async () => {
  const localFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('EXTERNAL_NETWORK_BLOCKED');
    return localFetch(input, init);
  });
  happy = await produce(false);
  truncated = await produce(true);
}, 30000);
afterAll(() => { vi.unstubAllGlobals(); });

describe('actual runtime → SQLite → public projection → acceptance → LangSmith contract', () => {
  it('preserves the exact metric window and child-owned lifecycle produced by real tools', () => {
    expect(happy.input.evidence.find((evidence) => evidence.source === 'metric')?.timeRange).toEqual(window);
    expect(happy.input.children).toHaveLength(2);
    expect(happy.input.children.every((child) => child.status === 'completed')).toBe(true);
    for (const event of happy.input.events.filter((event) => event.type === 'SUBAGENT_STARTED')) {
      expect(happy.input.children.map((child) => child.runId)).toContain(event.runId);
    }
    const logsRunId = happy.input.evidence.find((evidence) => evidence.source === 'log')?.runId;
    expect(happy.input.diagnostics?.modelDecisions).toContainEqual(expect.objectContaining({
      runId: logsRunId, phase: 'report', maxOutputTokens: 1024,
    }));
    expect(happy.toolNames.filter((name) => name.startsWith('logs.'))).toEqual(['logs.capture', 'logs.search_evidence']);
  });

  it('passes hard checks but requires manual review after actual SDK export/readback', () => {
    const report = evaluateAcceptance(happy.input);
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(report.traceVerification.status).toBe('verified');
    expect(report.manualReview.status).toBe('pending');
    expect(report.verdict).toBe('review_required');
    expect(happy.remote.queries.length).toBeGreaterThan(0);
    expect(happy.remote.queries.every((query) => Array.isArray(query['id'])
      && (query['id'] as string[]).every((id) => happy.links.some((link) => link.remoteRunId === id)))).toBe(true);
    expect(JSON.stringify(report)).not.toContain(rawCanary);
    expect(JSON.stringify([...happy.remote.stored.values()])).not.toContain(rawCanary);
    expect(happy.input.evidence.every((evidence) => evidence.retrievable === false)).toBe(true);
  });

  it('does not promote a failed child even when known failed usage can be verified', () => {
    const report = evaluateAcceptance(truncated.input);
    expect(truncated.input.children.some((child) => child.status === 'failed')).toBe(true);
    expect(report.traceVerification.status).toBe('verified');
    expect(report.checks.find((check) => check.code === 'SCENARIO_OUTCOME_VALID')?.passed).toBe(false);
    expect(report.failures).toContainEqual(expect.objectContaining({ category: 'output_truncated' }));
    expect(report.usage.completeness).toBe('partial');
    expect(report.usage.outputTokens).toBeGreaterThanOrEqual(512);
    expect(report.verdict).toBe('failed');
    expect(truncated.calls).toBe(8);
    expect(readSourceReports(truncated.input.events).find((result) => result.source === 'logs')?.missingEvidence)
      .toEqual(expect.arrayContaining(['source_report', 'child_run_failed']));
  });

  it('keeps a real window mismatch as a distinct failing hard check', () => {
    const input = { ...happy.input, evidence: happy.input.evidence.map((evidence) => evidence.source === 'metric'
      ? { ...evidence, timeRange: { ...window, start: window.end } } : evidence) };
    expect(evaluateAcceptance(input).checks.find((check) => check.code === 'SOURCE_WINDOW_VALID')?.passed).toBe(false);
  });

  it('rejects a changed evidence ID without normalizing it to the original reference', () => {
    const input = { ...happy.input, evidence: happy.input.evidence.map((evidence) => evidence.source === 'log'
      ? { ...evidence, evidenceId: 'wrong-evidence-id' } : evidence) };
    expect(evaluateAcceptance(input).checks.find((check) => check.code === 'EVIDENCE_OWNERSHIP')?.passed).toBe(false);
  });

  it.each(['cross_parent', 'duplicate_start', 'duplicate_terminal'] as const)('rejects %s locally without remote queries', async (fault) => {
    const events = [...happy.input.events];
    const index = events.findIndex((event) => event.type === (fault === 'duplicate_terminal' ? 'SUBAGENT_COMPLETED' : 'SUBAGENT_STARTED'));
    const event = events[index];
    if (event === undefined) throw new Error('SOURCE_LIFECYCLE_MISSING');
    if (fault === 'cross_parent' && event.type === 'SUBAGENT_STARTED') {
      events[index] = { ...event, payload: { ...event.payload, parentRunId: 'another-parent' } };
    } else events.push(event);
    const remote = createLangSmithMemoryServer();
    const diagnostics = new AcceptanceDiagnosticsRecorder();
    const deps = { now: () => 0,
      onDiagnostic: (value: Parameters<AcceptanceDiagnosticsRecorder['recordTraceVerification']>[0]) => diagnostics.recordTraceVerification(value) };
    const result = await verifyLangSmithTrace({ client: queryClient(remote), links: happy.links,
      snapshot: { ...happy.input, events } }, deps);
    expect(result.status).toBe('failed');
    expect(remote.queries).toHaveLength(0);
    expect(diagnostics.snapshot().traceVerification).toMatchObject({ reason: 'invalid_source_invocation', remoteQueriesSent: 0 });
  });

  it.each(['missing_span', 'usage_mismatch'] as const)('distinguishes remote %s without another model call', async (fault) => {
    const remote = createLangSmithMemoryServer();
    for (const [id, run] of happy.remote.stored) remote.stored.set(id, structuredClone(run));
    const model = [...remote.stored].find(([, run]) => run['run_type'] === 'llm');
    if (model === undefined) throw new Error('MODEL_SPAN_MISSING');
    if (fault === 'missing_span') remote.stored.delete(model[0]);
    else model[1]['outputs'] = { status: 'completed', usage_metadata: { input_tokens: 100, output_tokens: 999, total_tokens: 1099 } };
    const diagnostics = new AcceptanceDiagnosticsRecorder();
    const deps = { now: () => 0, sleep: async () => {},
      onDiagnostic: (value: Parameters<AcceptanceDiagnosticsRecorder['recordTraceVerification']>[0]) => diagnostics.recordTraceVerification(value) };
    const verified = await verifyLangSmithTrace({ client: queryClient(remote), links: happy.links, snapshot: happy.input }, deps);
    expect(verified.status).toBe(fault === 'missing_span' ? 'unavailable' : 'failed');
    expect(diagnostics.snapshot().traceVerification?.reason).toBe(fault === 'missing_span' ? 'remote_unavailable' : 'usage_mismatch');
    expect(remote.queries.length).toBeLessThanOrEqual(3);
  });
});

function queryClient(remote: ReturnType<typeof createLangSmithMemoryServer>): Client {
  return new Client({ apiUrl: config.endpoint, apiKey: config.apiKey, callerOptions: { maxRetries: 0 },
    fetchImplementation: createLangSmithQueryFetch(remote.fetch, config.endpoint) });
}

async function produce(fail: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'agentops-contract-'));
  const runId = fail ? 'contract-truncated' : 'contract-completed';
  const diagnostics = new AcceptanceDiagnosticsRecorder();
  const remote = createLangSmithMemoryServer();
  let auditSafe = true;
  const tracing = createLangSmithEventObservability(config, { limits: ACCEPTANCE_LANGSMITH_EXPORT_LIMITS,
    fetch: createAuditedLangSmithFetch(remote.fetch, config, [config.apiKey, rawCanary], () => { auditSafe = false; },
      { limits: ACCEPTANCE_LANGSMITH_EXPORT_LIMITS, onDiagnostic: (value) => diagnostics.recordTraceRequest(value) }) });
  const counter = { calls: 0, toolNames: [] as string[] };
  const model = (delegate: ChatModel): ChatModel => createSmokeModelPolicy({
    async *stream(messages, tools, options) { counter.calls += 1; return yield* delegate.stream(messages, tools, options); },
  }, { onDecision: (value) => diagnostics.recordModelDecision(value) });
  const metric = await startSettlementMcpServer({ query: () => Promise.resolve({ status: 'available',
    start: metricFact.start, end: metricFact.end, counts: { total: 100, failed: 15 }, raw: { marker: rawCanary } }) }, { port: 0 });
  const logs = await startLogsMcpServer({
    searchPage: () => Promise.resolve({ status: 'available', sourceSnapshotId: 'contract-snapshot', records: [{
      timestamp: window.end, service: 'checkout', level: 'ERROR', message: `checkout timeout ${rawCanary}`,
    }] }), closeSnapshot: async () => {}, close: async () => {},
  }, { port: 0 });
  let web: Awaited<ReturnType<typeof startAgentWebRuntime>> | undefined;
  try {
    const sourceInput = { profileId: 'simulation', service: 'checkout', ...window, question: '检查结算失败' };
    web = await startAgentWebRuntime({ dataDirectory: directory, workspaceRoots: [directory], port: 0,
      clock: { now: () => new Date(window.end) }, modelIdentity: { provider: 'test-provider', model: 'scripted-model' },
      model: model(new ScriptedModel([{ toolCalls: [
        { id: 'parent-metrics', name: 'metrics_subagent', input: sourceInput },
        { id: 'parent-logs', name: 'logs_subagent', input: sourceInput },
      ], usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 50 }, finishReason: 'tool_calls' },
      { text: '取证结束，缺失项以来源报告为准。', toolCalls: [], usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 50 }, finishReason: 'stop' }])),
      metrics: { profileId: 'simulation', mcpUrl: metric.url, childModel: model(new SourceScript('metrics', false, counter.toolNames)) },
      logs: { profileId: 'simulation', mcpUrl: logs.url, cursorSecret: 'offline-cursor-secret-0123456789012345',
        childModel: model(new SourceScript('logs', fail, counter.toolNames)) },
      sourceWindow: window, sourceInvocationLimit: 1, eventObservability: tracing.eventObservability,
    });
    const started = await fetch(`${web.url}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, profileId: 'simulation', message: '检查结算失败', maxToolCalls: 12 }) });
    expect(started.status).toBe(202);
    await vi.waitFor(async () => {
      const detail = await (await fetch(`${web?.url}/runs/${runId}`)).json() as { status: string };
      expect(detail.status).toBe('completed');
    }, { timeout: 10000, interval: 10 });
    await web.flushEventObservability();
    const publicEvidence = await (await fetch(`${web.url}/runs/${runId}/evidence`)).json() as unknown;
    expect(JSON.stringify(publicEvidence)).not.toContain(rawCanary);
    await web.close(); web = undefined;
    const snapshot = await readAcceptanceSnapshot({ dataDirectory: directory, runId });
    const links = tracing.getTraceLinks();
    const verificationDependencies = { sleep: async () => {},
      onDiagnostic: (value: Parameters<AcceptanceDiagnosticsRecorder['recordTraceVerification']>[0]) => diagnostics.recordTraceVerification(value) };
    const traceVerification = await verifyLangSmithTrace({ client: queryClient(remote), links, snapshot }, verificationDependencies);
    const input: AcceptanceInput = { ...snapshot, caseId: 'settlement_failure', codeRevision: 'offline-contract',
      sourceFingerprint: 'a'.repeat(64), profileRevision: 'simulation-v1', snapshotId: 'contract-snapshot',
      metricFact, reports: readSourceReports(snapshot.events), budget: { limit: 10, sent: 0, attempted: 0, rejected: 0 },
      exportDiagnostics: tracing.getDiagnostics(), traceVerification, manualReview: { status: 'pending' },
      diagnostics: diagnostics.snapshot(), boundaryChecks: { publicDataSafe: isPublicBoundaryPayloadSafe(snapshot), traceExportSafe: auditSafe } };
    return { input, remote, links, calls: counter.calls, toolNames: counter.toolNames };
  } finally {
    await web?.close();
    await Promise.all([metric.close(), logs.close()]);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Uses actual returned evidence IDs, never manufactured public evidence/events. */
class SourceScript implements ChatModel {
  private turn = 0;
  constructor(private readonly source: 'metrics' | 'logs', private readonly fail: boolean, private readonly names: string[]) {}
  async *stream(messages: AgentMessage[], tools: Tool[], options: ModelCallOptions): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    await Promise.resolve();
    options.signal.throwIfAborted();
    const turn = ++this.turn;
    if (this.fail && turn === 3) throw new ModelFailure('output_truncated', 'MODEL_OUTPUT_TRUNCATED', false, {},
      { disposition: 'terminal', usage: { inputTokens: 100, outputTokens: 512, cachedInputTokens: 50 }, finishReason: 'length' });
    const evidenceId = messages.flatMap((message) => message.blocks).flatMap((block) => block.type === 'tool_result'
      ? block.result.response?.evidenceIds ?? [] : [])[0];
    const query = this.source === 'logs' ? 'logs.capture' : 'metrics.settlement';
    const name = turn === 1 ? query : this.source === 'logs' && turn === 2 ? 'logs.search_evidence'
      : turn === (this.source === 'logs' ? 3 : 2) ? 'source_report' : undefined;
    if (name !== undefined && !tools.some((tool) => tool.name === name)) throw new Error('SCRIPT_TOOL_NOT_REGISTERED');
    const input = name === 'logs.capture' ? { service: 'checkout', ...window }
      : name === 'metrics.settlement' ? { service: 'checkout' }
      : name === 'logs.search_evidence' ? { evidenceId, limit: 1 }
      : { summary: '发现结算异常。', findings: [{ kind: 'observation', statement: '结算异常。', evidenceIds: [evidenceId] }],
        businessTraceIds: [], missingEvidence: [] };
    if (name !== undefined) this.names.push(name);
    const response: ModelResponse = { toolCalls: name === undefined ? [] : [{ id: `${this.source}-call-${turn}`, name, input }],
      ...(name === undefined ? { text: '来源报告结束。' } : {}),
      usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 50 }, finishReason: name === undefined ? 'stop' : 'tool_calls' };
    for (const call of response.toolCalls) yield { type: 'tool_call', call };
    return response;
  }
}
