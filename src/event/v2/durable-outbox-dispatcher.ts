import type {
  AgentEventEnvelopeV2,
  Clock,
  DurableEventOutbox,
  EventPublisherV2Like,
} from '../../contracts/index.js';

export interface DurableOutboxDispatcherOptions {
  outbox: DurableEventOutbox;
  publisher: EventPublisherV2Like;
  clock: Clock;
  /** Maximum number of pending records read in one storage operation. */
  batchSize?: number;
}

/**
 * Publishes durable events only after their state transition has committed.
 * It intentionally keeps the raw publisher separate from the Outbox wrapper
 * so recovered rows cannot recurse back into the Outbox.
 */
export class DurableOutboxDispatcher {
  private readonly batchSize: number;

  public constructor(private readonly options: DurableOutboxDispatcherOptions) {
    this.batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize <= 0) {
      throw new RangeError('batchSize must be a positive safe integer');
    }
  }

  /** Drains one Run in bounded storage reads and returns its stored events. */
  public async drainRun(runId: string): Promise<readonly AgentEventEnvelopeV2[]> {
    assertRunId(runId);
    const dispatched: AgentEventEnvelopeV2[] = [];
    while (true) {
      const records = await this.options.outbox.listPending({ runId, limit: this.batchSize });
      if (records.length === 0) return dispatched;
      dispatched.push(...await this.dispatch(records));
    }
  }

  /** Drains every Run without requesting an unbounded pending-row result. */
  public async drainAll(): Promise<number> {
    let count = 0;
    while (true) {
      const records = await this.options.outbox.listPending({ limit: this.batchSize });
      if (records.length === 0) return count;
      count += (await this.dispatch(records)).length;
    }
  }

  private async dispatch(records: Awaited<ReturnType<DurableEventOutbox['listPending']>>): Promise<AgentEventEnvelopeV2[]> {
    const dispatched: AgentEventEnvelopeV2[] = [];
    for (const record of records) {
      const event = await this.options.publisher.publish(record.event);
      await this.options.outbox.markPublished({
        eventId: record.event.eventId,
        publishedAt: this.options.clock.now().toISOString(),
      });
      dispatched.push(event);
    }
    return dispatched;
  }
}

function assertRunId(runId: string): void {
  if (runId.length === 0) throw new RangeError('runId must not be empty');
}
