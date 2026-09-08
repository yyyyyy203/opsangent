import { isDeepStrictEqual } from 'node:util';
import type { AgentEventEnvelopeV2 } from '../../contracts/index.js';

export interface ReplayBufferOptionsV2 {
  maxEvents: number;
  maxBytes: number;
}

interface BufferedEvent {
  event: AgentEventEnvelopeV2;
  bytes: number;
}

export class ReplayBufferV2 {
  private readonly entries: BufferedEvent[] = [];
  private readonly byId = new Map<string, AgentEventEnvelopeV2>();
  private totalBytes = 0;

  public constructor(private readonly options: ReplayBufferOptionsV2) {
    if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents <= 0) {
      throw new RangeError('maxEvents must be a positive safe integer');
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
  }

  public push(event: AgentEventEnvelopeV2): void {
    if (event.durability !== 'transient') throw new Error('ReplayBufferV2 accepts transient events only');
    const copy = structuredClone(event);
    const duplicate = this.byId.get(copy.eventId);
    if (duplicate !== undefined) {
      if (!isDeepStrictEqual(duplicate, copy)) throw new Error(`replay event id conflict: ${copy.eventId}`);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(copy), 'utf8');
    this.entries.push({ event: copy, bytes });
    this.byId.set(copy.eventId, copy);
    this.totalBytes += bytes;
    this.evictToLimits();
  }

  public readAfter(runId: string, sequence: number): AgentEventEnvelopeV2[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('sequence must be a non-negative safe integer');
    return structuredClone(this.entries
      .map(({ event }) => event)
      .filter((event) => event.runId === runId && event.sequence > sequence)
      .sort((left, right) => left.sequence - right.sequence));
  }

  public findById(eventId: string): AgentEventEnvelopeV2 | null {
    const event = this.byId.get(eventId);
    return event === undefined ? null : structuredClone(event);
  }

  private evictToLimits(): void {
    while (this.entries.length > this.options.maxEvents || this.totalBytes > this.options.maxBytes) {
      const evicted = this.entries.shift();
      if (evicted === undefined) return;
      this.totalBytes -= evicted.bytes;
      this.byId.delete(evicted.event.eventId);
    }
  }
}
