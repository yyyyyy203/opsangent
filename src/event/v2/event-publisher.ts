import type {
  AgentEventEnvelopeV2,
  EventStore,
  PendingAgentEventV2,
} from '../../contracts/index.js';
import type { EventPublisherV2Like } from '../../contracts/event-publisher.js';
import { parseAgentEventV2 } from '../../contracts/event-v2/schema.js';
import { SequenceConflictError } from '../../contracts/event-store.js';
import type { ReplayBufferV2 } from './replay-buffer.js';

export interface EventProjectorV2 {
  name: string;
  project(event: AgentEventEnvelopeV2): Promise<void> | void;
}

export interface ProjectionFailureRecordV2 {
  eventId: string;
  runId: string;
  sequence: number;
  projector: string;
  errorCode: string;
  message: string;
  attempts: number;
}

export interface ProjectionFailureSinkV2 {
  record(failure: ProjectionFailureRecordV2): Promise<void> | void;
}

export class InMemoryProjectionFailureSink implements ProjectionFailureSinkV2 {
  public readonly records: ProjectionFailureRecordV2[] = [];

  public record(failure: ProjectionFailureRecordV2): void {
    this.records.push(structuredClone(failure));
  }
}

export class EventPublisherV2 implements EventPublisherV2Like {
  private readonly projectors = new Set<EventProjectorV2>();
  private readonly tails = new Map<string, Promise<AgentEventEnvelopeV2>>();

  public constructor(
    private readonly store: EventStore,
    private readonly replay: ReplayBufferV2,
    private readonly failures: ProjectionFailureSinkV2,
  ) {}

  public subscribe(projector: EventProjectorV2): () => void {
    this.projectors.add(projector);
    return () => this.projectors.delete(projector);
  }

  public async publish(pending: PendingAgentEventV2): Promise<AgentEventEnvelopeV2> {
    // Validate and snapshot before allocating a sequence or yielding to another caller.
    parseAgentEventV2({ ...pending, sequence: 1 });
    const snapshot = structuredClone(pending);
    const previous = this.tails.get(snapshot.runId);
    const current = (previous ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.publishOrdered(snapshot));
    this.tails.set(snapshot.runId, current);
    try {
      return await current;
    } finally {
      if (this.tails.get(snapshot.runId) === current) this.tails.delete(snapshot.runId);
    }
  }

  /** Re-dispatches persisted events so projection runners can recover after a process restart. */
  public async replayRun(runId: string, afterSequence = 0, limit = 1_000): Promise<number> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError('afterSequence must be a non-negative safe integer');
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('replay limit must be a positive safe integer');
    const previous = this.tails.get(runId);
    const current = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const events = await this.store.readRun(runId, afterSequence, limit);
      for (const event of events) await this.dispatch(event);
      return events.length;
    });
    const tail = current.then(() => ({}) as AgentEventEnvelopeV2);
    this.tails.set(runId, tail);
    try { return await current; }
    finally {
      if (this.tails.get(runId) === tail) this.tails.delete(runId);
    }
  }

  private async publishOrdered(pending: PendingAgentEventV2): Promise<AgentEventEnvelopeV2> {
    let expected = await this.store.currentSequence(pending.runId);
    let event: AgentEventEnvelopeV2;
    try {
      event = await this.assignAndStore(pending, expected);
    } catch (error) {
      if (!(error instanceof SequenceConflictError)) throw error;
      expected = await this.store.currentSequence(pending.runId);
      event = await this.assignAndStore(pending, expected);
    }
    await this.dispatch(event);
    return structuredClone(event);
  }

  private async assignAndStore(pending: PendingAgentEventV2, expected: number): Promise<AgentEventEnvelopeV2> {
    if (pending.durability === 'durable') {
      const [stored] = await this.store.append(pending.runId, expected, [pending]);
      if (stored === undefined) throw new Error('event store did not return the appended event');
      return stored;
    }
    const [sequence] = await this.store.reserveSequence(pending.runId, expected, 1);
    if (sequence === undefined) throw new Error('event store did not reserve an event sequence');
    const event = parseAgentEventV2({ ...structuredClone(pending), sequence });
    this.replay.push(event);
    return event;
  }

  private async dispatch(event: AgentEventEnvelopeV2): Promise<void> {
    const projectors = [...this.projectors];
    const outcomes = await Promise.allSettled(projectors.map(async (projector) => projector.project(structuredClone(event))));
    const records: Promise<unknown>[] = [];
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') return;
      const projector = projectors[index];
      if (projector === undefined) return;
      records.push(Promise.resolve().then(() => this.failures.record(toFailure(event, projector.name, outcome.reason, 1))));
    });
    await Promise.allSettled(records);
  }
}

export function toFailure(
  event: AgentEventEnvelopeV2,
  projector: string,
  error: unknown,
  attempts: number,
): ProjectionFailureRecordV2 {
  const candidate = typeof error === 'object' && error !== null ? error as { code?: unknown; message?: unknown } : undefined;
  return {
    eventId: event.eventId,
    runId: event.runId,
    sequence: event.sequence,
    projector,
    errorCode: typeof candidate?.code === 'string' && candidate.code.length > 0 ? candidate.code : 'PROJECTION_FAILED',
    message: typeof candidate?.message === 'string' && candidate.message.length > 0 ? candidate.message : 'Projection failed',
    attempts,
  };
}
