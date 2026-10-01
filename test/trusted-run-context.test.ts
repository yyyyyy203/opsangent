import { describe, expect, it } from 'vitest';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { RunExecutionCoordinator } from '../src/application/run-execution-coordinator.js';
import type {
  AgentContext,
  AgentEvent,
  ChatModel,
  DiagnosisAgent,
  DiagnosisRunResult,
  ModelCallOptions,
  ModelResponse,
  ModelStreamEvent,
  ReplyOptions,
  Tool,
} from '../src/index.js';

class RecordingModel implements ChatModel {
  public readonly calls: Array<{ messages: AgentContext['messages']; tools: readonly Tool[] }> = [];

  public async *stream(
    messages: AgentContext['messages'],
    tools: Tool[],
    options: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    void options;
    this.calls.push({ messages: structuredClone(messages), tools: [...tools] });
    await Promise.resolve();
    yield { type: 'text_delta', delta: 'done' };
    return { text: 'done', toolCalls: [] };
  }
}

describe('trusted run context', () => {
  it('persists one trusted system message before the user message and preserves it on resume', async () => {
    const model = new RecordingModel();
    const runtime = createInspectionRuntime({ model, workspaceRoots: [], allowedToolNames: [] });
    const trustedSystemContext = 'Profile=simulation; service=checkout; start=1000; end=301000; allowed tools: metrics_subagent';

    try {
      await runtime.agent.reply({
        runId: 'trusted-run',
        profileId: 'simulation',
        message: 'inspect settlement',
        trustedSystemContext,
      });

      const first = await runtime.checkpoints.load('trusted-run');
      expect(first).not.toBeNull();
      expect(first?.messages.slice(0, 2)).toHaveLength(2);
      expect(first?.messages[0]).toMatchObject({
        role: 'system',
        blocks: [{ type: 'text', text: trustedSystemContext }],
      });
      expect(first?.messages[1]).toMatchObject({
        role: 'user',
        blocks: [{ type: 'text', text: 'inspect settlement' }],
      });
      expect(model.calls[0]?.messages[0]).toEqual(first?.messages[0]);

      await runtime.checkpoints.save({ ...first!, status: 'paused' });
      await drain(runtime.agent.resumeStream('trusted-run'));

      const resumed = await runtime.checkpoints.load('trusted-run');
      expect(resumed?.messages[0]).toEqual(first?.messages[0]);
      expect(model.calls[1]?.messages[0]).toEqual(first?.messages[0]);
    } finally {
      await runtime.close();
    }
  });
});

describe('RunExecutionCoordinator trusted start preparation', () => {
  it('prepares only new starts and never decorates resume', async () => {
    const calls: string[] = [];
    const checkpoints = {
      load: (runId: string) => Promise.resolve(runId === 'resume-me' ? { status: 'paused' } as AgentContext : null),
    };
    const agent: DiagnosisAgent = {
      reply: () => Promise.resolve(result('unused')),
      replyStream: async function* (options: ReplyOptions) {
        await Promise.resolve();
        calls.push(`start:${options.trustedSystemContext ?? 'none'}`);
        yield* [];
        return result(options.runId!);
      },
      resumeStream: async function* (runId: string) {
        await Promise.resolve();
        calls.push(`resume:${runId}`);
        yield* [];
        return result(runId);
      },
    };
    const coordinator = new RunExecutionCoordinator(agent, checkpoints, {
      prepareStart: (options) => ({ ...options, trustedSystemContext: 'host scope' }),
    });

    await coordinator.start({ runId: 'new-run', profileId: 'simulation', message: 'inspect' });
    await coordinator.resume('resume-me');

    expect(calls).toEqual(['start:host scope', 'resume:resume-me']);
  });
});

function result(runId: string): DiagnosisRunResult {
  return { runId, status: 'completed', finalText: '', contextVersion: 1 };
}

async function drain(stream: AsyncGenerator<AgentEvent, DiagnosisRunResult>): Promise<DiagnosisRunResult> {
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
