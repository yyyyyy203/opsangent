import { describe, expect, it } from 'vitest';
import type { AgentMessageV2, Clock, IdGenerator } from '../src/contracts/index.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { InMemoryEventMessageStore, SequenceConflictError } from '../src/event/v2/in-memory-event-store.js';

const clock: Clock = { now: () => new Date('2026-09-07T10:00:00.000Z') };
const ids: IdGenerator = { next: (prefix) => `${prefix}-1` };

describe('Event V2 store and factory', () => {
  it('injects metadata and conditionally assigns strict run sequence', async () => {
    const store = new InMemoryEventMessageStore();
    const factory = new EventFactoryV2(clock, ids);
    const draft = factory.create('RUN_RESUMED', {
      runId: 'run-1', replyId: 'reply-1', streamId: 'stream-2', correlationId: 'corr-1',
      visibility: 'public', durability: 'durable',
    }, { checkpointVersion: 'cp-1', resumeReason: 'approved', newStreamId: 'stream-2' });

    const [saved] = await store.append('run-1', 0, [draft]);
    expect(saved).toMatchObject({ eventId: 'event-1', sequence: 1, timestamp: clock.now().toISOString() });
    expect(await store.readRun('run-1', 0, 10)).toEqual([saved]);
    await expect(store.append('run-1', 0, [factory.create('RUN_CANCELLED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'audit', durability: 'durable',
    }, { actor: 'user-1', reason: 'stop', stage: 'triage' })])).rejects.toBeInstanceOf(SequenceConflictError);
  });

  it('reserves transient sequences and deduplicates an exact eventId', async () => {
    const store = new InMemoryEventMessageStore();
    expect(await store.reserveSequence('run-1', 0, 2)).toEqual([1, 2]);
    const draft = new EventFactoryV2(clock, ids).create('RUN_CANCELLED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'audit', durability: 'durable',
    }, { actor: 'user-1', reason: 'stop', stage: 'triage' });
    const first = await store.append('run-1', 2, [draft]);
    const duplicate = await store.append('run-1', 0, [structuredClone(draft)]);
    expect(first[0]?.sequence).toBe(3);
    expect(duplicate).toEqual(first);
    expect(await store.findById('event-1')).toEqual(first[0]);
  });

  it('clones data and enforces optimistic message versions', async () => {
    const store = new InMemoryEventMessageStore();
    const message: AgentMessageV2 = {
      schemaVersion: 2, id: 'message-1', runId: 'run-1', role: 'assistant', status: 'streaming',
      visibility: 'user', blocks: [], createdAt: clock.now().toISOString(),
    };
    const created = await store.saveMessage(message, null);
    message.status = 'failed';
    expect((await store.getMessage('message-1'))?.message.status).toBe('streaming');
    const completed = { ...created.message, status: 'completed' as const, completedAt: clock.now().toISOString() };
    expect((await store.saveMessage(completed, 1)).version).toBe(2);
    await expect(store.saveMessage(completed, 1)).rejects.toThrow('message version conflict');
    expect((await store.listMessagesByRun('run-1')).map((item) => item.version)).toEqual([2]);
  });
});
