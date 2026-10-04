import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelopeV2, AgentEventPayloadMap, AgentEventTypeV2 } from '../src/contracts/index.js';
import { LangSmithEventProjectorV2 } from '../src/event/projectors/langsmith-projector.js';
import { RecordingObservability } from './fixtures/recording-observability.js';

let sequence = 0;

function event<T extends AgentEventTypeV2>(
  type: T,
  payload: AgentEventPayloadMap[T],
  overrides: Partial<AgentEventEnvelopeV2<T>> = {},
): AgentEventEnvelopeV2<T> {
  sequence += 1;
  return {
    schemaVersion: 2,
    eventId: `lifecycle-event-${sequence}`,
    sequence,
    type,
    payload,
    runId: 'run-1',
    correlationId: 'correlation-1',
    timestamp: '2026-10-04T10:00:00.000Z',
    visibility: 'audit',
    durability: 'durable',
    ...overrides,
  } as AgentEventEnvelopeV2<T>;
}

describe('LangSmith V2 span lifecycle', () => {
  it('uses stream-scoped segments for pause/resume and ignores stale terminal events', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const canary = 'SENSITIVE-CANARY-trigger-final-input-error';
    const started = event('RUN_STARTED', {
      profile: 'simulation', trigger: canary, deadline: '2026-10-04T10:01:00.000Z',
      versionSnapshot: { secret: canary },
    }, { streamId: 'stream-1' });
    const resumed = event('RUN_RESUMED', {
      checkpointVersion: 'checkpoint-1', resumeReason: canary, newStreamId: 'stream-2',
    }, { streamId: 'stream-1' });

    await projector.project(started);
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'test-provider', model: 'test-model', purpose: 'diagnosis', attempt: 1, inputSummary: canary,
    }, { runId: 'run-1', streamId: 'stream-1', attemptId: 'attempt-1' }));
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'interrupt-1', reason: canary, expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'checkpoint-1',
    }, { streamId: 'stream-1' }));
    await projector.project(resumed);

    const lateOldStreamFailure = event('RUN_FAILED', {
      error: { code: 'MODEL_ERROR', message: canary, retryable: false }, stage: 'hypothesis', recoverable: false,
    }, { streamId: 'stream-1' });
    await projector.project(lateOldStreamFailure);

    await projector.project(event('RUN_FINISHED', {
      outcome: 'complete', finalText: canary, durationMs: 42,
      usage: { inputTokens: 12, outputTokens: 8 }, usageCompleteness: 'complete',
    }, { streamId: 'stream-2' }));

    expect(observer.starts.filter((span) => span.name === 'agent.run').map((span) => span.spanKey))
      .toEqual(['run:run-1:stream-1', 'run:run-1:stream-2']);
    expect(observer.endings.some((ending) => ending.spanKey === 'run:run-1:stream-1'
      && hasStringField(ending.output, 'status', 'paused'))).toBe(true);
    expect(observer.endings.some((ending) => ending.spanKey === 'run:run-1:stream-2'
      && hasStringField(ending.output, 'status', 'completed')
      && hasStringField(ending.output, 'outcome', 'complete'))).toBe(true);
    expect(observer.endings.some((ending) => ending.spanKey === 'run:run-1:stream-2'
      && ending.error !== undefined)).toBe(false);
    expect(JSON.stringify({ starts: observer.starts, endings: observer.endings })).not.toContain(canary);
    expect(projector.getTraceDiagnostics()).toMatchObject({ activeSpans: 0, rememberedSpanKeys: 0 });
  });

  it('keeps a source invocation wrapper separate from its child execution segment', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const parentRunId = 'parent-run';
    const childRunId = 'child-run';
    const toolKey = 'tool:parent-run:parent-stream:metrics-tool:tool-attempt-1';
    const invocationKey = 'source:parent-run:metrics-tool:child-run';

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: parentRunId, streamId: 'parent-stream' }));
    await projector.project(event('TOOL_STARTED', {
      toolName: 'metrics_subagent', source: 'subagent', attempt: 1,
    }, { runId: parentRunId, streamId: 'parent-stream', toolCallId: 'metrics-tool', attemptId: 'tool-attempt-1' }));
    await projector.project(event('SUBAGENT_STARTED', {
      subagentType: 'metrics', childRunId, parentRunId,
      budget: { type: 'tool_calls', limit: 4, used: 1 },
    }, { runId: parentRunId, parentRunId, streamId: 'parent-stream', toolCallId: 'metrics-tool' }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'source-child', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: childRunId, parentRunId, streamId: 'child-stream' }));
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'test-provider', model: 'child-model', purpose: 'diagnosis', attempt: 1, inputSummary: 'safe',
    }, { runId: childRunId, parentRunId, streamId: 'child-stream', attemptId: 'child-attempt' }));

    const invocation = observer.starts.find((span) => span.spanKey === invocationKey);
    const childSegment = observer.starts.find((span) => span.spanKey === 'run:child-run:child-stream');
    const childModel = observer.starts.find((span) => span.spanKey === 'model:child-run:child-stream:child-attempt');
    expect(invocation).toMatchObject({
      name: 'subagent.metrics', runId: parentRunId, streamId: 'parent-stream', parentSpanKey: toolKey,
    });
    expect(childSegment).toMatchObject({
      name: 'agent.run', runId: childRunId, streamId: 'child-stream', parentSpanKey: invocationKey,
    });
    expect(childModel?.parentSpanKey).toBe('run:child-run:child-stream');
    expect(observer.starts.filter((span) => span.spanKey === invocationKey)).toHaveLength(1);
  });

  it('does not let a stale model completion from an earlier stream close a resumed attempt', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const runId = 'resumed-attempt-run';
    const attemptId = 'reused-attempt';
    const oldStreamId = 'old-stream';
    const newStreamId = 'new-stream';

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId, streamId: oldStreamId }));
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'test-provider', model: 'test-model', purpose: 'diagnosis', attempt: 1, inputSummary: 'safe',
    }, { runId, streamId: oldStreamId, attemptId }));
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'interrupt-1', reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'checkpoint-1',
    }, { runId, streamId: oldStreamId }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'checkpoint-1', resumeReason: 'approved', newStreamId,
    }, { runId, streamId: oldStreamId }));
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'test-provider', model: 'test-model', purpose: 'diagnosis', attempt: 1, inputSummary: 'safe',
    }, { runId, streamId: newStreamId, attemptId }));

    const completion = {
      provider: 'test-provider', model: 'test-model', attempt: 1, durationMs: 1,
    } as const;
    await projector.project(event('MODEL_CALL_COMPLETED', completion, {
      runId, streamId: oldStreamId, attemptId,
    }));
    const resumedAttemptKey = `model:${runId}:${newStreamId}:${attemptId}`;
    expect(observer.endings.some((ending) => ending.spanKey === resumedAttemptKey)).toBe(false);

    await projector.project(event('MODEL_CALL_COMPLETED', completion, {
      runId, streamId: newStreamId, attemptId,
    }));
    expect(observer.endings.some((ending) => ending.spanKey === resumedAttemptKey)).toBe(true);
  });

  it('closes active descendants once on failure and omits raw failure text', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const canary = 'SENSITIVE-ERROR-MESSAGE';
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { streamId: 'failure-stream' }));
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'test-provider', model: 'test-model', purpose: 'diagnosis', attempt: 1, inputSummary: 'safe',
    }, { streamId: 'failure-stream', attemptId: 'failure-attempt' }));
    await projector.project(event('TOOL_STARTED', {
      toolName: 'metrics.query', source: 'mcp', attempt: 1,
    }, { streamId: 'failure-stream', toolCallId: 'query-1', attemptId: 'query-attempt' }));
    const failed = event('RUN_FAILED', {
      error: { code: 'MODEL_ERROR', message: canary, retryable: false, details: { internal: canary } },
      stage: 'hypothesis', recoverable: false,
    }, { streamId: 'failure-stream' });
    await projector.project(failed);
    await projector.project(failed);

    expect(observer.endings).toHaveLength(3);
    expect(observer.endings.find((item) => item.spanKey === 'run:run-1:failure-stream')?.error)
      .toEqual({ code: 'MODEL_ERROR', retryable: false });
    expect(observer.endings.filter((item) => item.spanKey !== 'run:run-1:failure-stream')
      .every((item) => (item.output as { status?: string } | undefined)?.status === 'incomplete')).toBe(true);
    expect(JSON.stringify({ starts: observer.starts, endings: observer.endings })).not.toContain(canary);
  });

  it('marks a missing segment parent as orphan, diagnoses it, and releases group state', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'test-provider', model: 'test-model', purpose: 'diagnosis', attempt: 1, inputSummary: 'safe',
    }, { runId: 'orphan-run', streamId: 'orphan-stream', attemptId: 'orphan-attempt' }));

    const orphanRun = observer.starts.find((span) => span.name === 'agent.run');
    const orphanModel = observer.starts.find((span) => span.name === 'model.test-model');
    expect(orphanRun?.runId).toBe('orphan-run');
    expect(orphanRun?.attributes).toMatchObject({ orphan: true });
    expect(orphanModel?.parentSpanKey).toBe('orphan:run:orphan-run:orphan-stream');
    expect(projector.getTraceDiagnostics().counts).toMatchObject({ TRACE_PARENT_MISSING: 1 });

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: 'orphan-run', streamId: 'orphan-stream' }));
    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 5 }, {
      runId: 'orphan-run', streamId: 'orphan-stream',
    }));
    expect(projector.getTraceDiagnostics()).toMatchObject({ activeSpans: 0, rememberedSpanKeys: 0, seenEventIds: 0 });
  });

  it('deduplicates event identities and never reopens a terminal execution segment', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const started = event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: 'terminal-run', streamId: 'terminal-stream' });
    await projector.project(started);
    await projector.project(started);
    await projector.project(event('RUN_FINISHED', { outcome: 'complete', durationMs: 5 }, {
      runId: 'terminal-run', streamId: 'terminal-stream',
    }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'late', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: 'terminal-run', streamId: 'terminal-stream' }));

    expect(observer.starts.filter((span) => span.runId === 'terminal-run' && span.name === 'agent.run')).toHaveLength(1);
    expect(observer.endings.filter((item) => item.spanKey === 'run:terminal-run:terminal-stream')).toHaveLength(1);
  });

  it('closes a cancelled execution segment exactly once', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const started = event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:30.000Z', versionSnapshot: {},
    }, { streamId: 'cancel-stream' });
    const cancelled = event('RUN_CANCELLED', { actor: 'user', reason: 'cancel', stage: 'triage' }, {
      streamId: 'cancel-stream',
    });

    await projector.project(started);
    await projector.project(started);
    await projector.project(cancelled);
    await projector.project(cancelled);

    expect(observer.starts).toHaveLength(1);
    expect(observer.endings).toHaveLength(1);
    expect(observer.endings[0]?.output).toMatchObject({ status: 'cancelled' });
  });

  it('bounds active span and event state, then releases run-owned state at terminal', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer, {
      maxActiveSpans: 2,
      maxRememberedSpanKeys: 1,
      maxSeenEventIds: 2,
    });

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: 'bounded-run', streamId: 'bounded-stream' }));
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'test-provider', model: 'first-model', purpose: 'diagnosis', attempt: 1, inputSummary: 'safe',
    }, { runId: 'bounded-run', streamId: 'bounded-stream', attemptId: 'attempt-1' }));
    await projector.project(event('MODEL_CALL_COMPLETED', {
      provider: 'test-provider', model: 'first-model', attempt: 1, durationMs: 1,
    }, { runId: 'bounded-run', streamId: 'bounded-stream', attemptId: 'attempt-1' }));
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'test-provider', model: 'second-model', purpose: 'diagnosis', attempt: 2, inputSummary: 'safe',
    }, { runId: 'bounded-run', streamId: 'bounded-stream', attemptId: 'attempt-2' }));
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'test-provider', model: 'overflow-model', purpose: 'diagnosis', attempt: 3, inputSummary: 'safe',
    }, { runId: 'bounded-run', streamId: 'bounded-stream', attemptId: 'attempt-3' }));

    expect(projector.getTraceDiagnostics()).toMatchObject({
      activeSpans: 2, rememberedSpanKeys: 1, seenEventIds: 2, droppedSpans: 1,
    });

    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 5 }, {
      runId: 'bounded-run', streamId: 'bounded-stream',
    }));

    expect(projector.getTraceDiagnostics()).toMatchObject({
      activeSpans: 0, rememberedSpanKeys: 0, seenEventIds: 0, terminalRuns: 1,
    });
  });
});

function hasStringField(value: unknown, key: string, expected: string): boolean {
  if (typeof value !== 'object' || value === null || !(key in value)) return false;
  return (value as Record<string, unknown>)[key] === expected;
}
