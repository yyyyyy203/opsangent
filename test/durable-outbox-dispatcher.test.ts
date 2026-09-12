import { describe, expect, it } from 'vitest';
import type {
  AgentContext,
  Clock,
  DurableEventOutbox,
  PendingAgentEventV2,
} from '../src/contracts/index.js';
import { DurableOutboxDispatcher } from '../src/event/v2/durable-outbox-dispatcher.js';
import { EventPublisherV2, InMemoryProjectionFailureSink } from '../src/event/v2/event-publisher.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import { OutboxedEventPublisher } from '../src/event/v2/outboxed-event-publisher.js';
import { ReplayBufferV2 } from '../src/event/v2/replay-buffer.js';
import { InMemoryDurableState } from '../src/storage/in-memory-durable-state.js';

const timestamp = '2026-09-11T00:00:00.000Z';
const clock: Clock = { now: () => new Date(timestamp) };

function context(runId = 'run-1'): AgentContext {
  return {
    runId,
    status: 'running',
    stage: 'evidence_collection',
    profileId: 'group-buy-market',
    messages: [],
    pendingToolCalls: [],
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: [],
    missingEvidence: [],
    budget: { startedAt: timestamp, maxIterations: 8, iteration: 1, maxToolCalls: 16, toolCallsUsed: 0, maxDurationMs: 60_000 },
    contextVersion: 1,
  };
}

function durableEvent(runId = 'run-1', eventId = `event-${runId}`): PendingAgentEventV2<'RUN_STARTED'> {
  return {
    schemaVersion: 2,
    eventId,
    type: 'RUN_STARTED',
    payload: {
      profile: 'group-buy-market',
      trigger: 'manual',
      deadline: '2026-09-11T00:01:00.000Z',
      versionSnapshot: {},
    },
    runId,
    correlationId: `run:${runId}`,
    timestamp,
    visibility: 'audit',
    durability: 'durable',
  };
}

function transientDelta(runId = 'run-1'): PendingAgentEventV2<'CONTENT_BLOCK_DELTA'> {
  return {
    schemaVersion: 2,
    eventId: `delta-${runId}`,
    type: 'CONTENT_BLOCK_DELTA',
    payload: { messageId: 'message-1', blockId: 'block-1', delta: 'streamed', index: 0 },
    runId,
    correlationId: `run:${runId}`,
    timestamp,
    visibility: 'public',
    durability: 'transient',
  };
}

function fixture() {
  const durable = new InMemoryDurableState(clock);
  const events = new InMemoryEventMessageStore();
  const rawPublisher = new EventPublisherV2(
    events,
    new ReplayBufferV2({ maxEvents: 20, maxBytes: 100_000 }),
    new InMemoryProjectionFailureSink(),
  );
  return { durable, events, rawPublisher };
}

