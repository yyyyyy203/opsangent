import { describe, expect, it, vi } from 'vitest';
import { EventStreamService } from '../src/api/event-stream-service.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import { ReplayBufferV2 } from '../src/event/v2/replay-buffer.js';
import { PublicEventProjectorV2 } from '../src/event/projectors/public-projector.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import type { AgentEventEnvelopeV2 } from '../src/contracts/index.js';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { streamEvents } from '../src/api/http-server.js';

const now = new Date('2026-10-01T00:00:00.000Z');
let id = 0;
const factory = new EventFactoryV2({ now: () => now }, { next: () => `event-${++id}` });

function fixture(maxLiveBytes?: number) {
  const store = new InMemoryEventMessageStore();
  const subscribers = new Set<(event: AgentEventEnvelopeV2) => void>();
  const service = new EventStreamService({
    store, messages: store, replay: new ReplayBufferV2({ maxEvents: 300, maxBytes: 2_000_000 }),
    projector: new PublicEventProjectorV2(),
    ...(maxLiveBytes === undefined ? {} : { maxLiveBytes }),
    source: { subscribe: (projector) => {
      const callback = (event: AgentEventEnvelopeV2) => { void projector.project(event); };
      subscribers.add(callback);
      return () => { subscribers.delete(callback); };
    } },
  });
  const event = (sequence: number, runId = 'run-1') => ({
    ...factory.create('RUN_FINISHED', { runId, correlationId: 'corr-1', visibility: 'public', durability: 'durable' }, { outcome: 'complete', durationMs: 1 }),
    sequence,
  });
  return { store, service, subscribers, event, publish: (value: AgentEventEnvelopeV2) => { for (const subscriber of subscribers) subscriber(value); } };
}

async function subscribed(f: ReturnType<typeof fixture>): Promise<void> {
  for (let attempt = 0; attempt < 20 && f.subscribers.size === 0; attempt += 1) await Promise.resolve();
  expect(f.subscribers.size).toBe(1);
}

class ResponseDouble extends EventEmitter {
  public writes: string[] = [];
  public status = 0;
  public flushed = false;
  public destroyed = false;
  public writableEnded = false;
  public backpressure = false;
  public writeHead(status: number): this { this.status = status; return this; }
  public flushHeaders(): void { this.flushed = true; }
  public write(value: string): boolean { this.writes.push(value); return !this.backpressure; }
  public end(): void { this.writableEnded = true; }
  public disconnect(): void { this.destroyed = true; this.emit('close'); }
}

