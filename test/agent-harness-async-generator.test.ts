import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type {
  AgentContext,
  AgentEvent,
  CheckpointStore,
  Observability,
  Tool,
  ToolCall,
  ToolExecutionResult,
} from '../src/contracts/index.js';
import type { DiagnosisRunResult } from '../src/agent/types.js';
import { NoopObservability } from '../src/observability/noop-observability.js';
import { InMemoryCheckpointStore } from '../src/storage/in-memory-checkpoint-store.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

async function drain(stream: AsyncGenerator<AgentEvent, DiagnosisRunResult>): Promise<{ events: AgentEvent[]; result: DiagnosisRunResult }> {
  const events: AgentEvent[] = [];
  while (true) {
    const item = await stream.next();
    if (item.done) return { events, result: item.value };
    events.push(item.value);
  }
}

function comparable(event: AgentEvent): { type: AgentEvent['type']; runId: string; stepId?: string; payload: AgentEvent['payload'] } {
  return {
    type: event.type,
    runId: event.runId,
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    payload: event.payload,
  };
}

class CountingCheckpointStore implements CheckpointStore {
  public saveCount = 0;
  private readonly delegate = new InMemoryCheckpointStore();

  public load(runId: string): Promise<AgentContext | null> { return this.delegate.load(runId); }

  public save(context: AgentContext): Promise<void> {
    this.saveCount += 1;
    return this.delegate.save(context);
  }

  public hasExecuted(call: ToolCall): Promise<boolean> { return this.delegate.hasExecuted(call); }

  public recordExecuted(call: ToolCall, result: ToolExecutionResult): Promise<void> {
    return this.delegate.recordExecuted(call, result);
  }
}

class CountingObservability extends NoopObservability implements Observability {
  public flushCount = 0;

  public override flush(): Promise<void> {
    this.flushCount += 1;
    return super.flush();
  }
}

function streamingEvidenceTool(): Tool {
  return {
    name: 'metrics.query',
    description: 'query metrics',
    kind: 'evidence',
    inputSchema: z.object({ service: z.string() }),
    isConcurrencySafe: () => true,
    call: async function* () {
      await Promise.resolve();
      yield { type: 'progress' as const, message: 'reading', percent: 50 };
      yield { type: 'text_delta' as const, delta: 'partial' };
      return { blocks: [{ type: 'text' as const, text: 'done' }] };
    },
  };
}

describe('Agent Harness direct AsyncGenerator delivery', () => {
  it('matches the V2-to-V1 EventBus projection event-for-event', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'query-1', name: 'metrics.query', input: { service: 'settlement' } }] },
        { text: 'done', toolCalls: [] },
      ]),
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [streamingEvidenceTool()],
    });
    const projected: AgentEvent[] = [];
    runtime.events.subscribe((event) => { projected.push(event); });

    const result = await drain(runtime.agent.replyStream({ runId: 'parity-run', message: 'inspect', profileId: 'group-buy-market' }));
    const fromEventBus = projected.filter((event) => event.runId === result.result.runId);

    expect(result.result.status).toBe('completed');
    expect(result.events.map(comparable)).toEqual(fromEventBus.map(comparable));
    expect(result.events.filter((event) => event.type === 'TOOL_RESULT')).toHaveLength(1);
    expect(result.events.find((event) => event.type === 'RUN_FINISHED')?.payload).toMatchObject({ finalText: 'done' });
    expect(result.events.every((event) => event.runId === result.result.runId && !Number.isNaN(Date.parse(event.timestamp)))).toBe(true);
  });

  it('saves and flushes once when a consumer closes an active stream', async () => {
    const checkpoints = new CountingCheckpointStore();
    const observability = new CountingObservability();
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'done', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      checkpoints,
      observability,
    });
    const stream = runtime.agent.replyStream({ runId: 'closed-run', message: 'inspect', profileId: 'group-buy-market' });
    const first = await stream.next();
    expect(first.done).toBe(false);
    await stream.return(undefined as never);

    const saved = await checkpoints.load('closed-run');
    expect(saved?.status).toBe('cancelled');
    expect(saved?.failure).toEqual({ code: 'ABORTED', message: 'Agent stream consumer closed.', retryable: false });
    expect(checkpoints.saveCount).toBe(1);
    expect(observability.flushCount).toBe(1);
    expect((await runtime.eventStoreV2.readRun('closed-run', 0, 100)).map((event) => event.type)).toContain('RUN_CANCELLED');
  });

  it('treats a consumer throw as stream cancellation after cleanup', async () => {
    const checkpoints = new CountingCheckpointStore();
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'done', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      checkpoints,
    });
    const stream = runtime.agent.replyStream({ runId: 'thrown-run', message: 'inspect', profileId: 'group-buy-market' });
    const first = await stream.next();
    expect(first.done).toBe(false);

    await expect(stream.throw(new Error('consumer stop'))).rejects.toThrow('consumer stop');

    const saved = await checkpoints.load('thrown-run');
    expect(saved?.status).toBe('cancelled');
    expect(saved?.failure).toEqual({ code: 'ABORTED', message: 'Agent stream consumer closed.', retryable: false });
    expect(checkpoints.saveCount).toBe(1);
    expect((await runtime.eventStoreV2.readRun('thrown-run', 0, 100)).map((event) => event.type)).toContain('RUN_CANCELLED');
  });

  it('uses one final checkpoint for completion and keeps the iteration checkpoint', async () => {
    const checkpoints = new CountingCheckpointStore();
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'query-1', name: 'metrics.query', input: { service: 'settlement' } }] },
        { text: 'done', toolCalls: [] },
      ]),
      workspaceRoots: [],
      includeExternalBash: false,
      checkpoints,
      tools: [{ ...streamingEvidenceTool(), call: async () => { await Promise.resolve(); return { blocks: [{ type: 'text', text: 'ok' }] }; } }],
    });
    const result = await runtime.agent.reply({ runId: 'checkpoint-run', message: 'inspect', profileId: 'group-buy-market' });
    expect(result.status).toBe('completed');
    expect(checkpoints.saveCount).toBe(2);
  });
});
