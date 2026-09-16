import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DefaultSourceSubagentRunner } from '../src/application/source-subagent-runner.js';
import type {
  AgentContext,
  AgentEvent,
  DiagnosisRunResult,
  SourceChildAgent,
  SourceChildAgentFactory,
  SourceSubagentExecution,
  SourceSubagentRequest,
  Tool,
} from '../src/application/source-subagent-runner.js';
import { SourceSubagentFailure } from '../src/application/source-subagent-runner.js';
import { DefaultSourceReportCollector, type SourceReportCollector } from '../src/application/source-report-collector.js';

describe('source subagent Runner', () => {
  it('uses a bounded child Harness, collects child evidence, and resumes an existing child checkpoint', async () => {
    const calls: string[] = [];
    let created: { maxToolCalls: number; maxDurationMs: number; tools: readonly Tool[] } | undefined;
    const child: SourceChildAgent = {
      replyStream: async function* (options) {
        await Promise.resolve();
        calls.push(`reply:${options.runId}`);
        yield toolResultEvent(options.runId);
        return completedChildResult(options.runId);
      },
      resumeStream: async function* (runId) {
        await Promise.resolve();
        calls.push(`resume:${runId}`);
        yield toolResultEvent(runId);
        return completedChildResult(runId);
      },
    };
    const factory: SourceChildAgentFactory = {
      create: (input) => {
        created = { maxToolCalls: input.maxToolCalls, maxDurationMs: input.maxDurationMs, tools: input.tools };
        return child;
      },
    };
    const reportTool: Tool = {
      name: 'source_report', description: 'report', kind: 'utility', inputSchema: z.object({}).strict(), call: () => ({ blocks: [{ type: 'json', value: {} }] }),
    };
    const execution = executionContext();
    const runner = new DefaultSourceSubagentRunner({
      source: 'logs',
      childAgentFactory: factory,
      childTools: { create: () => [{ name: 'logs.capture', description: 'capture', kind: 'evidence', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) }, reportTool] },
      checkpoints: { load: () => Promise.resolve({} as AgentContext), save: () => Promise.resolve(), hasExecuted: () => Promise.resolve(false), recordExecuted: () => Promise.resolve() },
      clock: { now: () => new Date('2026-09-14T00:00:00.000Z') },
    });

    const result = await drain(runner.run(request(), execution));

    expect(result).toMatchObject({ source: 'logs', status: 'partial', evidenceIds: ['evidence-1'], coverage: 1 });
    expect(calls).toEqual(['resume:child-1']);
    expect(created).toMatchObject({ maxToolCalls: 3, maxDurationMs: 5_000 });
    expect(created?.tools.map((tool) => tool.name)).toEqual(['logs.capture', 'source_report']);
  });

  it('attaches observed evidence to a retryable child failure for reduced-scope fallback', async () => {
    const child: SourceChildAgent = {
      replyStream: async function* (options) {
        await Promise.resolve();
        yield toolResultEvent(options.runId);
        return { ...completedChildResult(options.runId), status: 'failed' };
      },
      resumeStream: async function* (runId) {
        await Promise.resolve();
        yield toolResultEvent(runId);
        return { ...completedChildResult(runId), status: 'failed' };
      },
    };
    const runner = new DefaultSourceSubagentRunner({
      source: 'logs',
      childAgentFactory: { create: () => child },
      childTools: { create: () => [
        { name: 'logs.capture', description: 'capture', kind: 'evidence', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
        { name: 'source_report', description: 'report', kind: 'utility', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
      ] },
      clock: { now: () => new Date('2026-09-14T00:00:00.000Z') },
    });

    const failure = await drainFailure(runner.run(request(), executionContext()));

    expect(failure).toBeInstanceOf(SourceSubagentFailure);
    expect(failure).toMatchObject({ code: 'MCP_SERVER_ERROR', retryable: true, partialResult: {
      status: 'partial', evidenceIds: ['evidence-1'], coverage: 1,
    } });
  });

  it('preserves a non-retryable source observation protocol failure from the child stream', async () => {
    const child: SourceChildAgent = {
      replyStream: async function* (options) {
        await Promise.resolve();
        yield malformedObservationEvent(options.runId);
        return completedChildResult(options.runId);
      },
      resumeStream: async function* (runId) {
        await Promise.resolve();
        yield malformedObservationEvent(runId);
        return completedChildResult(runId);
      },
    };
    const runner = new DefaultSourceSubagentRunner({
      source: 'metrics',
      childAgentFactory: { create: () => child },
      childTools: { create: () => [
        { name: 'metrics.settlement', description: 'read metrics', kind: 'evidence', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
        { name: 'source_report', description: 'report', kind: 'utility', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
      ] },
      clock: { now: () => new Date('2026-09-14T00:00:00.000Z') },
    });

    const failure = await drainFailure(runner.run(request(), executionContext()));

    expect(failure).toMatchObject({ code: 'MCP_PROTOCOL_ERROR', retryable: false });
  });

  it('uses injected source prompt and collector seams for a metrics child', async () => {
    const collector = new DefaultSourceReportCollector();
    let message = '';
    const child: SourceChildAgent = {
      replyStream: async function* (options) {
        await Promise.resolve();
        yield* [] as AgentEvent[];
        message = options.message;
        return completedChildResult(options.runId);
      },
      resumeStream: async function* (runId) {
        await Promise.resolve();
        yield* [] as AgentEvent[];
        return completedChildResult(runId);
      },
    };
    const runner = new DefaultSourceSubagentRunner({
      source: 'metrics',
      childAgentFactory: { create: () => child },
      childTools: { create: () => [
        { name: 'metrics.settlement', description: 'read metrics', kind: 'evidence', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
        { name: 'source_report', description: 'report', kind: 'utility', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
      ] },
      renderPrompt: (sourceRequest, execution) => `source=metrics\nprofile=${execution.profileId}\nquestion=${sourceRequest.question}`,
      collector: ({ request: sourceRequest, execution }) => {
        expect(sourceRequest.service).toBe('checkout');
        expect(execution.childRunId).toBe('child-1');
        return collector;
      },
      clock: { now: () => new Date('2026-09-14T00:00:00.000Z') },
    });

    await drain(runner.run(request(), executionContext()));

    expect(message).toMatch(/^source=metrics/);
    expect(message).toContain('profile=group-buy-market');
    expect(message).not.toContain('日志取证');
  });

  it('uses a neutral default prompt naming the configured source', async () => {
    let message = '';
    const child: SourceChildAgent = {
      replyStream: async function* (options) {
        await Promise.resolve();
        yield* [] as AgentEvent[];
        message = options.message;
        return completedChildResult(options.runId);
      },
      resumeStream: async function* (runId) {
        await Promise.resolve();
        yield* [] as AgentEvent[];
        return completedChildResult(runId);
      },
    };
    const runner = new DefaultSourceSubagentRunner({
      source: 'metrics',
      childAgentFactory: { create: () => child },
      childTools: { create: () => [
        { name: 'metrics.settlement', description: 'read metrics', kind: 'evidence', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
        { name: 'source_report', description: 'report', kind: 'utility', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
      ] },
      clock: { now: () => new Date('2026-09-14T00:00:00.000Z') },
    });

    await drain(runner.run(request(), executionContext()));

    expect(message).toContain('只读 metrics 来源取证 Subagent');
    expect(message).not.toContain('日志取证');
    expect(message).not.toContain('原始日志');
  });

  it('preserves structured collector observation errors', async () => {
    const collector: SourceReportCollector = {
      observeToolResult: () => {
        throw Object.assign(new Error('invalid observation'), { code: 'MCP_PROTOCOL_ERROR', retryable: false });
      },
      acceptReport: () => undefined,
      finalize: () => ({
        source: 'metrics', status: 'unavailable', summary: '', findings: [], evidenceIds: [], businessTraceIds: [], missingEvidence: [], coverage: 0, toolCallsUsed: 0, durationMs: 0,
      }),
    };
    const child: SourceChildAgent = {
      replyStream: async function* (options) {
        await Promise.resolve();
        yield malformedObservationEvent(options.runId);
        return completedChildResult(options.runId);
      },
      resumeStream: async function* (runId) {
        await Promise.resolve();
        yield malformedObservationEvent(runId);
        return completedChildResult(runId);
      },
    };
    const runner = new DefaultSourceSubagentRunner({
      source: 'metrics',
      childAgentFactory: { create: () => child },
      childTools: { create: () => [
        { name: 'metrics.settlement', description: 'read metrics', kind: 'evidence', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
        { name: 'source_report', description: 'report', kind: 'utility', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
      ] },
      collector: () => collector,
      clock: { now: () => new Date('2026-09-14T00:00:00.000Z') },
    });

    const failure = await drainFailure(runner.run(request(), executionContext()));

    expect(failure).toMatchObject({ code: 'MCP_PROTOCOL_ERROR', retryable: false });
  });
});

function request(): SourceSubagentRequest {
  return { profileId: 'group-buy-market', service: 'checkout', start: '2026-09-14T00:00:00.000Z', end: '2026-09-14T01:00:00.000Z', question: '查找异常', evidenceIds: [] };
}

function executionContext(): SourceSubagentExecution {
  return { parentRunId: 'parent-1', parentToolCallId: 'tool-1', parentStepId: 'step-1', childRunId: 'child-1', profileId: 'group-buy-market', deadline: Date.parse('2026-09-14T00:00:05.000Z'), signal: new AbortController().signal, remainingToolCalls: 3, networkAttemptBudget: { remaining: 5 } };
}

function toolResultEvent(runId: string): AgentEvent {
  return {
    schemaVersion: 1, type: 'TOOL_RESULT', runId, stepId: 'child-step-1', timestamp: '2026-09-14T00:00:01.000Z',
    payload: {
      toolCallId: 'capture-1', toolName: 'logs.capture', status: 'success',
      response: { blocks: [{ type: 'json', value: { status: 'partial', evidenceId: 'evidence-1', coverage: 1 } }], evidenceIds: ['evidence-1'] },
      startedAt: '2026-09-14T00:00:00.000Z', finishedAt: '2026-09-14T00:00:01.000Z',
    },
  };
}

function malformedObservationEvent(runId: string): AgentEvent {
  return {
    schemaVersion: 1, type: 'TOOL_RESULT', runId, stepId: 'child-step-1', timestamp: '2026-09-14T00:00:01.000Z',
    payload: {
      toolCallId: 'metrics-1', toolName: 'metrics.settlement', status: 'success',
      response: {
        blocks: [{ type: 'evidence_ref', evidenceId: 'metric-evidence-1' }],
        evidenceIds: ['metric-evidence-1'],
        metadata: { sourceEvidence: {
          schemaVersion: 2, source: 'metrics', evidenceId: 'metric-evidence-1', state: 'committed', coverage: 1, missingEvidence: [],
        } },
      },
      startedAt: '2026-09-14T00:00:00.000Z', finishedAt: '2026-09-14T00:00:01.000Z',
    },
  };
}

function completedChildResult(runId: string): DiagnosisRunResult {
  return { runId, profileId: 'group-buy-market', status: 'completed', finalText: '', contextVersion: 1 } as DiagnosisRunResult;
}

async function drain(stream: AsyncGenerator<unknown, ReturnType<DefaultSourceSubagentRunner['run']> extends AsyncGenerator<unknown, infer Result> ? Result : never>): Promise<never>;
async function drain(stream: AsyncGenerator<unknown, { source: string; status: string; evidenceIds: string[]; coverage: number; [key: string]: unknown }>): Promise<{ source: string; status: string; evidenceIds: string[]; coverage: number; [key: string]: unknown }>;
async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<unknown> {
  while (true) { const item = await stream.next(); if (item.done) return item.value; }
}

async function drainFailure(stream: AsyncGenerator<unknown, unknown>): Promise<unknown> {
  try {
    while (true) { const item = await stream.next(); if (item.done) return item.value; }
  } catch (error) {
    return error;
  }
}
