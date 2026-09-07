import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelopeV2 } from '../src/contracts/index.js';
import { ReplayBufferV2 } from '../src/event/v2/replay-buffer.js';

function delta(sequence: number, runId = 'run-1'): AgentEventEnvelopeV2<'CONTENT_BLOCK_DELTA'> {
  return {
    schemaVersion: 2, eventId: `event-${runId}-${sequence}`, sequence, type: 'CONTENT_BLOCK_DELTA',
    payload: { messageId: 'message-1', blockId: 'block-1', delta: String(sequence), index: 0 },
    runId, correlationId: 'corr-1', timestamp: '2026-09-07T10:00:00.000Z',
    visibility: 'public', durability: 'transient',
  };
}

describe('ReplayBufferV2', () => {
  it('evicts oldest transient events by count and reads a run after a sequence', () => {
    const buffer = new ReplayBufferV2({ maxEvents: 2, maxBytes: 100_000 });
    buffer.push(delta(1));
    buffer.push(delta(2));
    buffer.push(delta(3));
    expect(buffer.readAfter('run-1', 0).map((event) => event.sequence)).toEqual([2, 3]);
    expect(buffer.readAfter('run-1', 2).map((event) => event.sequence)).toEqual([3]);
  });

  it('isolates runs, clones values, deduplicates event ids, and enforces transient input', () => {
    const buffer = new ReplayBufferV2({ maxEvents: 10, maxBytes: 100_000 });
    const event = delta(1);
    buffer.push(event);
    buffer.push(structuredClone(event));
    event.payload.delta = 'mutated';
    buffer.push(delta(1, 'run-2'));
    expect(buffer.readAfter('run-1', 0)).toHaveLength(1);
    expect((buffer.readAfter('run-1', 0)[0] as AgentEventEnvelopeV2<'CONTENT_BLOCK_DELTA'> | undefined)?.payload.delta).toBe('1');
    expect(() => buffer.push({ ...delta(2), durability: 'durable' })).toThrow('transient');
  });
});
