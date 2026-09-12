import type {
  AgentEventEnvelopeV2,
  Clock,
  DurableEventOutbox,
  EventStore,
  EventPublisherV2Like,
  PendingAgentEventV2,
} from '../../contracts/index.js';
import type { DurableOutboxDispatcher } from './durable-outbox-dispatcher.js';

export interface OutboxedEventPublisherOptions {
  outbox: DurableEventOutbox;
  dispatcher: DurableOutboxDispatcher;
  /** The unwrapped EventPublisherV2. It must never point back to this wrapper. */
  publisher: EventPublisherV2Like;
  /** Allows an idempotent wrapper retry to return the already-stored envelope without re-projecting it. */
  eventStore: Pick<EventStore, 'findById'>;
  clock: Clock;
}

/** Routes ordinary durable facts through the transactional Outbox before dispatch. */
export class OutboxedEventPublisher implements EventPublisherV2Like {
  public constructor(private readonly options: OutboxedEventPublisherOptions) {}

  public async publish(event: PendingAgentEventV2): Promise<AgentEventEnvelopeV2> {
    if (event.durability === 'transient') return this.options.publisher.publish(event);

    const [record] = await this.options.outbox.enqueue({
      events: [event],
      createdAt: this.options.clock.now().toISOString(),
    });
    if (record === undefined) throw new Error(`Outbox did not retain event: ${event.eventId}`);

    const dispatched = await this.options.dispatcher.drainRun(event.runId);
    const stored = dispatched.find((candidate) => candidate.eventId === event.eventId);
    if (stored !== undefined) return stored;

    // The only normal path without a pending record is a caller retry after a
    // prior successful mark-published. Read its persisted envelope directly;
    // re-publishing would unnecessarily re-run projectors.
    const existing = await this.options.eventStore.findById(event.eventId);
    if (existing !== null) return existing;
    throw new Error(`Outbox dispatcher did not publish event: ${event.eventId}`);
  }
}
