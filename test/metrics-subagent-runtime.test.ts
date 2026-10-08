import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { createMetricsSubagentTool } from '../src/bootstrap/metrics-subagent.js';
import { settlementMetricsLabProfile } from '../src/profiles/settlement.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import type { SourceChildAgentFactory } from '../src/application/source-subagent-runner.js';
import type { Tool, ToolResponse } from '../src/contracts/index.js';

const now = Date.parse('2026-09-15T00:05:00.000Z');
const start = new Date(now - 300_000).toISOString();
const end = new Date(now).toISOString();
const request = { profileId: 'simulation', service: 'checkout', start, end, question: '结算失败率是否升高？' };
const evidenceId = 'metric-evidence-1';

function settlementTool(total = 100, failed = 0): Tool {
  const status = total < 20 ? 'insufficient_data' : failed / total > 0.05 ? 'breached' : 'healthy';
  const response: ToolResponse = {
    blocks: [
      { type: 'json', value: { status, total, failed, failureRate: failed / total,
        threshold: 0.05, minSamples: 20, service: 'checkout', environment: 'simulation',
        start: (now - 300_000) / 1_000, end: now / 1_000 } },
      { type: 'evidence_ref', evidenceId },
    ],
    evidenceIds: [evidenceId],
    metadata: { sourceEvidence: { schemaVersion: 1, source: 'metrics', evidenceId,
      state: 'committed', coverage: 1, timeRange: { start, end }, missingEvidence: [] } },
  };
  return { name: 'metrics.settlement', description: 'settlement', kind: 'evidence', source: 'mcp',
    inputSchema: z.object({ service: z.literal('checkout') }).strict(),
    call: () => response };
}

function childFactory(observed: (tools: readonly Tool[]) => void, report = true): SourceChildAgentFactory {
  return { create: (input) => {
    observed(input.tools);
    return createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'metric-1', name: 'metrics.settlement', input: { service: 'checkout' } }] },
        ...(report ? [{ toolCalls: [{ id: 'report-1', name: 'source_report', input: {
          summary: '错误数字 99%，数据库是根因',
          findings: [{ kind: 'inference' as const, statement: '数据库是根因', evidenceIds: [evidenceId] }],
          businessTraceIds: [], missingEvidence: [],
        } }] }] : []),
        { text: '完成', toolCalls: [] },
      ]), workspaceRoots: [], includeExternalBash: false, tools: [...input.tools],
    }).agent;
  } };
}

async function drain(tool: Tool, input: Record<string, unknown>, remainingToolCalls = 8): Promise<ToolResponse> {
  const value = tool.call?.(input, { toolCallId: 'parent-tool-1', runId: 'parent-run-1', stepId: 'parent-step-1',
    profileId: 'simulation', signal: new AbortController().signal, mode: 'execute', remainingToolCalls });
  if (value === undefined || typeof value !== 'object' || !(Symbol.asyncIterator in value)) throw new Error('expected stream');
  const stream = value as AsyncGenerator<unknown, ToolResponse>;
  while (true) { const item = await stream.next(); if (item.done) return item.value; }
}

