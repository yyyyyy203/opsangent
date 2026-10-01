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
import { encodeSseFrame } from './sse-encoder.js';

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
  maxLiveEvents?: number;
  maxLiveBytes?: number;
}

export interface EventStreamOpenOptionsV2 {
  runId: string;
  lastEventId?: string;
  signal?: AbortSignal;
  includeMessageSnapshot?: boolean;
}

export class EventStreamCursorError extends Error {
  public constructor(public readonly eventId: string) {
    super(`event stream cursor not found: ${eventId}`);
    this.name = 'EventStreamCursorError';
  }
}

export class EventStreamService {
  private readonly readBatchSize: number;
  private readonly maxLiveEvents: number;
  private readonly maxLiveBytes: number;

  public constructor(private readonly options: EventStreamServiceOptionsV2) {
    this.readBatchSize = options.readBatchSize ?? 100;
    this.maxLiveEvents = options.maxLiveEvents ?? 256;
    this.maxLiveBytes = options.maxLiveBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.readBatchSize) || this.readBatchSize <= 0) {
      throw new RangeError('readBatchSize must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxLiveEvents) || this.maxLiveEvents <= 0
      || !Number.isSafeInteger(this.maxLiveBytes) || this.maxLiveBytes <= 0) {
      throw new RangeError('live queue limits must be positive safe integers');
    }
  }

  /** Validate a reconnect cursor before an HTTP transport commits response headers. */
  public async validateCursor(runId: string, lastEventId: string | undefined): Promise<void> {
    await this.resolveCursor(runId, lastEventId);
  }

  public async *open(options: EventStreamOpenOptionsV2): AsyncGenerator<SseFrame, void> {
    if (isAborted(options.signal)) return;
    const cursor = await this.resolveCursor(options.runId, options.lastEventId);
    if (isAborted(options.signal)) return;
    const liveQueue: Array<{ event: PublicAgentEventV2; bytes: number }> = [];
    let liveBytes = 0;
    let sentSequence = cursor.sequence;
    let overflow = false;
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
        const bytes = Buffer.byteLength(encodeSseFrame(this.eventFrame(projected)), 'utf8');
        if (liveQueue.length >= this.maxLiveEvents || liveBytes + bytes > this.maxLiveBytes) {
          overflow = true;
          liveQueue.length = 0;
          liveBytes = 0;
          close();
          return;
        }
        liveQueue.push({ event: projected, bytes });
        liveBytes += bytes;
        wakeReader();
      },
    });
    options.signal?.addEventListener('abort', close, { once: true });

    try {
      const catchupUpperBound = await this.options.store.currentSequence(options.runId);
      const transient = this.options.replay.readAfter(options.runId, cursor.sequence)
        .filter((event) => event.sequence <= catchupUpperBound);
      if (isAborted(options.signal)) return;
      if (cursor.sequence > 0 && options.includeMessageSnapshot !== false) {
        const messages = await this.publicMessages(options.runId);
        if (isAborted(options.signal)) return;
        if (messages.length > 0) yield this.messageSnapshotFrame(options.runId, messages);
      }
      let transientIndex = 0;
      let afterSequence = cursor.sequence;
      for (;;) {
        if (isAborted(options.signal) || overflow) break;
        const durable = await this.options.store.readRun(options.runId, afterSequence, this.readBatchSize);
        if (isAborted(options.signal) || overflow) break;
        if (durable.length === 0) break;
        let reachedCatchupUpperBound = false;
        for (const event of durable) {
          if (isAborted(options.signal) || overflow) break;
          if (event.sequence > catchupUpperBound) {
            reachedCatchupUpperBound = true;
            break;
          }
          while (transient[transientIndex]?.sequence !== undefined && transient[transientIndex]!.sequence < event.sequence) {
            if (isAborted(options.signal) || overflow) break;
            const projectedTransient = this.options.projector.project(transient[transientIndex]!);
            const transientFrame = projectedTransient === null ? null : this.toFrame(projectedTransient, () => sentSequence, (value) => { sentSequence = value; });
            if (transientFrame !== null) yield transientFrame;
            transientIndex += 1;
          }
          afterSequence = event.sequence;
          const projected = this.options.projector.project(event);
          const frame = projected === null ? null : this.toFrame(projected, () => sentSequence, (value) => { sentSequence = value; });
          if (frame !== null) yield frame;
        }
        if (reachedCatchupUpperBound || durable.length < this.readBatchSize || afterSequence >= catchupUpperBound) break;
      }
      while (!isAborted(options.signal) && !overflow && transient[transientIndex] !== undefined) {
        const projected = this.options.projector.project(transient[transientIndex]!);
        const frame = projected === null ? null : this.toFrame(projected, () => sentSequence, (value) => { sentSequence = value; });
        if (frame !== null) yield frame;
        transientIndex += 1;
      }

      while (!isAborted(options.signal)) {
        if (overflow) {
          yield { event: 'stream_error', data: { code: 'BACKPRESSURE_RESYNC', runId: options.runId, message: 'Reconnect and reload snapshots.' } };
          break;
        }
        const next = liveQueue.shift();
        if (next !== undefined) {
          liveBytes -= next.bytes;
          if (next.event.sequence <= catchupUpperBound) continue;
          if (next.event.sequence > sentSequence + 1) {
            let after = sentSequence;
            while (after < next.event.sequence - 1 && !isAborted(options.signal)) {
              const missed = await this.options.store.readRun(options.runId, after, this.readBatchSize);
              if (isAborted(options.signal)) break;
              const eligible = missed.filter((event) => event.sequence < next.event.sequence);
              if (eligible.length === 0) break;
              const previousAfter = after;
              for (const event of eligible) {
                if (isAborted(options.signal)) break;
                after = event.sequence;
                const projected = this.options.projector.project(event);
                const frame = projected === null ? null : this.toFrame(projected, () => sentSequence, (value) => { sentSequence = value; });
                if (frame !== null) yield frame;
              }
              if (after <= previousAfter) break;
              if (missed.length < this.readBatchSize) break;
            }
          }
          if (isAborted(options.signal)) break;
          const frame = this.toFrame(next.event, () => sentSequence, (value) => { sentSequence = value; });
          if (frame !== null) yield frame;
          continue;
        }
        if (closed) break;
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

  private toFrame(event: PublicAgentEventV2, current: () => number, advance: (sequence: number) => void): SseFrame | null {
    if (event.sequence === current()) return null;
    if (event.sequence < current()) throw new Error(`event stream sequence out of order: ${event.sequence} < ${current()}`);
    advance(event.sequence);
    return this.eventFrame(event);
  }

  private eventFrame(event: PublicAgentEventV2): SseFrame {
    return { id: event.eventId, event: event.type, data: event as unknown as JsonObject };
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
