import type {
  AgentMessageV2,
  EventStore,
  JsonObject,
  MessageStore,
} from '../contracts/index.js';
import { isJsonValue } from '../contracts/message-v2/common.js';
import type { PublicAgentEventV2, PublicEventProjectorV2 } from '../event/projectors/public-projector.js';
import { PublicMessageProjectorV2 } from '../event/projectors/public-message-projector.js';
import type { EventProjectorV2 } from '../event/v2/event-publisher.js';
import type { ReplayBufferV2 } from '../event/v2/replay-buffer.js';
import type { SseFrame } from './sse-encoder.js';

export interface EventStreamSourceV2 {
  subscribe(projector: EventProjectorV2): () => void;
}

export interface EventStreamServiceOptionsV2 {
  store: EventStore;
  replay: ReplayBufferV2;
  messages: MessageStore;
  source: EventStreamSourceV2;
  projector: PublicEventProjectorV2;
  readBatchSize?: number;
}

export interface EventStreamOpenOptionsV2 {
  runId: string;
  lastEventId?: string;
  signal?: AbortSignal;
}

export class EventStreamCursorError extends Error {
  public constructor(public readonly eventId: string) {
    super(`event stream cursor not found: ${eventId}`);
    this.name = 'EventStreamCursorError';
  }
}

export class EventStreamService {
  private readonly readBatchSize: number;

  public constructor(private readonly options: EventStreamServiceOptionsV2) {
    this.readBatchSize = options.readBatchSize ?? 100;
    if (!Number.isSafeInteger(this.readBatchSize) || this.readBatchSize <= 0) {
      throw new RangeError('readBatchSize must be a positive safe integer');
    }
  }

  /** Validate a reconnect cursor before an HTTP transport commits response headers. */
  public async validateCursor(runId: string, lastEventId: string | undefined): Promise<void> {
    await this.resolveCursor(runId, lastEventId);
  }

  public async *open(options: EventStreamOpenOptionsV2): AsyncGenerator<SseFrame, void> {
    if (isAborted(options.signal)) return;
    const cursor = await this.resolveCursor(options.runId, options.lastEventId);
    const liveQueue: PublicAgentEventV2[] = [];
    const seenSequences = new Set<number>();
    let wake: (() => void) | undefined;
    let closed = false;

    const wakeReader = (): void => {
      wake?.();
      wake = undefined;
    };
    const close = (): void => {
      closed = true;
      wakeReader();
    };
    const unsubscribe = this.options.source.subscribe({
      name: 'public-sse-stream',
      project: (event) => {
        if (event.runId !== options.runId || closed) return;
        const projected = this.options.projector.project(event);
        if (projected === null || projected.sequence <= cursor.sequence) return;
        liveQueue.push(projected);
        wakeReader();
      },
    });
    options.signal?.addEventListener('abort', close, { once: true });

    try {
      const catchupUpperBound = await this.options.store.currentSequence(options.runId);
      const transient = this.options.replay.readAfter(options.runId, cursor.sequence)
        .filter((event) => event.sequence <= catchupUpperBound);
      if (cursor.sequence > 0) {
        const messages = await this.publicMessages(options.runId);
        if (messages.length > 0) yield this.messageSnapshotFrame(options.runId, messages);
      }
      let transientIndex = 0;
      let afterSequence = cursor.sequence;
      for (;;) {
        const durable = await this.options.store.readRun(options.runId, afterSequence, this.readBatchSize);
        if (durable.length === 0) break;
        let reachedCatchupUpperBound = false;
        for (const event of durable) {
          if (event.sequence > catchupUpperBound) {
            reachedCatchupUpperBound = true;
            break;
          }
          while (transient[transientIndex]?.sequence !== undefined && transient[transientIndex]!.sequence < event.sequence) {
            const projectedTransient = this.options.projector.project(transient[transientIndex]!);
            const transientFrame = projectedTransient === null ? null : this.toFrame(projectedTransient, seenSequences);
            if (transientFrame !== null) yield transientFrame;
            transientIndex += 1;
          }
          afterSequence = event.sequence;
          const projected = this.options.projector.project(event);
          const frame = projected === null ? null : this.toFrame(projected, seenSequences);
          if (frame !== null) yield frame;
        }
        if (reachedCatchupUpperBound || durable.length < this.readBatchSize || afterSequence >= catchupUpperBound) break;
      }
      while (transient[transientIndex] !== undefined) {
        const projected = this.options.projector.project(transient[transientIndex]!);
        const frame = projected === null ? null : this.toFrame(projected, seenSequences);
        if (frame !== null) yield frame;
        transientIndex += 1;
      }

      while (!closed && !isAborted(options.signal)) {
        const next = liveQueue.shift();
        if (next !== undefined) {
          const frame = this.toFrame(next, seenSequences);
          if (frame !== null) yield frame;
          continue;
        }
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      closed = true;
      options.signal?.removeEventListener('abort', close);
      unsubscribe();
    }
  }

  private async resolveCursor(runId: string, lastEventId: string | undefined): Promise<{ sequence: number }> {
    if (lastEventId === undefined) return { sequence: 0 };
    const event = await this.options.store.findById(lastEventId) ?? this.options.replay.findById(lastEventId);
    if (event === null || event.runId !== runId) throw new EventStreamCursorError(lastEventId);
    return { sequence: event.sequence };
  }

  private async publicMessages(runId: string): Promise<AgentMessageV2[]> {
    const projector = new PublicMessageProjectorV2();
    const stored = await this.options.messages.listMessagesByRun(runId);
    return stored
      .map(({ message }) => message)
      .map((message) => projector.project(message))
      .filter((message): message is AgentMessageV2 => message !== null);
  }

  private messageSnapshotFrame(runId: string, messages: AgentMessageV2[]): SseFrame {
    const data = { schemaVersion: 2, runId, messages };
    if (!isJsonValue(data)) throw new TypeError('message snapshot must be JSON-safe');
    return { event: 'message_snapshot', data };
  }

  private toFrame(event: PublicAgentEventV2, seenSequences: Set<number>): SseFrame | null {
    if (seenSequences.has(event.sequence)) return null;
    seenSequences.add(event.sequence);
    return { id: event.eventId, event: event.type, data: event as unknown as JsonObject };
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
