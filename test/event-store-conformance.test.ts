import { describe, expect, it } from 'vitest';
import { EventIdConflictError, type PendingAgentEventV2 } from '../src/contracts/index.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import { SqliteDatabase, SqliteEventMessageStore } from '../src/infrastructure/sqlite/index.js';

function draft(): PendingAgentEventV2<'RUN_CANCELLED'> {
  return {
    schemaVersion: 2, eventId: 'event-1', type: 'RUN_CANCELLED', runId: 'run-1',
    correlationId: 'corr-1', timestamp: '2026-09-07T10:00:00.000Z', visibility: 'audit', durability: 'durable',
    payload: { actor: 'user', reason: 'stop', stage: 'triage' },
  };
}

describe.each(['memory', 'sqlite'] as const)('%s event store conformance', (backend) => {
  it('rejects repeated ids within a batch without consuming sequence or storing rows', async () => {
    const db = backend === 'sqlite' ? SqliteDatabase.open(':memory:') : undefined;
    const store = db ? new SqliteEventMessageStore(db) : new InMemoryEventMessageStore();
    try {
      await expect(store.append('run-1', 0, [draft(), draft()])).rejects.toBeInstanceOf(EventIdConflictError);
      expect(await store.currentSequence('run-1')).toBe(0);
      expect(await store.readRun('run-1', 0, 10)).toEqual([]);
    } finally { db?.close(); }
  });

  it('rejects sequence overflow without changing the last safe sequence', async () => {
    const db = backend === 'sqlite' ? SqliteDatabase.open(':memory:') : undefined;
    const store = db ? new SqliteEventMessageStore(db) : new InMemoryEventMessageStore();
    try {
      // A single bulk reservation must be rejected before allocating an impossible array.
      await expect(store.reserveSequence('run-1', 0, Number.MAX_SAFE_INTEGER + 1)).rejects.toBeInstanceOf(RangeError);
      expect(await store.currentSequence('run-1')).toBe(0);
    } finally { db?.close(); }
  });
});
