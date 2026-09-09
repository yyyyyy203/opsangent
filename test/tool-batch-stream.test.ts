import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentContext, AgentEvent, Clock, Tool, ToolCall } from '../src/contracts/index.js';
import { EventBus } from '../src/event/event-bus.js';
import { EventFactory } from '../src/event/event-factory.js';
import { GuardEngine } from '../src/guard/guard-engine.js';
import { HookExecutor } from '../src/hooks/hook-executor.js';
import { NoopObservability } from '../src/observability/noop-observability.js';
import { InMemoryCheckpointStore } from '../src/storage/in-memory-checkpoint-store.js';
import { ToolBatchExecutor } from '../src/tool/batch-executor.js';
import { ToolExecutionPipeline } from '../src/tool/execution-pipeline.js';
import { DefaultToolRunner } from '../src/tool/tool-runner.js';
import { Toolkit } from '../src/tool/toolkit.js';
import { mergeAsyncGenerators } from '../src/tool/async-generator-multiplexer.js';

const timestamp = '2026-09-09T12:00:00.000Z';

function context(): AgentContext {
  return {
    runId: 'run-batch', sessionId: 'session-batch', replyId: 'reply-batch', streamId: 'stream-batch',
    status: 'running', stage: 'evidence_collection', profileId: 'test', messages: [],
    pendingToolCalls: [], confirmedToolCallIds: [], rejectedToolCallIds: [], executedActions: [],
    evidenceIds: [], missingEvidence: [],
    budget: {
      startedAt: timestamp, maxIterations: 5, iteration: 1, maxToolCalls: 10, toolCallsUsed: 1,
      maxDurationMs: 60_000,
    },
    contextVersion: 1,
  };
}

async function drain<T, R>(stream: AsyncGenerator<T, R>): Promise<{ events: T[]; result: R }> {
  const events: T[] = [];
  while (true) {
    const item = await stream.next();
    if (item.done) return { events, result: item.value };
    events.push(item.value);
  }
}

function createBatch(tools: Tool[]): { batch: ToolBatchExecutor; events: AgentEvent[] } {
  const clock: Clock = { now: () => new Date(timestamp) };
  const toolkit = new Toolkit();
  for (const tool of tools) toolkit.register(tool);
  const events: AgentEvent[] = [];
  const eventBus = new EventBus();
  eventBus.subscribe((event) => { events.push(event); });
  const pipeline = new ToolExecutionPipeline(
    toolkit,
    new GuardEngine([]),
    new HookExecutor([]),
    new DefaultToolRunner(),
    new InMemoryCheckpointStore(),
    eventBus,
    new EventFactory(clock),
    new NoopObservability(),
    clock,
    { actionMode: 'dry_run' },
  );
  return { batch: new ToolBatchExecutor(toolkit, pipeline, clock), events };
}

function streamingTool(name: string, concurrencySafe: boolean, onRun?: (phase: string) => void): Tool {
  return {
    name,
    description: name,
    kind: 'evidence',
    inputSchema: z.object({}),
    isConcurrencySafe: () => concurrencySafe,
    call: async function* () {
      onRun?.('start');
      await Promise.resolve();
      yield { type: 'progress' as const, message: name, percent: 50 };
      onRun?.('end');
      return { blocks: [{ type: 'text' as const, text: name }] };
    },
  };
}

describe('ToolBatchExecutor streaming', () => {
  it('merges child generators and returns final values in input order', async () => {
    async function* first(): AsyncGenerator<string, number> {
      await Promise.resolve();
      yield 'first';
      return 1;
    }
    async function* second(): AsyncGenerator<string, number> {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      yield 'second';
      return 2;
    }

    const result = await drain(mergeAsyncGenerators([first(), second()]));
    expect(result.events.sort()).toEqual(['first', 'second']);
    expect(result.result).toEqual([1, 2]);
  });

  it('streams safe tools concurrently while preserving ordered results', async () => {
    const first = streamingTool('first', true);
    const second = streamingTool('second', true);
    const { batch } = createBatch([first, second]);
    const result = await drain(batch.executeStream([
      { id: 'call-second', name: 'second', input: {} },
      { id: 'call-first', name: 'first', input: {} },
    ], context(), 'step-1', new AbortController().signal));

    expect(result.events.filter((event) => event.type === 'TOOL_PROGRESS')).toHaveLength(2);
    expect(result.result.results.map((item) => item.toolCallId)).toEqual(['call-second', 'call-first']);
  });

  it('runs unsafe tools serially and skips later calls after an interrupt', async () => {
    const order: string[] = [];
    const first = streamingTool('unsafe-first', false, (phase) => { order.push(`first:${phase}`); });
    const second = streamingTool('unsafe-second', false, (phase) => { order.push(`second:${phase}`); });
    const serial = createBatch([first, second]);
    await drain(serial.batch.executeStream([
      { id: 'first', name: first.name, input: {} },
      { id: 'second', name: second.name, input: {} },
    ], context(), 'step-serial', new AbortController().signal));
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);

    const external: Tool = {
      name: 'external', description: 'external', kind: 'evidence', inputSchema: z.object({}),
    };
    const later = streamingTool('later', false);
    const interrupted = createBatch([external, later]);
    const result = await drain(interrupted.batch.executeStream([
      { id: 'external-call', name: external.name, input: {} },
      { id: 'later-call', name: later.name, input: {} },
    ], context(), 'step-interrupt', new AbortController().signal));
    expect(result.result.interrupt?.interruptType).toBe('external_tool_execution');
    expect(result.result.results.map((item) => [item.toolCallId, item.status])).toEqual([
      ['external-call', 'awaiting_external'],
      ['later-call', 'skipped'],
    ]);
  });
});
