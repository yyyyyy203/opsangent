import { describe, expect, it } from 'vitest';
import type { Clock, IdGenerator } from '../src/contracts/index.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import {
  EventPublisherV2,
  InMemoryProjectionFailureSink,
} from '../src/event/v2/event-publisher.js';
import {
  InMemoryProjectionCheckpointStore,
  ProjectionRunnerV2,
} from '../src/event/v2/projection-runner.js';
import { ReplayBufferV2 } from '../src/event/v2/replay-buffer.js';

const clock: Clock = { now: () => new Date('2026-09-07T10:00:00.000Z') };
function ids(): IdGenerator {
  let value = 0;
  return { next: (prefix) => `${prefix}-${++value}` };
}

describe('EventPublisherV2', () => {
  it('persists durable facts, buffers transient deltas, and isolates subscribers', async () => {
    const store = new InMemoryEventMessageStore();
    const replay = new ReplayBufferV2({ maxEvents: 10, maxBytes: 100_000 });
    const failures = new InMemoryProjectionFailureSink();
    const publisher = new EventPublisherV2(store, replay, failures);
    const factory = new EventFactoryV2(clock, ids());
    const received: number[] = [];
    publisher.subscribe({ name: 'broken', project: () => { throw new Error('offline'); } });
    publisher.subscribe({ name: 'healthy', project: (event) => { received.push(event.sequence); } });

    const durable = await publisher.publish(factory.create('RUN_CANCELLED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'public', durability: 'durable',
    }, { actor: 'user-1', reason: 'stop', stage: 'triage' }));
    const transient = await publisher.publish(factory.create('CONTENT_BLOCK_DELTA', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'public', durability: 'transient',
    }, { messageId: 'message-1', blockId: 'block-1', delta: 'a', index: 0 }));

    expect([durable.sequence, transient.sequence]).toEqual([1, 2]);
    expect((await store.readRun('run-1', 0, 10)).map((event) => event.eventId)).toEqual([durable.eventId]);
    expect(replay.readAfter('run-1', 0).map((event) => event.eventId)).toEqual([transient.eventId]);
    expect(received).toEqual([1, 2]);
    expect(failures.records.map((failure) => failure.projector)).toEqual(['broken', 'broken']);
  });

  it('refreshes the sequence once after an optimistic conflict', async () => {
    const store = new InMemoryEventMessageStore();
    const replay = new ReplayBufferV2({ maxEvents: 10, maxBytes: 100_000 });
    const publisherA = new EventPublisherV2(store, replay, new InMemoryProjectionFailureSink());
    const publisherB = new EventPublisherV2(store, replay, new InMemoryProjectionFailureSink());
    const factory = new EventFactoryV2(clock, ids());
    const [one, two] = await Promise.all([
      publisherA.publish(factory.create('RUN_CANCELLED', {
        runId: 'run-1', correlationId: 'corr-1', visibility: 'audit', durability: 'durable',
      }, { actor: 'a', reason: 'one', stage: 'triage' })),
      publisherB.publish(factory.create('RUN_CANCELLED', {
        runId: 'run-1', correlationId: 'corr-1', visibility: 'audit', durability: 'durable',
      }, { actor: 'b', reason: 'two', stage: 'triage' })),
    ]);
    expect([one.sequence, two.sequence].sort()).toEqual([1, 2]);
  });
});

describe('ProjectionRunnerV2', () => {
  it('retries, checkpoints success, and dead-letters exhaustion without republishing', async () => {
    const checkpoints = new InMemoryProjectionCheckpointStore();
    const failures = new InMemoryProjectionFailureSink();
    let attempts = 0;
    const runner = new ProjectionRunnerV2({
      name: 'audit',
      project: () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('temporary'), { code: 'IO_ERROR' });
      },
    }, checkpoints, failures, { maxAttempts: 3 });
    const event = {
      schemaVersion: 2 as const, eventId: 'event-1', sequence: 1, type: 'RUN_CANCELLED' as const,
      payload: { actor: 'a', reason: 'stop', stage: 'triage' as const }, runId: 'run-1', correlationId: 'corr-1',
      timestamp: clock.now().toISOString(), visibility: 'audit' as const, durability: 'durable' as const,
    };
    await runner.project(event);
    await runner.project(structuredClone(event));
    expect(attempts).toBe(3);
    expect(await checkpoints.load('audit', 'run-1')).toBe(1);
    expect(failures.records).toEqual([]);

    const dead = new ProjectionRunnerV2({ name: 'dead', project: () => { throw new Error('permanent'); } }, checkpoints, failures, { maxAttempts: 2 });
    await dead.project(event);
    expect(failures.records.at(-1)).toMatchObject({ eventId: 'event-1', projector: 'dead', errorCode: 'PROJECTION_FAILED', attempts: 2 });
  });
});