describe('DurableOutboxDispatcher', () => {
  it('drains an event committed before dispatch and marks it published only after storage', async () => {
    const { durable, events, rawPublisher } = fixture();
    const event = durableEvent();
    await durable.transitions.commit({ expectedRevision: null, context: context(), outboxEvents: [event] });
    const dispatcher = new DurableOutboxDispatcher({ outbox: durable.outbox, publisher: rawPublisher, clock, batchSize: 2 });

    const dispatched = await dispatcher.drainRun('run-1');

    expect(dispatched).toMatchObject([{ eventId: event.eventId, sequence: 1 }]);
    expect(await events.readRun('run-1', 0, 10)).toMatchObject([{ eventId: event.eventId }]);
    expect(await durable.outbox.listPending({ runId: 'run-1', limit: 10 })).toEqual([]);
  });

  it('preserves commit order when events share the same clock timestamp', async () => {
    const { durable, events, rawPublisher } = fixture();
    const first = durableEvent('run-1', 'z-first');
    const second = durableEvent('run-1', 'a-second');
    await durable.transitions.commit({ expectedRevision: null, context: context(), outboxEvents: [first, second] });
    const dispatcher = new DurableOutboxDispatcher({ outbox: durable.outbox, publisher: rawPublisher, clock, batchSize: 2 });

    await dispatcher.drainRun('run-1');

    expect((await events.readRun('run-1', 0, 10)).map((event) => event.eventId)).toEqual(['z-first', 'a-second']);
  });

  it('publishes transient deltas directly without placing them in the Outbox', async () => {
    const { durable, events, rawPublisher } = fixture();
    const dispatcher = new DurableOutboxDispatcher({ outbox: durable.outbox, publisher: rawPublisher, clock, batchSize: 2 });
    const publisher = new OutboxedEventPublisher({
      outbox: durable.outbox,
      dispatcher,
      publisher: rawPublisher,
      eventStore: events,
      clock,
    });

    const event = await publisher.publish(transientDelta());

    expect(event).toMatchObject({ eventId: 'delta-run-1', sequence: 1, durability: 'transient' });
    expect(await durable.outbox.listPending({ runId: 'run-1', limit: 10 })).toEqual([]);
    expect(await events.currentSequence('run-1')).toBe(1);
  });

  it('returns an already-published durable event by ID without re-publishing it', async () => {
    const { durable, events, rawPublisher } = fixture();
    const dispatcher = new DurableOutboxDispatcher({ outbox: durable.outbox, publisher: rawPublisher, clock, batchSize: 2 });
    const publisher = new OutboxedEventPublisher({
      outbox: durable.outbox,
      dispatcher,
      publisher: rawPublisher,
      eventStore: events,
      clock,
    });
    const pending = durableEvent();

    const first = await publisher.publish(pending);
    const retry = await publisher.publish(pending);

    expect(retry).toEqual(first);
    expect(await events.readRun('run-1', 0, 10)).toHaveLength(1);
  });

  it('serializes concurrent durable wrapper drains without duplicating projector delivery', async () => {
    const { durable, events, rawPublisher } = fixture();
    let deliveries = 0;
    rawPublisher.subscribe({
      name: 'delivery-counter',
      project: () => { deliveries += 1; },
    });
    const dispatcher = new DurableOutboxDispatcher({ outbox: durable.outbox, publisher: rawPublisher, clock, batchSize: 2 });
    const publisher = new OutboxedEventPublisher({
      outbox: durable.outbox,
      dispatcher,
      publisher: rawPublisher,
      eventStore: events,
      clock,
    });
    const pending = durableEvent();

    await Promise.all([publisher.publish(pending), publisher.publish(pending)]);

    expect(deliveries).toBe(1);
    expect(await events.readRun('run-1', 0, 10)).toHaveLength(1);
  });

  it('reuses an event ID after mark-published fails and never creates a second EventStore row', async () => {
    const { durable, events, rawPublisher } = fixture();
    const event = durableEvent();
    let deliveries = 0;
    rawPublisher.subscribe({
      name: 'mark-retry-delivery-counter',
      project: () => { deliveries += 1; },
    });
    let failMarkPublished = true;
    const outbox: DurableEventOutbox = {
      enqueue: (input) => durable.outbox.enqueue(input),
      listPending: (input) => durable.outbox.listPending(input),
      markPublished: async (input) => {
        if (failMarkPublished) {
          failMarkPublished = false;
          throw new Error('simulated mark-published failure');
        }
        await durable.outbox.markPublished(input);
      },
    };
    await outbox.enqueue({ events: [event], createdAt: timestamp });
    const dispatcher = new DurableOutboxDispatcher({ outbox, publisher: rawPublisher, clock, batchSize: 2 });

    await expect(dispatcher.drainRun('run-1')).rejects.toThrow('simulated mark-published failure');
    expect(await events.readRun('run-1', 0, 10)).toHaveLength(1);
    expect(await durable.outbox.listPending({ runId: 'run-1', limit: 10 })).toHaveLength(1);

    await expect(dispatcher.drainRun('run-1')).resolves.toMatchObject([{ eventId: event.eventId, sequence: 1 }]);
    expect(await events.readRun('run-1', 0, 10)).toHaveLength(1);
    expect(await durable.outbox.listPending({ runId: 'run-1', limit: 10 })).toEqual([]);
    expect(deliveries).toBe(1);
  });
});
