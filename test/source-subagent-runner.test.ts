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
