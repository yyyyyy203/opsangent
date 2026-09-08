import { describe, expect, it } from 'vitest';
import type { AgentMessageV2, Clock, IdGenerator } from '../src/contracts/index.js';
import { EventStreamCursorError, EventStreamService } from '../src/api/event-stream-service.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import { EventPublisherV2, InMemoryProjectionFailureSink } from '../src/event/v2/event-publisher.js';
import { ReplayBufferV2 } from '../src/event/v2/replay-buffer.js';
import { PublicEventProjectorV2 } from '../src/event/projectors/public-projector.js';
import type { SseFrame } from '../src/api/sse-encoder.js';

const clock: Clock = { now: () => new Date('2026-09-07T10:00:00.000Z') };
function ids(): IdGenerator {
  let value = 0;
  return { next: (prefix) => `${prefix}-${++value}` };
}

function runtime(replay = new ReplayBufferV2({ maxEvents: 20, maxBytes: 100_000 })) {
  const store = new InMemoryEventMessageStore();
  const publisher = new EventPublisherV2(store, replay, new InMemoryProjectionFailureSink());
  const service = new EventStreamService({
    store,
    replay,
    messages: store,
    source: publisher,
    projector: new PublicEventProjectorV2(),
  });
  return { store, publisher, service, factory: new EventFactoryV2(clock, ids()) };
}

async function readFrames(iterator: AsyncIterator<SseFrame>, count: number): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  while (frames.length < count) {
    const next = await iterator.next();
    if (next.done === true) break;
    frames.push(next.value);
  }
  return frames;
}

function publicEventData(frame: SseFrame): { sequence: number; runId: string } {
  if (typeof frame.data !== 'object' || frame.data === null || Array.isArray(frame.data)) throw new Error('expected event object');
  const { sequence, runId } = frame.data;
  if (typeof sequence !== 'number' || typeof runId !== 'string') throw new Error('expected public event metadata');
  return { sequence, runId };
}

describe('EventStreamService', () => {
  it('replays stored public events from the start of a run', async () => {
    const { publisher, service, factory } = runtime();
    const first = await publisher.publish(factory.create('RUN_STARTED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'public', durability: 'durable',
    }, { profile: 'group-buy-market', trigger: 'manual', deadline: clock.now().toISOString(), versionSnapshot: {} }));
    await publisher.publish(factory.create('RUN_CANCELLED', {
      runId: 'other-run', correlationId: 'corr-1', visibility: 'public', durability: 'durable',
    }, { actor: 'user', reason: 'stop', stage: 'triage' }));
    const stream = service.open({ runId: 'run-1' });
    const frames = await readFrames(stream, 1);
    await stream.return(undefined);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe(first.eventId);
    expect(frames[0]?.event).toBe('RUN_STARTED');
    expect(publicEventData(frames[0]!).sequence).toBe(1);
    expect(publicEventData(frames[0]!).runId).toBe('run-1');
  });

  it('resumes after Last-Event-ID and hands off to live events without duplicates', async () => {
    const { publisher, service, factory } = runtime();
    const first = await publisher.publish(factory.create('RUN_STARTED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'public', durability: 'durable',
    }, { profile: 'group-buy-market', trigger: 'manual', deadline: clock.now().toISOString(), versionSnapshot: {} }));
    const stream = service.open({ runId: 'run-1', lastEventId: first.eventId });
    const second = await publisher.publish(factory.create('RUN_FINISHED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'public', durability: 'durable',
    }, { outcome: 'complete', durationMs: 10 }));
    const frames = await readFrames(stream, 1);
    await stream.return(undefined);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe(second.eventId);
    expect(frames[0]?.event).toBe('RUN_FINISHED');
    expect(publicEventData(frames[0]!).sequence).toBe(2);
  });

  it('cleans up live subscribers when the stream is aborted', async () => {
    const { publisher, service, factory } = runtime();
    const controller = new AbortController();
    const stream = service.open({ runId: 'run-1', signal: controller.signal });
    controller.abort();
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    await publisher.publish(factory.create('RUN_STARTED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'public', durability: 'durable',
    }, { profile: 'group-buy-market', trigger: 'manual', deadline: clock.now().toISOString(), versionSnapshot: {} }));
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it('rejects an unknown Last-Event-ID instead of silently starting from zero', async () => {
    const { service } = runtime();
    const stream = service.open({ runId: 'run-1', lastEventId: 'missing-event' });
    await expect(stream.next()).rejects.toBeInstanceOf(EventStreamCursorError);
  });

  it('emits a public message snapshot when transient delta history has expired', async () => {
    const replay = new ReplayBufferV2({ maxEvents: 1, maxBytes: 100_000 });
    const { store, publisher, service, factory } = runtime(replay);
    const first = await publisher.publish(factory.create('RUN_STARTED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'public', durability: 'durable',
    }, { profile: 'group-buy-market', trigger: 'manual', deadline: clock.now().toISOString(), versionSnapshot: {} }));
    await publisher.publish(factory.create('CONTENT_BLOCK_DELTA', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'public', durability: 'transient',
    }, { messageId: 'message-1', blockId: 'block-1', delta: 'first', index: 0 }));
    const latestDelta = await publisher.publish(factory.create('CONTENT_BLOCK_DELTA', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'public', durability: 'transient',
    }, { messageId: 'message-1', blockId: 'block-1', delta: 'second', index: 1 }));
    const message: AgentMessageV2 = {
      schemaVersion: 2,
      id: 'message-1',
      runId: 'run-1',
      role: 'assistant',
      status: 'completed',
      visibility: 'user',
      blocks: [{ type: 'text', blockId: 'block-1', text: 'firstsecond' }],
      createdAt: clock.now().toISOString(),
      completedAt: clock.now().toISOString(),
    };
    await store.saveMessage(message, null);
    const stream = service.open({ runId: 'run-1', lastEventId: first.eventId });
    const frames = await readFrames(stream, 2);
    await stream.return(undefined);
    expect(frames[0]).toEqual({ event: 'message_snapshot', data: { schemaVersion: 2, runId: 'run-1', messages: [message] } });
    expect((frames[1] as { id: string }).id).toBe(latestDelta.eventId);
  });
});
