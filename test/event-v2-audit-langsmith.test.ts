import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelopeV2, Observability, SpanHandle, SpanStart } from '../src/contracts/index.js';
import { AuditProjectorV2 } from '../src/event/projectors/audit-projector.js';
import { LangSmithEventProjectorV2 } from '../src/event/projectors/langsmith-projector.js';

class RecordingHandle implements SpanHandle {
  public attributes: Record<string, unknown> = {};
  public output: unknown;
  public error: unknown;
  public ended = false;
  public failed = false;

  public setAttributes(attributes: Record<string, unknown>): void {
    this.attributes = { ...this.attributes, ...attributes };
  }

  public end(output?: unknown): void {
    this.ended = true;
    this.output = output;
  }

  public fail(error: unknown): void {
    this.failed = true;
    this.error = error;
  }
}

class RecordingObservability implements Observability {
  public readonly starts: SpanStart[] = [];
  public readonly handles: RecordingHandle[] = [];

  public startSpan(input: SpanStart): SpanHandle {
    const handle = new RecordingHandle();
    this.starts.push(input);
    this.handles.push(handle);
    return handle;
  }

  public flush(): Promise<void> {
    return Promise.resolve();
  }
}

function event<T extends AgentEventEnvelopeV2['type']>(
  type: T,
  payload: AgentEventEnvelopeV2<T>['payload'],
  overrides: Partial<AgentEventEnvelopeV2<T>> = {},
): AgentEventEnvelopeV2<T> {
  return {
    schemaVersion: 2,
    eventId: `${type.toLowerCase()}-event`,
    sequence: 1,
    type,
    payload,
    runId: 'run-1',
    correlationId: 'corr-1',
    timestamp: '2026-09-07T10:00:00.000Z',
    visibility: 'audit',
    durability: 'durable',
    ...overrides,
  } as AgentEventEnvelopeV2<T>;
}

describe('AuditProjectorV2', () => {
  it('records sanitized audit references without raw prompts or secrets', () => {
    const projector = new AuditProjectorV2();
    projector.project(event('MODEL_CALL_STARTED', {
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      purpose: 'diagnosis',
      attempt: 1,
      inputSummary: 'prompt with Bearer secret-token and system prompt',
    }));

    expect(projector.records).toHaveLength(1);
    expect(JSON.stringify(projector.records[0])).not.toContain('secret-token');
    expect(projector.records[0]).toMatchObject({
      eventId: 'model_call_started-event',
      runId: 'run-1',
      type: 'MODEL_CALL_STARTED',
      payloadSummary: { provider: 'openai-compatible', model: 'deepseek-chat', purpose: 'diagnosis', attempt: 1 },
    });
  });
});

describe('LangSmithEventProjectorV2', () => {
  it('projects run, model, tool and subagent events with explicit parent span keys', async () => {
    const observability = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observability);

    await projector.project(event('RUN_STARTED', {
      profile: 'group-buy-market', trigger: 'manual', deadline: '2026-09-07T10:30:00.000Z', versionSnapshot: {},
    }, { sessionId: 'session-1', replyId: 'reply-1', streamId: 'stream-1' }));
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'openai-compatible', model: 'deepseek-chat', purpose: 'diagnosis', attempt: 1, inputSummary: 'safe summary',
    }, { attemptId: 'attempt-1' }));
    await projector.project(event('TOOL_STARTED', {
      toolName: 'metrics_subagent', source: 'subagent', attempt: 1,
    }, { toolCallId: 'tool-1', attemptId: 'tool-attempt-1' }));
    await projector.project(event('SUBAGENT_STARTED', {
      subagentType: 'metrics', childRunId: 'child-run-1', parentRunId: 'run-1', budget: { type: 'tool_calls', limit: 4, used: 1 },
    }, { parentRunId: 'run-1', toolCallId: 'tool-1' }));

    expect(observability.starts).toEqual([
      expect.objectContaining({ name: 'agent.run', kind: 'chain', runId: 'run-1', spanKey: 'run:run-1', sessionId: 'session-1', replyId: 'reply-1', streamId: 'stream-1' }),
      expect.objectContaining({ name: 'model.deepseek-chat', kind: 'llm', runId: 'run-1', spanKey: 'model:run-1:attempt-1', parentSpanKey: 'run:run-1' }),
      expect.objectContaining({ name: 'tool.metrics_subagent', kind: 'tool', runId: 'run-1', spanKey: 'tool:run-1:tool-1:tool-attempt-1', parentSpanKey: 'run:run-1' }),
      expect.objectContaining({ name: 'subagent.metrics', kind: 'chain', runId: 'child-run-1', spanKey: 'run:child-run-1', parentSpanKey: 'run:run-1' }),
    ]);
  });

  it('closes spans with usage metadata and isolates observability failures', async () => {
    const observability = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observability);
    await projector.project(event('RUN_STARTED', {
      profile: 'group-buy-market', trigger: 'manual', deadline: '2026-09-07T10:30:00.000Z', versionSnapshot: {},
    }));
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'openai-compatible', model: 'deepseek-chat', purpose: 'diagnosis', attempt: 1, inputSummary: 'safe summary',
    }, { attemptId: 'attempt-1' }));
    await projector.project(event('MODEL_CALL_COMPLETED', {
      provider: 'openai-compatible', model: 'deepseek-chat', attempt: 1,
      usage: { inputTokens: 12, outputTokens: 8 }, cacheHit: true, ttftMs: 50, durationMs: 200, finishReason: 'stop',
    }, { attemptId: 'attempt-1' }));

    expect(observability.handles[1]?.ended).toBe(true);
    expect(observability.handles[1]?.output).toEqual({
      usage: { inputTokens: 12, outputTokens: 8 }, cacheHit: true, ttftMs: 50, durationMs: 200, finishReason: 'stop',
    });

    const broken = new LangSmithEventProjectorV2({
      startSpan: () => { throw new Error('remote unavailable'); },
      flush: () => Promise.reject(new Error('remote unavailable')),
    });
    await expect(broken.project(event('RUN_STARTED', {
      profile: 'group-buy-market', trigger: 'manual', deadline: '2026-09-07T10:30:00.000Z', versionSnapshot: {},
    }))).resolves.toBeUndefined();
    await expect(broken.flush()).resolves.toBeUndefined();
  });
});