describe('metrics_subagent runtime composition', () => {
  it.each([[100, 0, 'complete', '正常', '0.00%'], [100, 15, 'complete', '异常', '15.00%'],
    [10, 8, 'complete', '样本不足', '80.00%']] as const)(
    'runs parent and child Harness for %i/%i', async (total, failed, status, word, rate) => {
      let childTools: readonly Tool[] = [];
      const metricsTool = createMetricsSubagentTool({ profile: settlementMetricsLabProfile,
        settlementTool: settlementTool(total, failed), childAgentFactory: childFactory((tools) => { childTools = tools; }),
        clock: { now: () => new Date(now) } });
      const parent = createInspectionRuntime({ model: new ScriptedModel([
        { toolCalls: [{ id: 'parent-tool-1', name: 'metrics_subagent', input: request }] },
        { text: '完成', toolCalls: [] },
      ]), workspaceRoots: [], sourceSubagentTools: [metricsTool], allowedToolNames: ['metrics_subagent'] });
      expect(parent.toolkit.get('metrics_subagent')).toBeDefined();
      expect(parent.toolkit.get('metrics.settlement')).toBeUndefined();
      const result = await parent.agent.reply({ message: '检查结算', profileId: 'simulation' });
      expect(result.status).toBe('completed');
      expect(childTools.map((tool) => tool.name)).toEqual(['metrics.settlement', 'source_report']);
      const context = await parent.checkpoints.load(result.runId);
      const responses = context?.messages.flatMap((message) => message.blocks)
        .filter((block) => block.type === 'tool_result' && block.result.toolName === 'metrics_subagent');
      expect(responses).toHaveLength(1);
      const response = responses?.[0];
      if (response?.type !== 'tool_result') throw new Error('missing parent ToolResult');
      const facts = response.result.response?.blocks[0];
      if (facts?.type !== 'json') throw new Error('missing result');
      expect(facts.value).toMatchObject({ status, source: 'metrics', evidenceIds: [evidenceId] });
      expect(JSON.stringify(facts.value)).toContain(word);
      expect(JSON.stringify(facts.value)).toContain(rate);
      expect(JSON.stringify(facts.value)).not.toContain('数据库是根因');
      await parent.close();
    },
  );

  it.each([
    [{ ...request, profileId: 'other' }, 'POLICY_DENIED'],
    [{ ...request, service: 'payments' }, 'POLICY_DENIED'],
    [{ ...request, start: new Date(now - 299_000).toISOString() }, 'INVALID_INPUT'],
    [{ ...request, end: new Date(now - 121_000).toISOString(), start: new Date(now - 421_000).toISOString() }, 'INVALID_INPUT'],
    [{ ...request, end: new Date(now + 31_000).toISOString(), start: new Date(now - 269_000).toISOString() }, 'INVALID_INPUT'],
    [{ ...request, start: '2026-09-15T00:00:00' }, 'INVALID_INPUT'],
    [{ ...request, question: '界'.repeat(683) }, 'INVALID_INPUT'],
    [{ ...request, evidenceIds: ['old'] }, 'POLICY_DENIED'],
    [{ ...request, unexpected: true }, 'INVALID_INPUT'],
  ] as const)('rejects invalid scope before child creation', async (input, code) => {
    let created = false;
    const tool = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: settlementTool(),
      childAgentFactory: { create: () => { created = true; throw new Error('child created'); } }, clock: { now: () => new Date(now) } });
    await expect(drain(tool, input)).rejects.toMatchObject({ code, retryable: false });
    expect(created).toBe(false);
  });

  it.each([
    ['invalid calendar day', {
      profileId: 'simulation', service: 'checkout',
      start: '2026-02-30T00:00:00.000Z', end: '2026-02-30T00:05:00.000Z',
      question: '结算失败率是否升高？',
    }, '2026-03-02T00:05:00.000Z'],
    ['invalid month', {
      profileId: 'simulation', service: 'checkout',
      start: '2026-13-15T00:00:00.000Z', end: '2026-13-15T00:05:00.000Z',
      question: '结算失败率是否升高？',
    }, '2027-01-15T00:05:00.000Z'],
    ['invalid time', {
      profileId: 'simulation', service: 'checkout',
      start: '2026-09-15T24:00:00.000Z', end: '2026-09-15T24:05:00.000Z',
      question: '结算失败率是否升高？',
    }, '2026-09-16T00:05:00.000Z'],
    ['missing timezone', { ...request, start: '2026-09-15T00:00:00.000', end: '2026-09-15T00:05:00.000' }, '2026-09-15T00:05:00.000Z'],
    ['non-300-second window', { ...request, end: '2026-09-15T00:06:00.000Z' }, '2026-09-15T00:06:00.000Z'],
  ] as const)('rejects %s before child creation', async (_name, input, clockTime) => {
    let created = false;
    const tool = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: settlementTool(),
      childAgentFactory: { create: () => { created = true; throw new Error('child created'); } },
      clock: { now: () => new Date(clockTime) } });
    await expect(drain(tool, input)).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
    expect(created).toBe(false);
  });

  it('accepts a valid offset timestamp window before creating the child', async () => {
    let created = false;
    const tool = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: settlementTool(),
      childAgentFactory: { create: (input) => {
        created = true;
        return childFactory(() => undefined).create(input);
      } }, clock: { now: () => new Date(now) } });
    const result = await drain(tool, {
      ...request,
      start: '2026-09-14T19:00:00.000-05:00',
      end: '2026-09-14T19:05:00.000-05:00',
    });
    expect(created).toBe(true);
    expect(result.isError).not.toBe(true);
  });

  it('requires an injected immutable smoke snapshot window to match exactly', async () => {
    let created = false;
    const tool = createMetricsSubagentTool({
      profile: settlementMetricsLabProfile,
      settlementTool: settlementTool(),
      childAgentFactory: { create: () => { created = true; throw new Error('child must not be created'); } },
      clock: { now: () => new Date(now) },
      sourceWindow: { start: new Date(now - 301_000).toISOString(), end: new Date(now - 1_000).toISOString() },
    });
    await expect(drain(tool, request)).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
    expect(created).toBe(false);
  });

  it.each([{ name: 'arbitrary.http' }, { kind: 'action' }, { source: 'builtin' }, { call: undefined }])(
    'rejects invalid settlement composition at bootstrap', (override) => {
      expect(() => createMetricsSubagentTool({ profile: settlementMetricsLabProfile,
        settlementTool: { ...settlementTool(), ...override } as Tool,
        childAgentFactory: childFactory(() => undefined) })).toThrow();
    },
  );

  it('rejects a settlement schema that exposes an optional PromQL argument', () => {
    expect(() => createMetricsSubagentTool({ profile: settlementMetricsLabProfile,
      settlementTool: { ...settlementTool(), inputSchema: z.object({
        service: z.literal('checkout'), promql: z.string().optional(),
      }).strict() }, childAgentFactory: childFactory(() => undefined) })).toThrow();
  });

  it('rejects a settlement schema that accepts another service', () => {
    expect(() => createMetricsSubagentTool({ profile: settlementMetricsLabProfile,
      settlementTool: { ...settlementTool(), inputSchema: z.object({
        service: z.string().refine((service) => service !== 'payments'),
      }).strict() }, childAgentFactory: childFactory(() => undefined) })).toThrow();
  });

  it('rejects less than two remaining tool calls before child creation', async () => {
    let created = false;
    const tool = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: settlementTool(),
      childAgentFactory: { create: () => { created = true; throw new Error('child created'); } }, clock: { now: () => new Date(now) } });
    await expect(drain(tool, request, 1)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(created).toBe(false);
  });

  it('returns partial when the child has evidence but omits source_report', async () => {
    const tool = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: settlementTool(),
      childAgentFactory: childFactory(() => undefined, false), clock: { now: () => new Date(now) } });
    const result = await drain(tool, request);
    const block = result.blocks[0];
    if (block?.type !== 'json') throw new Error('missing result');
    expect(block.value).toMatchObject({ status: 'partial', evidenceIds: [evidenceId],
      missingEvidence: ['source_report'] });
  });

  it('returns unavailable when the child source fails before any metric evidence', async () => {
    const failingTool = { ...settlementTool(), call: () => { throw new Error('source failed'); } };
    const tool = createMetricsSubagentTool({ profile: settlementMetricsLabProfile, settlementTool: failingTool,
      childAgentFactory: childFactory(() => undefined, false), clock: { now: () => new Date(now) } });
    const result = await drain(tool, request);
    const block = result.blocks[0];
    if (block?.type !== 'json') throw new Error('missing result');
    expect(block.value).toMatchObject({ status: 'unavailable', evidenceIds: [] });
    expect(result.isError).toBe(true);
  });
});
