import { describe, expect, it } from 'vitest';
import {
  agentEventEnvelopeV2Schema,
  type AgentEventEnvelopeBaseV2,
  eventDurabilitySchema,
  eventVisibilitySchema,
} from '../src/contracts/event-v2/common.js';
import {
  eventV2PayloadSchemas,
  messageStreamEventPayloadSchemas,
  modelEventPayloadSchemas,
  lifecycleEventPayloadSchemas,
  parseEventV2Payload,
  type EventV2PayloadMapSlice,
} from '../src/contracts/event-v2/lifecycle.js';

const timestamp = '2026-09-07T10:00:00.000Z';

describe('Event V2 lifecycle/model/message-stream payload slice', () => {
  it('keeps a typed V2 envelope with strict common fields', () => {
    const event: AgentEventEnvelopeBaseV2<'RUN_RESUMED', EventV2PayloadMapSlice['RUN_RESUMED']> = {
      schemaVersion: 2,
      eventId: 'event-1',
      sequence: 1,
      type: 'RUN_RESUMED',
      payload: { checkpointVersion: 'cp-1', resumeReason: 'confirmation_resolved', newStreamId: 'stream-2' },
      runId: 'run-1',
      replyId: 'reply-1',
      streamId: 'stream-2',
      correlationId: 'correlation-1',
      timestamp,
      visibility: 'public',
      durability: 'durable',
    };

    expect(agentEventEnvelopeV2Schema.safeParse(event).success).toBe(true);
    expect(eventVisibilitySchema.parse('audit')).toBe('audit');
    expect(eventDurabilitySchema.parse('transient')).toBe('transient');
    expect(agentEventEnvelopeV2Schema.safeParse({ ...event, schemaVersion: 1 }).success).toBe(false);
    expect(agentEventEnvelopeV2Schema.safeParse({ ...event, sequence: -1 }).success).toBe(false);
    expect(agentEventEnvelopeV2Schema.safeParse({ ...event, unexpected: true }).success).toBe(false);
  });

  it('exposes a runtime schema for every payload in the slice', () => {
    expect(Object.keys(eventV2PayloadSchemas).sort()).toEqual([
      ...Object.keys(lifecycleEventPayloadSchemas),
      ...Object.keys(modelEventPayloadSchemas),
      ...Object.keys(messageStreamEventPayloadSchemas),
    ].sort());
  });

  it('validates lifecycle, model, and message stream payloads strictly', () => {
    expect(parseEventV2Payload('RUN_STARTED', {
      profile: 'group-buy-market',
      trigger: 'manual',
      deadline: timestamp,
      versionSnapshot: { profileVersion: 'v1' },
    })).toEqual({
      profile: 'group-buy-market', trigger: 'manual', deadline: timestamp, versionSnapshot: { profileVersion: 'v1' },
    });

    expect(parseEventV2Payload('MODEL_CALL_COMPLETED', {
      provider: 'openai-compatible',
      model: 'test',
      attempt: 1,
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 6 },
      cacheHit: false,
      ttftMs: 25,
      durationMs: 100,
      finishReason: 'stop',
    })).toMatchObject({ provider: 'openai-compatible', model: 'test', attempt: 1, durationMs: 100, finishReason: 'stop', usage: { cachedInputTokens: 6 } });

    expect(parseEventV2Payload('MESSAGE_COMPLETED', {
      messageId: 'message-1',
      completedAt: timestamp,
      usage: { cachedInputTokens: 6 },
    })).toMatchObject({ usage: { cachedInputTokens: 6 } });

    expect(parseEventV2Payload('CONTENT_BLOCK_DELTA', {
      messageId: 'message-1', blockId: 'block-1', delta: '完成', index: 0,
    })).toEqual({ messageId: 'message-1', blockId: 'block-1', delta: '完成', index: 0 });

    expect(() => parseEventV2Payload('MESSAGE_STARTED', {
      messageId: 'message-1', role: 'assistant', status: 'streaming', extra: true,
    })).toThrow();
    expect(() => parseEventV2Payload('CONTENT_BLOCK_DELTA', {
      messageId: 'message-1', blockId: 'block-1', delta: '完成', index: -1,
    })).toThrow();
    expect(lifecycleEventPayloadSchemas.RUN_FINISHED.safeParse({ outcome: 'complete', finalText: '完成', durationMs: 1 }).success).toBe(true);
    expect(lifecycleEventPayloadSchemas.RUN_FINISHED.safeParse({ outcome: 'failed', durationMs: 1 }).success).toBe(false);
    expect(messageStreamEventPayloadSchemas.CONTENT_BLOCK_STARTED.safeParse({
      messageId: 'message-1', blockId: 'block-1', blockType: 'raw_chain_of_thought', index: 0,
    }).success).toBe(false);
  });
});
