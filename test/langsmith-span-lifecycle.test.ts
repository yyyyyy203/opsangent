import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelopeV2, AgentEventPayloadMap, AgentEventTypeV2, SpanHandle, SpanStart } from '../src/contracts/index.js';
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
  it('closes the matching tool attempt when a toolCallId is reused', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const runId = 'reused-tool-call-run';
    const streamId = 'reused-tool-call-stream';
    const toolCallId = 'reused-tool-call';
    const firstAttemptKey = `tool:${runId}:${streamId}:${toolCallId}:attempt-1`;
    const secondAttemptKey = `tool:${runId}:${streamId}:${toolCallId}:attempt-2`;

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId, streamId }));
    await projector.project(event('TOOL_STARTED', {
      toolName: 'metrics.query', source: 'mcp', attempt: 1,
    }, { runId, streamId, toolCallId, attemptId: 'attempt-1' }));
    await projector.project(event('TOOL_STARTED', {
      toolName: 'metrics.query', source: 'mcp', attempt: 2,
    }, { runId, streamId, toolCallId, attemptId: 'attempt-2' }));

    await projector.project(event('TOOL_RESULT', {
      result: {
        toolCallId, toolName: 'metrics.query', status: 'success',
        startedAt: '2026-10-04T10:00:00.000Z', finishedAt: '2026-10-04T10:00:01.000Z',
      },
      durationMs: 1, evidenceIds: [],
    }, { runId, streamId, toolCallId, attemptId: 'attempt-1' }));

    expect(observer.endings.some((ending) => ending.spanKey === firstAttemptKey)).toBe(true);
    expect(observer.endings.some((ending) => ending.spanKey === secondAttemptKey)).toBe(false);

    await projector.project(event('TOOL_FAILED', {
      error: { code: 'TOOL_ERROR', message: 'retry failed', retryable: false },
      attempt: 2, retryable: false,
    }, { runId, streamId, toolCallId, attemptId: 'attempt-2' }));

    expect(observer.endings.filter((ending) => ending.spanKey === firstAttemptKey)).toHaveLength(1);
    expect(observer.endings.filter((ending) => ending.spanKey === secondAttemptKey)).toHaveLength(1);
    expect(observer.endings.find((ending) => ending.spanKey === secondAttemptKey)?.error).toBeDefined();
  });

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
    }, { streamId: 'stream-2' });

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
      usage: { inputTokens: 12, outputTokens: 8 }, usageCompleteness: 'complete', reportId: canary,
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
    }, { runId, streamId: newStreamId }));
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

  it('closes child spans when a terminal parent owns an orphan invocation', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const parentRunId = 'orphan-parent';
    const childRunId = 'orphan-child';

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: parentRunId, streamId: 'parent-stream' }));
    await projector.project(event('SUBAGENT_STARTED', {
      subagentType: 'metrics', childRunId, parentRunId,
      budget: { type: 'tool_calls', limit: 4, used: 1 },
    }, { runId: parentRunId, parentRunId, streamId: 'parent-stream', toolCallId: 'missing-tool' }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'child', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: childRunId, parentRunId, streamId: 'child-stream' }));
    await projector.project(event('MODEL_CALL_STARTED', {
      provider: 'test-provider', model: 'child-model', purpose: 'diagnosis', attempt: 1, inputSummary: 'safe',
    }, { runId: childRunId, parentRunId, streamId: 'child-stream', attemptId: 'child-attempt' }));
    await projector.project(event('RUN_FAILED', {
      error: { code: 'MODEL_ERROR', message: 'private error', retryable: false },
      stage: 'hypothesis', recoverable: false,
    }, { runId: parentRunId, streamId: 'parent-stream' }));

    expect(projector.getTraceDiagnostics().activeSpans).toBe(0);
    expect(observer.endings.some((ending) => ending.spanKey === 'model:orphan-child:child-stream:child-attempt'
      && hasStringField(ending.output, 'status', 'incomplete'))).toBe(true);
  });

  it('recreates a source invocation parent when a descendant resumes after parent pause', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const parentRunId = 'paused-parent';
    const childRunId = 'paused-child';

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));
    await projector.project(event('TOOL_STARTED', {
      toolName: 'metrics_subagent', source: 'subagent', attempt: 1,
    }, { runId: parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call', attemptId: 'tool-attempt' }));
    await projector.project(event('SUBAGENT_STARTED', {
      subagentType: 'metrics', childRunId, parentRunId,
      budget: { type: 'tool_calls', limit: 4, used: 1 },
    }, { runId: parentRunId, parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call' }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'child', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: childRunId, parentRunId, streamId: 'child-stream-1' }));
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'parent-interrupt', reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'checkpoint-1',
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));

    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'checkpoint-1', resumeReason: 'approved', newStreamId: 'parent-stream-2',
    }, { runId: parentRunId, streamId: 'parent-stream-2' }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'checkpoint-1', resumeReason: 'approved', newStreamId: 'child-stream-2',
    }, { runId: childRunId, parentRunId, streamId: 'child-stream-2' }));

    const resumedInvocation = observer.starts.find((span) => span.runId === parentRunId
      && span.name === 'subagent.metrics' && span.spanKey !== 'source:paused-parent:metrics-call:paused-child');
    const resumedChildSegment = observer.starts.find((span) => span.spanKey === 'run:paused-child:child-stream-2');
    expect(resumedInvocation?.parentSpanKey).toBe('run:paused-parent:parent-stream-2');
    expect(resumedChildSegment?.parentSpanKey).toBe(resumedInvocation?.spanKey);
    expect(resumedChildSegment?.attributes?.orphan).not.toBe(true);
    expect(projector.getTraceDiagnostics().activeSpans).toBe(3);
  });

  it('releases suspended descendant mappings when the parent terminates before child resume', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const parentRunId = 'abandoned-parent';
    const childRunId = 'abandoned-child';

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));
    await projector.project(event('TOOL_STARTED', {
      toolName: 'metrics_subagent', source: 'subagent', attempt: 1,
    }, { runId: parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call', attemptId: 'tool-attempt' }));
    await projector.project(event('SUBAGENT_STARTED', {
      subagentType: 'metrics', childRunId, parentRunId,
      budget: { type: 'tool_calls', limit: 4, used: 1 },
    }, { runId: parentRunId, parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call' }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'child', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: childRunId, parentRunId, streamId: 'child-stream-1' }));
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'parent-interrupt', reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'checkpoint-1',
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'checkpoint-1', resumeReason: 'approved', newStreamId: 'parent-stream-2',
    }, { runId: parentRunId, streamId: 'parent-stream-2' }));
    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 5 }, {
      runId: parentRunId, streamId: 'parent-stream-2',
    }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'checkpoint-1', resumeReason: 'late-child-resume', newStreamId: 'child-stream-2',
    }, { runId: childRunId, parentRunId, streamId: 'child-stream-2' }));

    expect(observer.starts.some((span) => span.spanKey === `run:${childRunId}:child-stream-2`)).toBe(false);
    expect(projector.getTraceDiagnostics().activeSpans).toBe(0);
  });

  it('does not replace an active resumed segment with a replayed old semantic start', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer, { maxSeenEventIds: 1 });
    const runId = 'stale-start-run';
    const oldStreamId = 'old-stream';
    const newStreamId = 'new-stream';
    const started = event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId, streamId: oldStreamId });

    await projector.project(started);
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'interrupt-1', reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'checkpoint-1',
    }, { runId, streamId: oldStreamId }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'checkpoint-1', resumeReason: 'approved', newStreamId,
    }, { runId, streamId: newStreamId }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'replayed', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId, streamId: oldStreamId }));

    expect(projector.getTraceDiagnostics().activeSpans).toBe(1);
    expect(observer.endings.some((ending) => ending.spanKey === `run:${runId}:${newStreamId}`)).toBe(false);
  });

  it('ignores a late parent pause from the previous stream after its child has resumed', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const parentRunId = 'late-pause-parent';
    const childRunId = 'late-pause-child';
    const budget = { type: 'tool_calls' as const, limit: 4, used: 1 };

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));
    await projector.project(event('TOOL_STARTED', {
      toolName: 'metrics_subagent', source: 'subagent', attempt: 1,
    }, { runId: parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call', attemptId: 'tool-attempt' }));
    await projector.project(event('SUBAGENT_STARTED', {
      subagentType: 'metrics', childRunId, parentRunId, budget,
    }, { runId: parentRunId, parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call' }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'child', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: childRunId, parentRunId, streamId: 'child-stream-1' }));
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'parent-interrupt-1', reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-1',
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'cp-1', resumeReason: 'approved', newStreamId: 'parent-stream-2',
    }, { runId: parentRunId, streamId: 'parent-stream-2' }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'cp-1', resumeReason: 'approved', newStreamId: 'child-stream-2',
    }, { runId: childRunId, parentRunId, streamId: 'child-stream-2' }));

    const activeBeforeLatePause = projector.getTraceDiagnostics().activeSpans;
    const resumedInvocation = observer.starts.find((span) => span.name === 'subagent.metrics'
      && span.spanKey !== 'source:late-pause-parent:metrics-call:late-pause-child');
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'late-old-interrupt', reason: 'late-event', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-1',
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));

    expect(projector.getTraceDiagnostics().activeSpans).toBe(activeBeforeLatePause);
    expect(observer.endings.some((ending) => ending.spanKey === 'run:late-pause-child:child-stream-2')).toBe(false);
    expect(resumedInvocation).toBeDefined();
    expect(observer.endings.some((ending) => ending.spanKey === resumedInvocation?.spanKey)).toBe(false);
  });

  it('keeps resumed invocation keys stable and rejects a reused child stream ID', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const parentRunId = 'stable-invocation-parent';
    const childRunId = 'stable-invocation-child';
    const budget = { type: 'tool_calls' as const, limit: 4, used: 1 };
    const pause = (streamId: string, interruptId: string) => event('RUN_PAUSED', {
      interruptId, reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-stable',
    }, { runId: parentRunId, streamId });
    const resume = (runId: string, _oldStreamId: string, newStreamId: string) => event('RUN_RESUMED', {
      checkpointVersion: 'cp-stable', resumeReason: 'approved', newStreamId,
    }, { runId, ...(runId === childRunId ? { parentRunId } : {}), streamId: newStreamId });

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));
    await projector.project(event('TOOL_STARTED', {
      toolName: 'metrics_subagent', source: 'subagent', attempt: 1,
    }, { runId: parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call', attemptId: 'tool-attempt' }));
    await projector.project(event('SUBAGENT_STARTED', {
      subagentType: 'metrics', childRunId, parentRunId, budget,
    }, { runId: parentRunId, parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call' }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'child', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: childRunId, parentRunId, streamId: 'child-stream-1' }));

    await projector.project(pause('parent-stream-1', 'parent-int-1'));
    await projector.project(resume(parentRunId, 'parent-stream-1', 'parent-stream-2'));
    await projector.project(resume(childRunId, 'child-stream-1', 'child-stream-2'));
    await projector.project(pause('parent-stream-2', 'parent-int-2'));
    await projector.project(resume(parentRunId, 'parent-stream-2', 'parent-stream-3'));
    await projector.project(resume(childRunId, 'child-stream-2', 'child-stream-3'));

    const firstResumedKey = 'source:stable-invocation-parent:metrics-call:stable-invocation-child:resume:child-stream-2:1';
    const secondResumedKey = 'source:stable-invocation-parent:metrics-call:stable-invocation-child:resume:child-stream-3:2';
    expect(observer.starts.some((span) => span.spanKey === firstResumedKey)).toBe(true);
    expect(observer.starts.some((span) => span.spanKey === secondResumedKey)).toBe(true);
    expect(secondResumedKey.length).toBeLessThan(firstResumedKey.length + 16);

    await projector.project(pause('parent-stream-3', 'parent-int-3'));
    await projector.project(resume(parentRunId, 'parent-stream-3', 'parent-stream-4'));
    const beforeReusedStream = observer.starts.filter((span) => span.name === 'subagent.metrics').length;
    const childEndingsBeforeReusedStream = observer.endings.filter((ending) => (
      ending.spanKey === 'run:stable-invocation-child:child-stream-3'
    )).length;
    await projector.project(resume(childRunId, 'child-stream-3', 'child-stream-3'));
    expect(observer.starts.filter((span) => span.name === 'subagent.metrics')).toHaveLength(beforeReusedStream);
    expect(observer.endings.filter((ending) => ending.spanKey === 'run:stable-invocation-child:child-stream-3'))
      .toHaveLength(childEndingsBeforeReusedStream);
    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 5 }, {
      runId: parentRunId, streamId: 'parent-stream-4',
    }));
    expect(projector.getTraceDiagnostics().activeSpans).toBe(0);
  });

  it('fences stale run starts after other runs evict the global remembered-span entry', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer, { maxRememberedSpanKeys: 1, maxSeenEventIds: 1 });
    const runId = 'fenced-stream-run';
    const oldStreamId = 'fenced-old-stream';
    const newStreamId = 'fenced-new-stream';
    const started = event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId, streamId: oldStreamId });

    await projector.project(started);
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'fenced-pause', reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-fence',
    }, { runId, streamId: oldStreamId }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'cp-fence', resumeReason: 'approved', newStreamId,
    }, { runId, streamId: newStreamId }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'other', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: 'fence-pressure-run', streamId: 'pressure-stream' }));
    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 1 }, {
      runId: 'fence-pressure-run', streamId: 'pressure-stream',
    }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'replayed-old-stream', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId, streamId: oldStreamId }));

    expect(observer.starts.filter((span) => span.runId === runId && span.name === 'agent.run')).toHaveLength(2);
    expect(observer.endings.some((ending) => ending.spanKey === `run:${runId}:${newStreamId}`)).toBe(false);
  });

  it('still fences late lifecycle events when the resumed parent segment could not be created', async () => {
    const parentRunId = 'missing-resumed-span-parent';
    const childRunId = 'missing-resumed-span-child';
    const rejectedParentSpan = `run:${parentRunId}:parent-stream-2`;
    class RejectOneSpanObserver extends RecordingObservability {
      public override startSpan(input: SpanStart): SpanHandle {
        if (input.spanKey === rejectedParentSpan) throw new Error('synthetic observer failure');
        return super.startSpan(input);
      }
    }
    const observer = new RejectOneSpanObserver();
    const projector = new LangSmithEventProjectorV2(observer);
    const budget = { type: 'tool_calls' as const, limit: 4, used: 1 };

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));
    await projector.project(event('TOOL_STARTED', {
      toolName: 'metrics_subagent', source: 'subagent', attempt: 1,
    }, { runId: parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call', attemptId: 'tool-attempt' }));
    await projector.project(event('SUBAGENT_STARTED', {
      subagentType: 'metrics', childRunId, parentRunId, budget,
    }, { runId: parentRunId, parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call' }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'child', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: childRunId, parentRunId, streamId: 'child-stream-1' }));
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'pause-1', reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-missing-span',
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'cp-missing-span', resumeReason: 'approved', newStreamId: 'parent-stream-2',
    }, { runId: parentRunId, streamId: 'parent-stream-2' }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'cp-missing-span', resumeReason: 'approved', newStreamId: 'child-stream-2',
    }, { runId: childRunId, parentRunId, streamId: 'child-stream-2' }));

    const activeBeforeLateEvents = projector.getTraceDiagnostics().activeSpans;
    expect(activeBeforeLateEvents).toBeGreaterThan(0);
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'late-pause', reason: 'late-old-stream', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-missing-span',
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));
    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 10 }, {
      runId: parentRunId, streamId: 'parent-stream-1',
    }));

    expect(projector.getTraceDiagnostics().activeSpans).toBe(activeBeforeLateEvents);
    expect(projector.getTraceDiagnostics().terminalRuns).toBe(0);
    expect(observer.endings.some((ending) => ending.spanKey === 'run:missing-resumed-span-child:child-stream-2')).toBe(false);
    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 11 }, {
      runId: parentRunId, streamId: 'parent-stream-2',
    }));
    expect(projector.getTraceDiagnostics().activeSpans).toBe(0);
  });

  it('rejects a stale resume event whose predecessor is no longer the retired stream', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const runId = 'stale-resume-run';
    const start = (streamId: string) => event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId, streamId });
    const pause = (streamId: string, interruptId: string) => event('RUN_PAUSED', {
      interruptId, reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-stale-resume',
    }, { runId, streamId });
    const resume = (_oldStreamId: string, newStreamId: string) => event('RUN_RESUMED', {
      checkpointVersion: 'cp-stale-resume', resumeReason: 'approved', newStreamId,
    }, { runId, streamId: newStreamId });

    await projector.project(start('stream-1'));
    await projector.project(pause('stream-1', 'interrupt-1'));
    await projector.project(resume('stream-1', 'stream-2'));
    await projector.project(pause('stream-2', 'interrupt-2'));
    await projector.project(resume('stream-2', 'stream-3'));
    const activeBeforeStaleResume = projector.getTraceDiagnostics().activeSpans;
    const startsBeforeStaleResume = observer.starts.length;

    await projector.project(resume('stream-1', 'stream-2'));

    expect(observer.starts).toHaveLength(startsBeforeStaleResume);
    expect(projector.getTraceDiagnostics().activeSpans).toBe(activeBeforeStaleResume);
    expect(observer.endings.some((ending) => ending.spanKey === `run:${runId}:stream-3`)).toBe(false);
    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 10 }, { runId, streamId: 'stream-3' }));
  });

  it('accepts the producer contract where RUN_RESUMED envelope and payload both name the new stream', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const runId = 'producer-resume-contract-run';

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId, streamId: 'producer-stream-1' }));
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'producer-pause', reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-producer',
    }, { runId, streamId: 'producer-stream-1' }));

    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'cp-producer', resumeReason: 'approved', newStreamId: 'producer-stream-2',
    }, { runId, streamId: 'producer-stream-2' }));

    expect(observer.starts.some((span) => span.spanKey === `run:${runId}:producer-stream-2`)).toBe(true);
    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 1 }, {
      runId, streamId: 'producer-stream-2',
    }));
    expect(projector.getTraceDiagnostics().activeSpans).toBe(0);
  });

  it('rejects RUN_RESUMED when the envelope stream differs from payload.newStreamId', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const runId = 'mismatched-resume-contract-run';

    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId, streamId: 'mismatch-stream-1' }));
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'mismatch-pause', reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-mismatch',
    }, { runId, streamId: 'mismatch-stream-1' }));

    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'cp-mismatch', resumeReason: 'approved', newStreamId: 'mismatch-stream-2',
    }, { runId, streamId: 'mismatch-stream-1' }));

    expect(observer.starts.some((span) => span.spanKey === `run:${runId}:mismatch-stream-2`)).toBe(false);
    expect(projector.getTraceDiagnostics().activeSpans).toBe(0);
  });

  it('rejects stream-less lifecycle events after a Run has acquired stream identity', async () => {
    const observer = new RecordingObservability();
    const projector = new LangSmithEventProjectorV2(observer);
    const runId = 'streamless-lifecycle-run';
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId, streamId: 'stream-1' }));
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'pause-1', reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-streamless',
    }, { runId, streamId: 'stream-1' }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'cp-streamless', resumeReason: 'approved', newStreamId: 'stream-2',
    }, { runId, streamId: 'stream-2' }));
    const activeBeforeStreamless = projector.getTraceDiagnostics().activeSpans;

    await projector.project(event('RUN_PAUSED', {
      interruptId: 'pause-without-stream', reason: 'stale', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-streamless',
    }, { runId }));
    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 10 }, { runId }));

    expect(projector.getTraceDiagnostics().activeSpans).toBe(activeBeforeStreamless);
    expect(projector.getTraceDiagnostics().terminalRuns).toBe(0);
    expect(observer.endings.some((ending) => ending.spanKey === `run:${runId}:stream-2`)).toBe(false);
    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 11 }, { runId, streamId: 'stream-2' }));
    expect(projector.getTraceDiagnostics().activeSpans).toBe(0);
  });

  it('retires a child stream on parent pause even when child span creation failed', async () => {
    const parentRunId = 'pause-without-child-span-parent';
    const childRunId = 'pause-without-child-span-child';
    class RejectChildSpanObserver extends RecordingObservability {
      public override startSpan(input: SpanStart): SpanHandle {
        if (input.spanKey === `run:${childRunId}:child-stream-1`) throw new Error('synthetic child span failure');
        return super.startSpan(input);
      }
    }
    const observer = new RejectChildSpanObserver();
    const projector = new LangSmithEventProjectorV2(observer);
    const budget = { type: 'tool_calls' as const, limit: 4, used: 1 };
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));
    await projector.project(event('TOOL_STARTED', {
      toolName: 'metrics_subagent', source: 'subagent', attempt: 1,
    }, { runId: parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call', attemptId: 'tool-attempt' }));
    await projector.project(event('SUBAGENT_STARTED', {
      subagentType: 'metrics', childRunId, parentRunId, budget,
    }, { runId: parentRunId, parentRunId, streamId: 'parent-stream-1', toolCallId: 'metrics-call' }));
    await projector.project(event('RUN_STARTED', {
      profile: 'simulation', trigger: 'child', deadline: '2026-10-04T10:01:00.000Z', versionSnapshot: {},
    }, { runId: childRunId, parentRunId, streamId: 'child-stream-1' }));
    await projector.project(event('RUN_PAUSED', {
      interruptId: 'pause-parent', reason: 'approval', expiresAt: '2026-10-04T10:05:00.000Z', checkpointVersion: 'cp-child-retire',
    }, { runId: parentRunId, streamId: 'parent-stream-1' }));

    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 8 }, {
      runId: childRunId, parentRunId, streamId: 'child-stream-1',
    }));
    expect(projector.getTraceDiagnostics().terminalRuns).toBe(0);

    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'cp-child-retire', resumeReason: 'approved', newStreamId: 'parent-stream-2',
    }, { runId: parentRunId, streamId: 'parent-stream-2' }));
    await projector.project(event('RUN_RESUMED', {
      checkpointVersion: 'cp-child-retire', resumeReason: 'approved', newStreamId: 'child-stream-2',
    }, { runId: childRunId, parentRunId, streamId: 'child-stream-2' }));

    expect(observer.starts.some((span) => span.spanKey === `run:${childRunId}:child-stream-2`)).toBe(true);
    await projector.project(event('RUN_FINISHED', { outcome: 'partial', durationMs: 12 }, {
      runId: parentRunId, streamId: 'parent-stream-2',
    }));
    expect(projector.getTraceDiagnostics().activeSpans).toBe(0);
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
