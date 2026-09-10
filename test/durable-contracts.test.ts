import { describe, expect, it } from 'vitest';
import { checkpointChecksum, parsePendingToolBatch } from '../src/storage/durable-codec.js';

describe('durable state contracts', () => {
  it('uses canonical JSON ordering when calculating a checkpoint checksum', () => {
    expect(checkpointChecksum({ nested: { b: 2, a: 1 }, z: 3 })).toBe(
      checkpointChecksum({ z: 3, nested: { a: 1, b: 2 } }),
    );
  });

  it('rejects a pending batch whose completed result does not belong to its calls', () => {
    expect(() => parsePendingToolBatch({
      batchId: 'batch-1',
      stepId: 'step-1',
      calls: [{ id: 'call-a', name: 'metrics.query', input: {} }],
      completedResults: [{
        toolCallId: 'call-b',
        toolName: 'metrics.query',
        status: 'success',
        startedAt: '2026-09-10T00:00:00.000Z',
      }],
      state: 'executing',
      createdAt: '2026-09-10T00:00:00.000Z',
    })).toThrow(/completed result/i);
  });
});