describe('web SSE recovery', () => {
  it('skips the full message query in snapshots=none mode', async () => {
    const f = fixture();
    const first = f.event(1);
    await f.store.append('run-1', 0, [first]);
    const list = vi.spyOn(f.store, 'listMessagesByRun').mockRejectedValue(new Error('full scan'));
    const stream = f.service.open({ runId: 'run-1', lastEventId: first.eventId, includeMessageSnapshot: false });
    const pending = stream.next();
    await subscribed(f);
    f.publish(f.event(2));
    expect((await pending).value?.event).toBe('RUN_FINISHED');
    expect(list).not.toHaveBeenCalled();
    await stream.return(undefined);
  });

  it('keeps the legacy message snapshot on reconnect by default', async () => {
    const f = fixture();
    const first = f.event(1);
    await f.store.append('run-1', 0, [first]);
    await f.store.saveMessage({
      schemaVersion: 2, id: 'message-1', runId: 'run-1', role: 'assistant', status: 'completed', visibility: 'user',
      blocks: [{ type: 'text', blockId: 'block-1', text: 'hello' }], createdAt: now.toISOString(), completedAt: now.toISOString(),
    }, null);
    const list = vi.spyOn(f.store, 'listMessagesByRun');
    const stream = f.service.open({ runId: 'run-1', lastEventId: first.eventId });
    expect((await stream.next()).value?.event).toBe('message_snapshot');
    expect(list).toHaveBeenCalledWith('run-1');
    await stream.return(undefined);
  });

  it('closes on a 257th queued event with a resync signal and unsubscribes', async () => {
    const f = fixture();
    const stream = f.service.open({ runId: 'run-1' });
    const pending = stream.next();
    await subscribed(f);
    for (let sequence = 1; sequence <= 257; sequence += 1) f.publish(f.event(sequence));
    expect((await pending).value?.event).toBe('stream_error');
    expect((await stream.next()).done).toBe(true);
    expect(f.subscribers.size).toBe(0);
  });

  it('waits for drain before writing the next event and cancels on close', async () => {
    const f = fixture();
    const request = new EventEmitter();
    const response = new ResponseDouble();
    response.backpressure = true;
    const serving = streamEvents(request as IncomingMessage, response as unknown as ServerResponse, f.service, 'run-1', undefined);
    await subscribed(f);
    f.publish(f.event(1));
    f.publish(f.event(2));
    for (let attempt = 0; attempt < 20 && response.writes.length === 0; attempt += 1) await Promise.resolve();
    expect(response.writes).toHaveLength(1);
    response.backpressure = false;
    response.emit('drain');
    for (let attempt = 0; attempt < 20 && response.writes.length < 2; attempt += 1) await Promise.resolve();
    expect(response.writes).toHaveLength(2);
    response.disconnect();
    await serving;
    expect(f.subscribers.size).toBe(0);
  });

  it('clears its heartbeat timer and stops writing after close', async () => {
    const f = fixture();
    const request = new EventEmitter();
    const response = new ResponseDouble();
    let tick: (() => void) | undefined;
    let cleared = false;
    const serving = streamEvents(request as IncomingMessage, response as unknown as ServerResponse, f.service, 'run-1', undefined, false, {
      set(callback, ms) { expect(ms).toBe(15_000); tick = callback; return 1; },
      clear(handle) { expect(handle).toBe(1); cleared = true; },
    });
    await subscribed(f);
    expect(response.flushed).toBe(true);
    tick?.();
    expect(response.writes).toEqual([': heartbeat\n\n']);
    response.disconnect();
    await serving;
    expect(cleared).toBe(true);
    tick?.();
    expect(response.writes).toHaveLength(1);
  });

  it('closes when projected live bytes exceed the cap', async () => {
    const f = fixture(1);
    const stream = f.service.open({ runId: 'run-1' });
    const pending = stream.next();
    await subscribed(f);
    f.publish(f.event(1));
    expect((await pending).value?.event).toBe('stream_error');
    expect(f.subscribers.size).toBe(1);
    expect((await stream.next()).done).toBe(true);
    expect(f.subscribers.size).toBe(0);
  });

  it('does not repeat a live duplicate sequence', async () => {
    const f = fixture();
    const stream = f.service.open({ runId: 'run-1' });
    const first = stream.next();
    await subscribed(f);
    const event = f.event(1);
    f.publish(event);
    expect((await first).value?.id).toBe(event.eventId);
    const second = stream.next();
    f.publish(event);
    const later = f.event(2);
    f.publish(later);
    expect((await second).value?.id).toBe(later.eventId);
    await stream.return(undefined);
  });

  it('rejects a late out-of-order live sequence', async () => {
    const f = fixture();
    const stream = f.service.open({ runId: 'run-1' });
    const first = stream.next();
    await subscribed(f);
    f.publish(f.event(2));
    expect((await first).value?.event).toBe('RUN_FINISHED');
    const second = stream.next();
    f.publish(f.event(1));
    await expect(second).rejects.toThrow('out of order');
    expect(f.subscribers.size).toBe(0);
  });

  it('stops durable catch-up when aborted while the store read is pending', async () => {
    const f = fixture();
    await f.store.append('run-1', 0, [f.event(1)]);
    const originalRead = f.store.readRun.bind(f.store);
    let resume: (() => void) | undefined;
    vi.spyOn(f.store, 'readRun').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => { resume = resolve; });
      return originalRead(...args);
    });
    const controller = new AbortController();
    const stream = f.service.open({ runId: 'run-1', signal: controller.signal });
    const pending = stream.next();
    await subscribed(f);
    for (let attempt = 0; attempt < 20 && resume === undefined; attempt += 1) await Promise.resolve();
    expect(resume).toBeDefined();
    controller.abort();
    resume?.();
    expect((await pending).done).toBe(true);
    expect(f.subscribers.size).toBe(0);
  });
});
