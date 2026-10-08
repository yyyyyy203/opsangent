import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type { AgentEventEnvelopeV2, ChatModel, ModelResponse, ModelStreamEvent } from '../src/contracts/index.js';
import { parseEventV2Payload } from '../src/contracts/event-v2/lifecycle.js';
import { summarizeRunUsage } from '../src/contracts/run-usage.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { OpenAIStreamAssembler } from '../src/model/openai-compatible/assembler.js';
import { ModelFailure } from '../src/model/model-failure.js';
import { RetryingChatModel } from '../src/model/retrying-model.js';

function truncatedFailure(withUsage = true): ModelFailure {
  const assembler = new OpenAIStreamAssembler();
  assembler.accept({ choices: [{ index: 0, delta: { content: 'partial output' }, finish_reason: 'length' }] });
  if (withUsage) assembler.accept({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 512, prompt_tokens_details: { cached_tokens: 64 } } });
  try { assembler.finish(); } catch (error) {
    if (error instanceof ModelFailure) return error;
    throw error;
  }
  throw new Error('Expected truncation to fail.');
}

function modelEvents(): { make: (type: 'MODEL_CALL_STARTED' | 'MODEL_CALL_COMPLETED' | 'MODEL_CALL_FAILED', payload: unknown, attemptId: string) => AgentEventEnvelopeV2 } {
  let id = 0;
  const factory = new EventFactoryV2({ now: () => new Date('2026-10-07T00:00:00Z') }, { next: (prefix) => `${prefix}-${++id}` });
  return { make: (type, payload, attemptId) => factory.create(type, {
    runId: 'metadata-run', correlationId: 'metadata-run', attemptId, visibility: 'audit', durability: 'durable',
  }, parseEventV2Payload(type, payload)) as AgentEventEnvelopeV2 };
}

describe('failed model usage metadata', () => {
  it('keeps provider usage and finish reason when output is truncated', () => {
    expect(truncatedFailure()).toMatchObject({
      code: 'MODEL_ERROR', retryable: false, details: { category: 'output_truncated' },
      usage: { inputTokens: 120, outputTokens: 512, cachedInputTokens: 64 }, finishReason: 'length',
    });
  });

  it('never returns truncated tool arguments or retries and falls back after length termination', async () => {
    const assembler = new OpenAIStreamAssembler();
    expect(assembler.accept({ choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: 'call-truncated', type: 'function', function: { name: 'source_report', arguments: '{"source":"metrics","summary":' },
    }] }, finish_reason: 'length' }] })).toEqual([]);
    assembler.accept({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 512 } });
    let primaryAttempts = 0;
    let fallbackAttempts = 0;
    const primary: ChatModel = { async *stream(): AsyncGenerator<ModelStreamEvent, ModelResponse> {
      await Promise.resolve();
      primaryAttempts += 1;
      yield* [];
      return assembler.finish();
    } };
    const fallback: ChatModel = { async *stream(): AsyncGenerator<ModelStreamEvent, ModelResponse> {
      await Promise.resolve();
      fallbackAttempts += 1;
      yield* [];
      return { toolCalls: [] };
    } };
    const model = new RetryingChatModel(primary, { maxAttempts: 3, fallback });
    const stream = model.stream([], [], { signal: new AbortController().signal, runId: 'truncated-run', stepId: 'step-1' });
    await expect(stream.next()).rejects.toMatchObject({
      details: { category: 'output_truncated', disposition: 'terminal' },
      usage: { inputTokens: 120, outputTokens: 512 }, finishReason: 'length',
    });
    expect(primaryAttempts).toBe(1);
    expect(fallbackAttempts).toBe(0);
  });

  it('does not fabricate usage when a truncated stream has no usage tail', () => {
    expect(truncatedFailure(false)).not.toHaveProperty('usage');
  });

  it('publishes the safe failure category and known usage without failure internals', async () => {
    const failure = truncatedFailure();
    const model: ChatModel = { async *stream() { await Promise.resolve(); yield { type: 'text_delta', delta: 'partial' }; throw failure; } };
    const runtime = createAgentRuntime({ model, workspaceRoots: [], includeExternalBash: false });
    try {
      const result = await runtime.agent.reply({ message: 'inspect', profileId: 'simulation' });
      expect(result.status).toBe('failed');
      const events = await runtime.eventStoreV2.readRun(result.runId, 0, 100);
      const failed = events.find((event) => event.type === 'MODEL_CALL_FAILED');
      expect(failed).toMatchObject({ payload: {
        error: { code: 'MODEL_ERROR', details: { category: 'output_truncated' } },
        usage: { inputTokens: 120, outputTokens: 512, cachedInputTokens: 64 }, finishReason: 'length',
      } });
      expect(JSON.stringify(failed)).not.toContain('partial output');
      expect(events.some((event) => event.type === 'TOOL_STARTED')).toBe(false);
    } finally { await runtime.close(); }
  });

  it('accepts old failed V2 payloads without new optional fields', () => {
    const payload = { error: { code: 'MODEL_ERROR', message: 'failed', retryable: false }, attempt: 1, retryable: false, durationMs: 1 };
    expect(parseEventV2Payload('MODEL_CALL_FAILED', payload)).toEqual(payload);
  });

  it('accepts failed V2 usage and rejects negative token counters', () => {
    const payload = { error: { code: 'MODEL_ERROR', message: 'failed', retryable: false }, attempt: 1, retryable: false, durationMs: 1,
      usage: { inputTokens: 120, outputTokens: 512 }, finishReason: 'length' };
    expect(parseEventV2Payload('MODEL_CALL_FAILED', payload)).toEqual(payload);
    expect(() => parseEventV2Payload('MODEL_CALL_FAILED', { ...payload, usage: { outputTokens: -1 } })).toThrow();
  });

  it('includes failed usage once and keeps the accounting explicitly partial', () => {
    const { make } = modelEvents();
    const start = make('MODEL_CALL_STARTED', { provider: 'test', model: 'test', purpose: 'test', attempt: 1, inputSummary: 'internal' }, 'attempt-1');
    const end = make('MODEL_CALL_FAILED', { error: { code: 'MODEL_ERROR', message: 'failed', retryable: false }, attempt: 1, retryable: false, durationMs: 1,
      usage: { inputTokens: 120, outputTokens: 512, cachedInputTokens: 64 }, finishReason: 'length' }, 'attempt-1');
    expect(summarizeRunUsage([start, end, end])).toEqual({ completeness: 'partial', inputTokens: 120, outputTokens: 512, cachedInputTokens: 64 });
  });

  it('deduplicates model terminals by run and attempt rather than event count', () => {
    const { make } = modelEvents();
    const payload = { provider: 'test', model: 'test', attempt: 1, durationMs: 1, usage: { inputTokens: 12, outputTokens: 4 } };
    expect(summarizeRunUsage([make('MODEL_CALL_COMPLETED', payload, 'attempt-2'), make('MODEL_CALL_COMPLETED', payload, 'attempt-2')]))
      .toEqual({ completeness: 'complete', inputTokens: 12, outputTokens: 4 });
  });

  it('retains known subtotals when another attempt has missing counters', () => {
    const { make } = modelEvents();
    const payload = { provider: 'test', model: 'test', attempt: 1, durationMs: 1 };
    expect(summarizeRunUsage([
      make('MODEL_CALL_COMPLETED', { ...payload, usage: { inputTokens: 12, outputTokens: 4 } }, 'attempt-3'),
      make('MODEL_CALL_COMPLETED', payload, 'attempt-4'),
    ])).toEqual({ completeness: 'partial', inputTokens: 12, outputTokens: 4 });
  });
});
