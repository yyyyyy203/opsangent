import { describe, expect, it } from 'vitest';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import { readRunUsageSummary } from '../src/contracts/run-usage.js';

const fixedClock = { now: () => new Date('2026-10-01T00:00:00.000Z') };

describe('Run token usage summary', () => {
  it('sums only MODEL_CALL_COMPLETED once and ignores duplicated message usage', async () => {
    const store = new InMemoryEventMessageStore();
    let id = 0;
    const factory = new EventFactoryV2(fixedClock, { next: (prefix) => `${prefix}-${++id}` });
    const context = { runId: 'run-usage', correlationId: 'run:run-usage', visibility: 'audit' as const, durability: 'durable' as const };
    await store.append('run-usage', 0, [
      factory.create('MODEL_CALL_STARTED', context, { provider: 'test', model: 'test-model', purpose: 'inspection', attempt: 1, inputSummary: 'internal' }),
      factory.create('MESSAGE_COMPLETED', { ...context, visibility: 'public' }, { messageId: 'message-1', completedAt: fixedClock.now().toISOString(), usage: { inputTokens: 5_000, outputTokens: 5_000 } }),
      factory.create('MODEL_CALL_COMPLETED', context, { provider: 'test', model: 'test-model', attempt: 1, durationMs: 10, usage: { inputTokens: 120, outputTokens: 32, cachedInputTokens: 8 } }),
    ]);

    await expect(readRunUsageSummary(store, 'run-usage')).resolves.toEqual({
      completeness: 'complete', inputTokens: 120, outputTokens: 32, cachedInputTokens: 8,
    });
  });

  it('marks retried usage as partial instead of reporting a false exact total', async () => {
    const store = new InMemoryEventMessageStore();
    let id = 0;
    const factory = new EventFactoryV2(fixedClock, { next: (prefix) => `${prefix}-${++id}` });
    const context = { runId: 'run-partial', correlationId: 'run:run-partial', visibility: 'audit' as const, durability: 'durable' as const };
    await store.append('run-partial', 0, [
      factory.create('MODEL_CALL_STARTED', context, { provider: 'test', model: 'test-model', purpose: 'inspection', attempt: 1, inputSummary: 'internal' }),
      factory.create('MODEL_RETRY_SCHEDULED', context, { attempt: 1, reasonCode: 'NETWORK_ERROR', delayMs: 10 }),
      factory.create('MODEL_CALL_STARTED', context, { provider: 'test', model: 'test-model', purpose: 'inspection', attempt: 2, inputSummary: 'internal' }),
      factory.create('MODEL_CALL_COMPLETED', context, { provider: 'test', model: 'test-model', attempt: 2, durationMs: 10, usage: { inputTokens: 120, outputTokens: 32 } }),
    ]);

    await expect(readRunUsageSummary(store, 'run-partial')).resolves.toEqual({
      completeness: 'partial', inputTokens: 120, outputTokens: 32,
    });
    await expect(readRunUsageSummary(store, 'unknown-run')).resolves.toEqual({ completeness: 'unavailable' });
  });

  it('marks a completed model call without input/output counters as partial', async () => {
    const store = new InMemoryEventMessageStore();
    let id = 0;
    const factory = new EventFactoryV2(fixedClock, { next: (prefix) => `${prefix}-${++id}` });
    await store.append('run-missing', 0, [factory.create('MODEL_CALL_COMPLETED', {
      runId: 'run-missing', correlationId: 'run:run-missing', visibility: 'audit', durability: 'durable',
    }, { provider: 'test', model: 'test-model', attempt: 1, durationMs: 10 })]);

    await expect(readRunUsageSummary(store, 'run-missing')).resolves.toEqual({ completeness: 'partial' });
  });
});
