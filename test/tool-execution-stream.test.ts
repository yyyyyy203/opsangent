import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentContext, AgentEvent, Clock, Tool, ToolCall } from '../src/contracts/index.js';
import { EventBus } from '../src/event/event-bus.js';
import { EventFactory } from '../src/event/event-factory.js';
import { GuardEngine } from '../src/guard/guard-engine.js';
import { HookExecutor } from '../src/hooks/hook-executor.js';
import { NoopObservability } from '../src/observability/noop-observability.js';
import { InMemoryCheckpointStore } from '../src/storage/in-memory-checkpoint-store.js';
import { ToolExecutionPipeline } from '../src/tool/execution-pipeline.js';
import { DefaultToolRunner } from '../src/tool/tool-runner.js';
import { Toolkit } from '../src/tool/toolkit.js';
import type { ExecutionOutcome } from '../src/tool/execution-types.js';

const timestamp = '2026-09-09T12:00:00.000Z';

function context(): AgentContext {
  return {
    runId: 'run-1', sessionId: 'session-1', replyId: 'reply-1', streamId: 'stream-1',
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

describe('ToolExecutionPipeline streaming', () => {
  it('yields lifecycle and response-chunk events before returning the execution outcome', async () => {
    const clock: Clock = { now: () => new Date(timestamp) };
    const toolkit = new Toolkit();
    const tool: Tool = {
      name: 'streaming', description: 'streaming evidence', kind: 'evidence',
      inputSchema: z.object({}), isConcurrencySafe: () => true,
      call: async function* () {
        yield { type: 'progress' as const, message: 'half', percent: 50 };
        yield { type: 'text_delta' as const, delta: 'partial' };
        return { blocks: [{ type: 'text' as const, text: 'done' }] };
      },
    };
    toolkit.register(tool);
    const pipeline = new ToolExecutionPipeline(
      toolkit,
      new GuardEngine([]),
      new HookExecutor([]),
      new DefaultToolRunner(),
      new InMemoryCheckpointStore(),
      new EventBus(),
      new EventFactory(clock),
      new NoopObservability(),
      clock,
      { actionMode: 'dry_run' },
    );
    const call: ToolCall = { id: 'call-1', name: tool.name, input: {} };
    const stream = pipeline.executeStream(call, context(), 'step-1', new AbortController().signal);
    const events: AgentEvent[] = [];
    let outcome: ExecutionOutcome | undefined;
    while (true) {
      const item = await stream.next();
      if (item.done) {
        outcome = item.value;
        break;
      }
      events.push(item.value);
    }

    expect(events.map((item) => item.type)).toEqual([
      'TOOL_STARTED', 'TOOL_PROGRESS', 'TOOL_PROGRESS', 'TOOL_RESULT',
    ]);
    expect(events[1]?.payload).toMatchObject({ toolCallId: 'call-1', chunk: { type: 'progress' } });
    expect(events[2]?.payload).toMatchObject({ toolCallId: 'call-1', chunk: { type: 'text_delta', delta: 'partial' } });
    expect(outcome?.type).toBe('completed');
    expect(outcome?.result.status).toBe('success');
  });
});
