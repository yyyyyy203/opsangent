import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMetricsSubagentTool } from '../src/bootstrap/metrics-subagent.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { settlementMetricsLabProfile } from '../src/profiles/settlement.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { InMemoryCheckpointStore } from '../src/storage/in-memory-checkpoint-store.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import type { AgentContext, AgentEventEnvelopeV2, CheckpointStore, Tool, ToolResponse } from '../src/contracts/index.js';
import type { DiagnosisRunResult } from '../src/agent/types.js';

const tool: Tool = { name: 'metrics.settlement', kind: 'evidence', source: 'mcp',
  description: 'settlement', inputSchema: z.object({ service: z.literal('checkout') }).strict(),
  call: () => ({ blocks: [] }) };
const now = Date.parse('2026-09-15T00:05:00.000Z');
const request = { profileId: 'simulation', service: 'checkout', question: '调查结算',
  start: new Date(now - 300_000).toISOString(), end: new Date(now).toISOString() };

async function drain(metrics: Tool, options: { toolCallId?: string; remainingToolCalls?: number;
  networkAttemptBudget?: { remaining: number }; signal?: AbortSignal } = {}): Promise<ToolResponse> {
  const invocation = metrics.call?.(request, { runId: 'parent-run', stepId: 'step',
    toolCallId: options.toolCallId ?? 'parent-tool', profileId: 'simulation', mode: 'execute',
    signal: options.signal ?? new AbortController().signal,
    remainingToolCalls: options.remainingToolCalls ?? 8,
    ...(options.networkAttemptBudget === undefined ? {} : { networkAttemptBudget: options.networkAttemptBudget }) });
  if (!invocation || typeof invocation !== 'object' || !(Symbol.asyncIterator in invocation)) throw new Error('stream expected');
  const stream = invocation as AsyncGenerator<unknown, ToolResponse>;
  while (true) { const item = await stream.next(); if (item.done) return item.value; }
}

