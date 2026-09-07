import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelopeV2, AgentEventPayloadMap, AgentEventTypeV2 } from '../src/contracts/index.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import { MessageAssemblerV2, MessageAssemblyError } from '../src/event/v2/message-assembler.js';

let sequence = 0;
function event<T extends AgentEventTypeV2>(type: T, payload: AgentEventPayloadMap[T]): AgentEventEnvelopeV2<T> {
  sequence += 1;
  return {
    schemaVersion: 2, eventId: `event-${sequence}`, sequence, type, payload,
    runId: 'run-1', sessionId: 'session-1', replyId: 'reply-1', stepId: 'step-1',
    correlationId: 'corr-1', timestamp: '2026-09-07T10:00:00.000Z',
    visibility: 'public', durability: type === 'CONTENT_BLOCK_DELTA' ? 'transient' : 'durable',
  } as AgentEventEnvelopeV2<T>;
}

describe('MessageAssemblerV2', () => {
  it('assembles deltas once and persists a completed snapshot', async () => {
    sequence = 0;
    const store = new InMemoryEventMessageStore();
    const assembler = new MessageAssemblerV2(store);
    await assembler.apply(event('MESSAGE_STARTED', { messageId: 'message-1', role: 'assistant', status: 'streaming' }));
    await assembler.apply(event('CONTENT_BLOCK_STARTED', { messageId: 'message-1', blockId: 'block-1', blockType: 'text', index: 0 }));
    const firstDelta = event('CONTENT_BLOCK_DELTA', { messageId: 'message-1', blockId: 'block-1', delta: '你好', index: 0 });
    await assembler.apply(firstDelta);
    await assembler.apply(structuredClone(firstDelta));
    await assembler.apply(event('CONTENT_BLOCK_DELTA', { messageId: 'message-1', blockId: 'block-1', delta: '，巡检完成', index: 0 }));
    await assembler.apply(event('CONTENT_BLOCK_COMPLETED', { messageId: 'message-1', blockId: 'block-1', blockSummary: '巡检结论', index: 0 }));
    const completedAt = '2026-09-07T10:00:01.000Z';
    const completed = await assembler.apply(event('MESSAGE_COMPLETED', { messageId: 'message-1', completedAt }));

    expect(completed).toMatchObject({ status: 'completed', completedAt });
    expect(completed?.blocks).toEqual([{ blockId: 'block-1', type: 'text', text: '你好，巡检完成' }]);
    expect((await store.getMessage('message-1'))?.message).toEqual(completed);
  });

  it('rejects invalid order and deltas for non-text blocks', async () => {
    sequence = 0;
    const assembler = new MessageAssemblerV2(new InMemoryEventMessageStore());
    await expect(assembler.apply(event('CONTENT_BLOCK_DELTA', {
      messageId: 'missing', blockId: 'block-1', delta: 'bad', index: 0,
    }))).rejects.toBeInstanceOf(MessageAssemblyError);

    await assembler.apply(event('MESSAGE_STARTED', { messageId: 'message-1', role: 'assistant', status: 'streaming' }));
    await assembler.apply(event('CONTENT_BLOCK_STARTED', { messageId: 'message-1', blockId: 'call-1', blockType: 'tool_call', index: 0 }));
    await expect(assembler.apply(event('CONTENT_BLOCK_DELTA', {
      messageId: 'message-1', blockId: 'call-1', delta: '{}', index: 0,
    }))).rejects.toThrow('does not accept text deltas');
  });

  it('accepts a complete structured block and retains blocks when failed', async () => {
    sequence = 0;
    const store = new InMemoryEventMessageStore();
    const assembler = new MessageAssemblerV2(store);
    await assembler.apply(event('MESSAGE_STARTED', { messageId: 'message-1', role: 'assistant', status: 'streaming' }));
    await assembler.apply(event('CONTENT_BLOCK_STARTED', { messageId: 'message-1', blockId: 'evidence-1', blockType: 'evidence_ref', index: 0 }));
    await assembler.apply(event('CONTENT_BLOCK_COMPLETED', {
      messageId: 'message-1', blockId: 'evidence-1', blockSummary: '失败率证据', index: 0,
      block: { blockId: 'evidence-1', type: 'evidence_ref', evidenceId: 'ev-1', summary: '失败率 20%', source: 'prometheus', retrievable: true },
    }));
    const failed = await assembler.apply(event('MESSAGE_FAILED', {
      messageId: 'message-1',
      error: { code: 'MODEL_ERROR', message: 'provider stopped', retryable: true },
    }));
    expect(failed?.status).toBe('failed');
    expect(failed?.blocks.map((block) => block.type)).toEqual(['evidence_ref', 'error']);
  });
});
