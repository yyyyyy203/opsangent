import { describe, expect, it } from 'vitest';
import type { Observability, SpanHandle, SpanStart } from '../src/contracts/index.js';
import { toAgentError } from '../src/contracts/errors.js';
import { ModelFailure } from '../src/model/model-failure.js';
import { ObservabilityModelAttemptObserver } from '../src/observability/model-attempt-observer.js';

class RecordingSpanHandle implements SpanHandle {
  public attributes: Record<string, unknown> = {};
  public ended = false;
  public failed = false;
  public output: unknown;
  public error: unknown;

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
  public readonly spans: SpanStart[] = [];
  public readonly handles: RecordingSpanHandle[] = [];

  public startSpan(input: SpanStart): SpanHandle {
    const handle = new RecordingSpanHandle();
    this.spans.push(input);
    this.handles.push(handle);
    return handle;
  }

  public flush(): Promise<void> {
    return Promise.resolve();
  }
}

describe('model failure and attempt audit contracts', () => {
  it('converts ModelFailure to a checkpoint-safe AgentError DTO', () => {
    const failure = new ModelFailure('server', 'Model request failed.', true, {
      status: 503,
      attempts: 2,
    });

    expect(structuredClone(toAgentError(failure))).toEqual({
      code: 'MODEL_ERROR',
      message: 'Model request failed.',
      retryable: true,
      details: { category: 'server', status: 503, attempts: 2 },
    });
    expect(JSON.stringify(failure)).not.toContain('api.deepseek.com');
  });

  it('allowlists checkpoint-safe ModelFailure details and preserves its validated category', () => {
    const failure = new ModelFailure('server', 'Model request failed.', true, {
      category: 'auth',
      status: 503,
      attempts: 2,
      retryAfterMs: 125.5,
      phase: 'first_byte',
      apiKey: 'deepseek-secret-key',
      url: 'https://api.deepseek.com/chat/completions',
      headers: { authorization: 'Bearer deepseek-secret-key' },
      rawBody: '{"sensitive":"response body"}',
      nonCloneable: () => 'must not survive',
    });

    const checkpointError = toAgentError(failure);
    expect(() => structuredClone(checkpointError)).not.toThrow();
    expect(structuredClone(checkpointError)).toEqual({
      code: 'MODEL_ERROR',
      message: 'Model request failed.',
      retryable: true,
      details: {
        category: 'server',
        status: 503,
        attempts: 2,
        retryAfterMs: 125.5,
        phase: 'first_byte',
      },
    });
    expect(JSON.stringify(checkpointError)).not.toContain('deepseek-secret-key');
    expect(JSON.stringify(checkpointError)).not.toContain('api.deepseek.com');
    expect(JSON.stringify(checkpointError)).not.toContain('response body');
  });

  it('drops invalid values from the ModelFailure detail allowlist', () => {
    const failure = new ModelFailure('timeout', 'Model request timed out.', true, {
      status: 503.5,
      attempts: -1,
      retryAfterMs: Number.POSITIVE_INFINITY,
      phase: 'dns',
    });

    expect(structuredClone(toAgentError(failure))).toEqual({
      code: 'MODEL_ERROR',
      message: 'Model request timed out.',
      retryable: true,
      details: { category: 'timeout' },
    });
  });

  it('maps retry attempts to closed observability child spans and safely reuses keys', async () => {
    const observability = new RecordingObservability();
    const observer = new ObservabilityModelAttemptObserver(observability);

    await observer.record({ type: 'started', runId: 'r1', stepId: 's1', attempt: 1 });
    await observer.record({
      type: 'retry_scheduled',
      runId: 'r1',
      stepId: 's1',
      attempt: 1,
      category: 'server',
      delayMs: 100,
    });
    await observer.record({
      type: 'retry_scheduled',
      runId: 'r1',
      stepId: 's1',
      attempt: 1,
      category: 'server',
      delayMs: 100,
    });

    expect(observability.spans).toEqual([
      expect.objectContaining({ name: 'model.attempt', kind: 'llm', runId: 'r1', stepId: 's1' }),
    ]);
    expect(observability.handles[0]?.failed).toBe(true);
    expect(observability.handles[0]?.attributes).toEqual({
      category: 'server',
      delayMs: 100,
      outcome: 'retry_scheduled',
    });

    await observer.record({ type: 'started', runId: 'r1', stepId: 's1', attempt: 1 });
    await observer.record({
      type: 'succeeded',
      runId: 'r1',
      stepId: 's1',
      attempt: 1,
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    await observer.record({
      type: 'failed',
      runId: 'unknown',
      stepId: 'unknown',
      attempt: 9,
      category: 'network',
      retryable: true,
    });

    expect(observability.handles).toHaveLength(2);
    expect(observability.handles[1]?.ended).toBe(true);
    expect(observability.handles[1]?.output).toEqual({
      outcome: 'succeeded',
      usage: { inputTokens: 12, outputTokens: 4 },
    });

    await observer.record({ type: 'started', runId: 'r1', stepId: 's1', attempt: 1 });
    await observer.record({
      type: 'failed',
      runId: 'r1',
      stepId: 's1',
      attempt: 1,
      category: 'network',
      retryable: true,
    });
    await observer.record({
      type: 'failed',
      runId: 'r1',
      stepId: 's1',
      attempt: 1,
      category: 'network',
      retryable: true,
    });
    await observer.record({ type: 'started', runId: 'r1', stepId: 's1', attempt: 1 });
    await observer.record({ type: 'succeeded', runId: 'r1', stepId: 's1', attempt: 1 });

    expect(observability.handles).toHaveLength(4);
    expect(observability.handles[2]?.failed).toBe(true);
    expect(observability.handles[2]?.attributes).toEqual({
      category: 'network',
      outcome: 'failed',
      retryable: true,
    });
    expect(observability.handles[2]?.error).toMatchObject({
      code: 'MODEL_ERROR',
      message: 'Model attempt failed.',
      retryable: true,
      details: { category: 'network' },
    });
    expect(observability.handles[3]?.ended).toBe(true);
  });
});