describe('metrics_subagent recovery boundaries', () => {
  it('preserves stable child identity and shared network ledger on retry', async () => {
    const ids: string[] = [];
    const ledgers: Array<{ remaining: number } | undefined> = [];
    const ledger = { remaining: 4 };
    const metrics = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: tool,
      clock: { now: () => new Date(now) }, childAgentFactory: { create: (input) => {
        ids.push(input.childRunId);
        ledgers.push(input.networkAttemptBudget);
        throw Object.assign(new Error('temporary timeout'), { code: 'MCP_TIMEOUT', retryable: true });
      } } });
    await expect(drain(metrics, { networkAttemptBudget: ledger })).rejects.toMatchObject({ code: 'MCP_TIMEOUT' });
    expect(ids).toEqual(['source-child-metrics-bc5da3c132427d10deb0bedd76a21305',
      'source-child-metrics-bc5da3c132427d10deb0bedd76a21305']);
    expect(ledgers).toEqual([ledger, ledger]);
    expect(ledgers[0]).toBe(ledger);
    expect(ledgers[1]).toBe(ledger);
  });

  it('emits STARTED, RETRY_SCHEDULED, COMPLETED once across a transient timeout', async () => {
    const events: AgentEventEnvelopeV2[] = [];
    const start = new Date(now - 300_000).toISOString();
    const end = new Date(now).toISOString();
    const ids = { next: (prefix: string) => `${prefix}-${events.length + 1}` };
    let creates = 0;
    const metrics = createMetricsSubagentTool({ profile: settlementMetricsLabProfile,
      clock: { now: () => new Date(now) },
      lifecycle: { ids, correlationId: (runId) => `run:${runId}`,
        factory: new EventFactoryV2({ now: () => new Date(now) }, ids),
        publisher: { publish: (event) => {
          const stored = { ...event, sequence: events.length + 1 } as AgentEventEnvelopeV2;
          events.push(stored);
          return Promise.resolve(stored);
        } },
      },
      settlementTool: { ...tool, call: () => ({ blocks: [
        { type: 'json', value: { status: 'healthy', total: 100, failed: 0, failureRate: 0,
          threshold: 0.05, minSamples: 20, service: 'checkout', environment: 'simulation',
          start: (now - 300_000) / 1_000, end: now / 1_000 } },
        { type: 'evidence_ref', evidenceId: 'metric-evidence-1' }],
        evidenceIds: ['metric-evidence-1'], metadata: { sourceEvidence: { schemaVersion: 1, source: 'metrics',
          evidenceId: 'metric-evidence-1', state: 'committed', coverage: 1, timeRange: { start, end }, missingEvidence: [] } },
      }) },
      childAgentFactory: { create: (input) => {
        creates += 1;
        if (creates === 1) throw Object.assign(new Error('timeout'), { code: 'MCP_TIMEOUT', retryable: true });
        return createAgentRuntime({ model: new ScriptedModel([
          { toolCalls: [{ id: 'metric-1', name: 'metrics.settlement', input: { service: 'checkout' } }] },
          { toolCalls: [{ id: 'report-1', name: 'source_report', input: { summary: '完成',
            findings: [{ kind: 'observation', statement: '正常', evidenceIds: ['metric-evidence-1'] }],
            businessTraceIds: [], missingEvidence: [] } }] },
          { text: '完成', toolCalls: [] },
        ]), tools: [...input.tools], workspaceRoots: [], includeExternalBash: false }).agent;
      } },
    });
    const result = await drain(metrics);
    expect(result.blocks[0]).toMatchObject({ type: 'json', value: { status: 'complete' } });
    expect(creates).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      'SUBAGENT_STARTED', 'SUBAGENT_RETRY_SCHEDULED', 'SUBAGENT_COMPLETED',
    ]);
  });

  it('does not create a child on abort or an exhausted two-call budget', async () => {
    let created = 0;
    const metrics = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: tool,
      clock: { now: () => new Date(now) }, childAgentFactory: { create: () => { created += 1; throw new Error('unexpected'); } } });
    await expect(drain(metrics, { remainingToolCalls: 1 })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    const controller = new AbortController(); controller.abort();
    await expect(drain(metrics, { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(created).toBe(0);
  });

  it('returns partial with the observed evidence when the child model fails after collection', async () => {
    const start = new Date(now - 300_000).toISOString();
    const end = new Date(now).toISOString();
    const settlement: Tool = { ...tool, call: () => ({
      blocks: [
        { type: 'json', value: { status: 'healthy', total: 100, failed: 0, failureRate: 0,
          threshold: 0.05, minSamples: 20, service: 'checkout', environment: 'simulation',
          start: (now - 300_000) / 1_000, end: now / 1_000 } },
        { type: 'evidence_ref', evidenceId: 'metric-evidence-1' },
      ],
      evidenceIds: ['metric-evidence-1'],
      metadata: { sourceEvidence: { schemaVersion: 1, source: 'metrics', evidenceId: 'metric-evidence-1',
        state: 'committed', coverage: 1, timeRange: { start, end }, missingEvidence: [] } },
    }) };
    const metrics = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: settlement,
      clock: { now: () => new Date(now) }, childAgentFactory: { create: (input) => createAgentRuntime({
        model: new ScriptedModel([
          { toolCalls: [{ id: 'metric-1', name: 'metrics.settlement', input: { service: 'checkout' } }] },
        ]), tools: [...input.tools], workspaceRoots: [], includeExternalBash: false,
      }).agent } });
    const response = await drain(metrics);
    expect(response.blocks[0]).toMatchObject({ type: 'json', value: {
      status: 'partial', evidenceIds: ['metric-evidence-1'], missingEvidence: ['source_report', 'child_run_failed'],
    } });
    expect(response.evidenceIds).toEqual(['metric-evidence-1']);
  });

  it('resumes an existing child checkpoint instead of starting a new reply', async () => {
    const calls: string[] = [];
    const checkpoints: CheckpointStore = {
      load: () => Promise.resolve({ status: 'paused', messages: [] } as unknown as AgentContext),
      save: () => Promise.resolve(), hasExecuted: () => Promise.resolve(false), recordExecuted: () => Promise.resolve(),
    };
    const metrics = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: tool,
      clock: { now: () => new Date(now) }, checkpoints,
      childAgentFactory: { create: () => ({
        replyStream: async function* () { await Promise.resolve(); yield* [];
          calls.push('reply'); return {} as DiagnosisRunResult; },
        resumeStream: async function* (runId) { await Promise.resolve(); yield* [];
          calls.push(`resume:${runId}`);
          return { runId, profileId: 'simulation', status: 'completed', finalText: '', contextVersion: 1 } as DiagnosisRunResult; },
      }) },
    });
    const result = await drain(metrics);
    expect(result.blocks[0]).toMatchObject({ type: 'json', value: { status: 'unavailable' } });
    expect(calls).toEqual(['resume:source-child-metrics-bc5da3c132427d10deb0bedd76a21305']);
  });

  it('reuses a completed child checkpoint without calling metrics.settlement twice', async () => {
    const start = new Date(now - 300_000).toISOString();
    const end = new Date(now).toISOString();
    const checkpoints = new InMemoryCheckpointStore();
    let sourceCalls = 0;
    let childCreates = 0;
    const settlement: Tool = { ...tool, call: () => {
      sourceCalls += 1;
      return { blocks: [
        { type: 'json', value: { status: 'healthy', total: 100, failed: 0, failureRate: 0,
          threshold: 0.05, minSamples: 20, service: 'checkout', environment: 'simulation',
          start: (now - 300_000) / 1_000, end: now / 1_000 } },
        { type: 'evidence_ref', evidenceId: 'metric-evidence-1' }],
        evidenceIds: ['metric-evidence-1'],
        metadata: { sourceEvidence: { schemaVersion: 1, source: 'metrics', evidenceId: 'metric-evidence-1',
          state: 'committed', coverage: 1, timeRange: { start, end }, missingEvidence: [] } },
      };
    } };
    const metrics = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: settlement,
      clock: { now: () => new Date(now) }, checkpoints,
      childAgentFactory: { create: (input) => {
        childCreates += 1;
        return createAgentRuntime({ model: new ScriptedModel([
          { toolCalls: [{ id: 'metric-1', name: 'metrics.settlement', input: { service: 'checkout' } }] },
          { toolCalls: [{ id: 'report-1', name: 'source_report', input: { summary: '完成',
            findings: [{ kind: 'observation', statement: '正常', evidenceIds: ['metric-evidence-1'] }],
            businessTraceIds: [], missingEvidence: [] } }] },
          { text: '完成', toolCalls: [] },
        ]), tools: [...input.tools], checkpoints, workspaceRoots: [], includeExternalBash: false }).agent;
      } },
    });
    const first = await drain(metrics);
    const second = await drain(metrics);
    expect(first.blocks[0]).toMatchObject({ type: 'json', value: { status: 'complete' } });
    expect(second.blocks[0]).toMatchObject({ type: 'json', value: { status: 'complete' } });
    expect(sourceCalls).toBe(1);
    expect(childCreates).toBe(1);
  });

  it.each(['ABORTED', 'INVALID_INPUT', 'POLICY_DENIED', 'BUDGET_EXCEEDED'] as const)(
    'never retries terminal %s child errors', async (code) => {
      let creates = 0;
      const metrics = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: tool,
        clock: { now: () => new Date(now) }, childAgentFactory: { create: () => {
          creates += 1;
          throw Object.assign(new Error(code), { code, retryable: false });
        } } });
      await expect(drain(metrics)).rejects.toMatchObject({ code });
      expect(creates).toBe(1);
    },
  );
});
