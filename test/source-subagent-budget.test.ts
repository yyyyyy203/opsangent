import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { createSourceSubagentTool } from '../src/tool/adapters/source-subagent-tool-adapter.js';
import type {
  SourceSubagentDescriptor,
  SourceSubagentResult,
  ToolResponseChunk,
} from '../src/contracts/index.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const inputSchema = z.object({
  profileId: z.string().min(1),
  service: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  question: z.string().min(1),
}).strict();

describe('source subagent parent Tool budget', () => {
  it('counts child Tool calls against the parent budget before the next parent action', async () => {
    let childCalls = 0;
    const descriptor: SourceSubagentDescriptor = {
      publicToolName: 'logs_subagent',
      subagentType: 'logs',
      description: 'test source subagent',
      inputSchema,
      childRunId: (execution) => `child:${execution.parentRunId}:${execution.parentToolCallId}`,
      runner: {
        run: async function* (_request, execution) {
          await Promise.resolve();
          yield* [] as ToolResponseChunk[];
          childCalls += 1;
          if (execution.toolCallBudget !== undefined) execution.toolCallBudget.remaining -= 1;
          return completeResult();
        },
      },
    };
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'parent-tool-1', name: 'logs_subagent', input: input() }] },
        { toolCalls: [{ id: 'parent-tool-2', name: 'logs_subagent', input: input('检查错误2') }] },
        { text: '完成', toolCalls: [] },
      ]),
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [createSourceSubagentTool(descriptor)],
    });

    const result = await runtime.agent.reply({ message: '检查', profileId: 'group-buy-market', maxToolCalls: 3 });

    expect(result.status).toBe('completed');
    expect(childCalls).toBe(1);
    await runtime.close();
  });
});

function input(question = '检查错误'): Record<string, unknown> {
  return {
    profileId: 'group-buy-market',
    service: 'checkout',
    start: '2026-09-14T00:00:00.000Z',
    end: '2026-09-14T01:00:00.000Z',
    question,
  };
}

function completeResult(): SourceSubagentResult {
  return {
    source: 'logs',
    status: 'complete',
    summary: '完成',
    findings: [],
    evidenceIds: [],
    businessTraceIds: [],
    missingEvidence: [],
    coverage: 0,
    toolCallsUsed: 1,
    durationMs: 1,
  };
}
