import type {
  AgentEventEnvelopeV2,
  AgentMessageV2,
  EventStore,
  JsonObject,
  MessageStore,
} from '../contracts/index.js';
import { isJsonValue } from '../contracts/message-v2/common.js';
import type { PublicAgentEventV2, PublicEventProjectorV2 } from '../event/projectors/public-projector.js';
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
      const catchup = await this.readAvailableAfter(options.runId, cursor.sequence);
      if (await this.needsSnapshot(options.runId, cursor.sequence, catchup)) {
        yield this.messageSnapshotFrame(options.runId, await this.publicMessages(options.runId));
      }
      for (const event of catchup) {
        const projected = this.options.projector.project(event);
        const frame = projected === null ? null : this.toFrame(projected, seenSequences);
        if (frame !== null) yield frame;
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

  private async readAvailableAfter(runId: string, sequence: number): Promise<AgentEventEnvelopeV2[]> {
    const durable = await this.readAllDurableAfter(runId, sequence);
    const transient = this.options.replay.readAfter(runId, sequence);
    return [...durable, ...transient]
      .sort((left, right) => left.sequence - right.sequence)
      .filter((event, index, events) => index === 0 || event.sequence !== events[index - 1]?.sequence);
  }

  private async readAllDurableAfter(runId: string, sequence: number): Promise<AgentEventEnvelopeV2[]> {
    const events: AgentEventEnvelopeV2[] = [];
    let after = sequence;
    for (;;) {
      const batch = await this.options.store.readRun(runId, after, this.readBatchSize);
      if (batch.length === 0) return events;
      events.push(...batch);
      after = batch[batch.length - 1]?.sequence ?? after;
      if (batch.length < this.readBatchSize) return events;
    }
  }

  private async needsSnapshot(runId: string, cursorSequence: number, available: readonly AgentEventEnvelopeV2[]): Promise<boolean> {
    const currentSequence = await this.options.store.currentSequence(runId);
    if (currentSequence <= cursorSequence) return false;
    const availableSequences = new Set(available.map((event) => event.sequence));
    for (let sequence = cursorSequence + 1; sequence <= currentSequence; sequence += 1) {
      if (!availableSequences.has(sequence) && (await this.publicMessages(runId)).length > 0) return true;
    }
    return false;
  }

  private async publicMessages(runId: string): Promise<AgentMessageV2[]> {
    const stored = await this.options.messages.listMessagesByRun(runId);
    return stored
      .map(({ message }) => message)
      .filter((message) => message.visibility !== 'audit')
      .map((message) => ({
        ...message,
        blocks: message.blocks.filter((block) => block.type !== 'raw_tool_call'),
      }));
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
