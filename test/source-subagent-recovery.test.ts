import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DefaultSourceSubagentRunner } from '../src/application/source-subagent-runner.js';
import type {
  AgentContext,
  AgentEvent,
  DiagnosisRunResult,
  SourceChildAgentFactory,
  SourceSubagentExecution,
  SourceSubagentRequest,
} from '../src/application/source-subagent-runner.js';
import type { CheckpointStore, SourceSubagentResult } from '../src/contracts/index.js';

describe('source subagent recovery', () => {
  it('resumes the stable child Run and restores committed evidence/report without replaying capture', async () => {
    const calls: string[] = [];
    const childFactory: SourceChildAgentFactory = {
      create: (input) => {
        expect(input.childRunId).toBe('child-1');
        return {
          replyStream: async function* (): AsyncGenerator<AgentEvent, DiagnosisRunResult> {
            await Promise.resolve();
            yield* [] as AgentEvent[];
            calls.push('reply');
            return completedResult();
          },
          resumeStream: async function* (runId): AsyncGenerator<AgentEvent, DiagnosisRunResult> {
            await Promise.resolve();
            yield* [] as AgentEvent[];
            calls.push(`resume:${runId}`);
            return completedResult();
          },
        };
      },
    };
    const checkpoint: AgentContext = {
      runId: 'child-1',
      status: 'running',
      stage: 'evidence_collection',
      profileId: 'group-buy-market',
      messages: [
        {
          id: 'msg-capture', role: 'tool', createdAt: '2026-09-14T00:00:01.000Z',
          blocks: [{ type: 'tool_result', result: {
            toolCallId: 'capture-1', toolName: 'logs.capture', status: 'success',
            response: { blocks: [{ type: 'json', value: { evidenceId: 'evidence-1', status: 'committed', coverage: 1 } }], evidenceIds: ['evidence-1'] },
            startedAt: '2026-09-14T00:00:00.000Z', finishedAt: '2026-09-14T00:00:01.000Z',
          } }],
        },
        {
          id: 'msg-report', role: 'assistant', createdAt: '2026-09-14T00:00:02.000Z',
          blocks: [{ type: 'tool_call', call: {
            id: 'report-1', name: 'source_report', input: {
              summary: '已恢复的日志报告',
              findings: [{ kind: 'observation', statement: '存在超时', evidenceIds: ['evidence-1'] }],
              businessTraceIds: ['trace-1'], missingEvidence: [],
            },
          } }],
        },
      ],
      pendingToolCalls: [], confirmedToolCallIds: [], rejectedToolCallIds: [], executedActions: [],
      evidenceIds: ['evidence-1'], missingEvidence: [],
      budget: { startedAt: '2026-09-14T00:00:00.000Z', maxIterations: 8, iteration: 1, maxToolCalls: 8, toolCallsUsed: 1, maxDurationMs: 30_000 },
      contextVersion: 1,
    };
    const checkpoints: CheckpointStore = {
      load: (runId) => Promise.resolve(runId === 'child-1' ? checkpoint : null),
      save: () => Promise.resolve(),
      hasExecuted: () => Promise.resolve(false),
      recordExecuted: () => Promise.resolve(),
    };
    const runner = new DefaultSourceSubagentRunner({
      source: 'logs',
      childAgentFactory: childFactory,
      childTools: { create: () => [
        { name: 'logs.capture', description: 'capture', kind: 'evidence', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
        { name: 'source_report', description: 'report', kind: 'utility', inputSchema: z.object({}).strict(), call: () => ({ blocks: [] }) },
      ] },
      checkpoints,
      clock: { now: () => new Date('2026-09-14T00:00:03.000Z') },
    });

    const result = await drain(runner.run(request(), execution()));

    expect(calls).toEqual(['resume:child-1']);
    expect(result).toMatchObject({ status: 'complete', evidenceIds: ['evidence-1'], businessTraceIds: ['trace-1'], coverage: 1 });
  });
});

function request(): SourceSubagentRequest {
  return { profileId: 'group-buy-market', service: 'checkout', start: '2026-09-14T00:00:00.000Z', end: '2026-09-14T01:00:00.000Z', question: '定位超时', evidenceIds: [] };
}

function execution(): SourceSubagentExecution {
  return { parentRunId: 'parent-1', parentToolCallId: 'tool-1', parentStepId: 'step-1', childRunId: 'child-1', profileId: 'group-buy-market', signal: new AbortController().signal, remainingToolCalls: 3 };
}

function completedResult(): DiagnosisRunResult {
  return { runId: 'child-1', status: 'completed', finalText: 'done', contextVersion: 2 };
}

async function drain(stream: AsyncGenerator<unknown, SourceSubagentResult>): Promise<SourceSubagentResult> {
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
