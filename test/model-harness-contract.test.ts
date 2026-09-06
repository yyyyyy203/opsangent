import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type {
  AgentEvent,
  AgentMessage,
  ChatModel,
  CheckpointStore,
  Clock,
  IdGenerator,
  ModelResponse,
  ModelStreamEvent,
  Tool,
  ToolExecutionResult,
} from '../src/contracts/index.js';

const runId = 'run-contract';

class CapturingSequenceModel implements ChatModel {
  public readonly runId = runId;
  public readonly requests: AgentMessage[][] = [];
  private index = 0;

  public constructor(private readonly responses: readonly ModelResponse[]) {}

  public async *stream(
    messages: AgentMessage[],
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    await Promise.resolve();
    this.requests.push(structuredClone(messages));
    const response = this.responses[this.index];
    if (response === undefined) throw new Error('No response configured.');
    this.index += 1;
    if (response.text !== undefined) yield { type: 'text_delta', delta: response.text };
    return response;
  }
}

function oneShotModel(text: string): ChatModel {
  return {
    async *stream() {
      await Promise.resolve();
      yield { type: 'text_delta' as const, delta: text };
      return { text, toolCalls: [] };
    },
  };
}

function throwingModel(error: unknown): ChatModel {
  return {
    async *stream() {
      await Promise.resolve();
      yield { type: 'usage' as const };
      throw error;
    },
  };
}

function successResult(toolCallId: string): ToolExecutionResult {
  return {
    toolCallId,
    toolName: 'metrics.settlement',
    status: 'success',
    response: { blocks: [{ type: 'text', text: 'ok' }] },
    startedAt: '2026-09-06T00:00:00.000Z',
    finishedAt: '2026-09-06T00:00:00.000Z',
  };
}

function createHarnessFixture(options: {
  model: ChatModel;
  now?: string;
  toolResult?: ToolExecutionResult;
  checkpoints?: CheckpointStore;
}) {
  const now = options.now ?? '2026-09-06T00:00:00.000Z';
  const clock: Clock = { now: () => new Date(now) };
  let nextId = 0;
  const ids: IdGenerator = { next: (prefix) => prefix === 'run' ? runId : `${prefix}-${++nextId}` };
  const events: AgentEvent[] = [];
  const tools: Tool[] = options.toolResult === undefined ? [] : [{
    name: 'metrics.settlement',
    kind: 'evidence',
    description: 'Read settlement metrics.',
    inputSchema: z.object({ window: z.string() }),
    call: () => ({ blocks: options.toolResult?.response?.blocks ?? [] }),
  }];
  const runtime = createAgentRuntime({
    model: options.model,
    workspaceRoots: [],
    tools,
    includeExternalBash: false,
    clock,
    ids,
    ...(options.checkpoints === undefined ? {} : { checkpoints: options.checkpoints }),
  });
  runtime.events.subscribe((event) => { events.push(event); });
  return { harness: runtime.agent, checkpoints: runtime.checkpoints, events, runId };
}

describe('Agent Harness model contract', () => {
  it('passes the absolute run deadline to every model call', async () => {
    const seen: number[] = [];
    const model: ChatModel = {
      async *stream(_messages, _tools, options) {
        await Promise.resolve();
        seen.push(options.deadline ?? -1);
        yield { type: 'text_delta', delta: 'done' };
        return { text: 'done', toolCalls: [] };
      },
    };
    const { harness } = createHarnessFixture({ model, now: '2026-09-06T00:00:00.000Z' });
    await harness.reply({ message: 'inspect', profileId: 'settlement', maxDurationMs: 30_000 });
    expect(seen).toEqual([Date.parse('2026-09-06T00:00:00.000Z') + 30_000]);
  });

  it('persists assistant text beside raw tool calls before the next reasoning step', async () => {
    const model = new CapturingSequenceModel([
      { text: '我先检查失败率。', toolCalls: [], rawToolCalls: [{ id: 'tc-1', name: 'metrics.settlement', arguments: '{"window":"5m"}' }] },
      { text: '检查完成。', toolCalls: [] },
    ]);
    const { harness, checkpoints } = createHarnessFixture({ model, toolResult: successResult('tc-1') });
    await harness.reply({ message: 'inspect', profileId: 'settlement' });
    const saved = await checkpoints.load(model.runId);
    const assistant = saved?.messages.find((message) => message.role === 'assistant');
    expect(assistant?.blocks).toEqual([
      { type: 'text', text: '我先检查失败率。' },
      { type: 'raw_tool_call', call: { id: 'tc-1', name: 'metrics.settlement', arguments: '{"window":"5m"}' } },
    ]);
    expect(model.requests[1]).toContainEqual(assistant);
  });

  it('persists the final assistant text before the completed checkpoint', async () => {
    const { harness, checkpoints } = createHarnessFixture({ model: oneShotModel('diagnosis complete') });
    await harness.reply({ runId, message: 'inspect', profileId: 'settlement' });
    expect((await checkpoints.load(runId))?.messages.at(-1)).toMatchObject({
      role: 'assistant', blocks: [{ type: 'text', text: 'diagnosis complete' }],
    });
  });

  it('checkpoints a plain MODEL_ERROR and publishes its safe category', async () => {
    const failure = Object.assign(new Error('Model request failed.'), {
      code: 'MODEL_ERROR' as const,
      retryable: true,
      details: { category: 'server', status: 503 },
    });
    const { harness, checkpoints, events } = createHarnessFixture({ model: throwingModel(failure) });
    const result = await harness.reply({ runId, message: 'inspect', profileId: 'settlement' });
    expect(result.status).toBe('failed');
    expect((await checkpoints.load(runId))?.failure).toEqual({
      code: 'MODEL_ERROR', message: 'Model request failed.', retryable: true,
      details: { category: 'server', status: 503 },
    });
    expect(events.some((event) => event.type === 'RUN_FAILED'
      && 'code' in event.payload && event.payload.code === 'MODEL_ERROR'
      && 'category' in event.payload && event.payload.category === 'server'
      && 'retryable' in event.payload && event.payload.retryable === true)).toBe(true);
  });

  it('clears a previous failure when a resumed run succeeds', async () => {
    const failed = createHarnessFixture({ model: throwingModel(Object.assign(new Error('failed'), {
      code: 'MODEL_ERROR' as const, retryable: false,
    })) });
    await failed.harness.reply({ runId, message: 'inspect', profileId: 'settlement' });

    const resumed = createHarnessFixture({ model: oneShotModel('recovered'), checkpoints: failed.checkpoints });
    const stream = resumed.harness.resumeStream(runId);
    while (!(await stream.next()).done) { /* Drain events and the final result. */ }

    expect((await failed.checkpoints.load(runId))?.failure).toBeUndefined();
  });
});
