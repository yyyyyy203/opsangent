import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventIdConflictError, MessageVersionConflictError, SequenceConflictError, type Clock, type IdGenerator } from '../src/contracts/index.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { SqliteDatabase, SqliteEventMessageStore } from '../src/infrastructure/sqlite/index.js';

const roots: string[] = [];
const clock: Clock = { now: () => new Date('2026-09-07T10:00:00.000Z') };
function ids(): IdGenerator {
  let value = 0;
  return { next: (prefix) => `${prefix}-${++value}` };
}

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentops-event-v2-'));
  roots.push(root);
  return join(root, 'events.sqlite');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteEventMessageStore', () => {
  it('enables WAL, migrates idempotently, and preserves events across restart', async () => {
    const path = await databasePath();
    const database = SqliteDatabase.open(path);
    const store = new SqliteEventMessageStore(database);
    expect(database.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.raw.pragma('user_version', { simple: true })).toBe(2);
    const draft = new EventFactoryV2(clock, ids()).create('RUN_CANCELLED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'audit', durability: 'durable',
    }, { actor: 'user-1', reason: 'stop', stage: 'triage' });
    const [saved] = await store.append('run-1', 0, [draft]);
    database.close();

    const reopened = SqliteDatabase.open(path);
    const recovered = new SqliteEventMessageStore(reopened);
    expect(await recovered.readRun('run-1', 0, 10)).toEqual([saved]);
    expect(reopened.raw.pragma('user_version', { simple: true })).toBe(2);
    reopened.close();
  });

  it('shares conditional sequence and exact duplicate semantics with the in-memory store', async () => {
    const database = SqliteDatabase.open(await databasePath());
    const store = new SqliteEventMessageStore(database);
    const factory = new EventFactoryV2(clock, ids());
    expect(await store.reserveSequence('run-1', 0, 2)).toEqual([1, 2]);
    const draft = factory.create('RUN_CANCELLED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'audit', durability: 'durable',
    }, { actor: 'user-1', reason: 'stop', stage: 'triage' });
    const first = await store.append('run-1', 2, [draft]);
    expect(await store.append('run-1', 0, [structuredClone(draft)])).toEqual(first);
    await expect(store.append('run-1', 2, [factory.create('RUN_CANCELLED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'audit', durability: 'durable',
    }, { actor: 'user-2', reason: 'stale', stage: 'triage' })])).rejects.toBeInstanceOf(SequenceConflictError);
    database.close();
  });

  it('rolls back a divergent duplicate batch atomically', async () => {
    const database = SqliteDatabase.open(await databasePath());
    const store = new SqliteEventMessageStore(database);
    const factory = new EventFactoryV2(clock, ids());
    const draft = factory.create('RUN_CANCELLED', {
      runId: 'run-1', correlationId: 'corr-1', visibility: 'audit', durability: 'durable',
    }, { actor: 'user-1', reason: 'stop', stage: 'triage' });
    await expect(store.append('run-1', 0, [draft, { ...structuredClone(draft), payload: { ...draft.payload, reason: 'different' } }]))
      .rejects.toBeInstanceOf(EventIdConflictError);
    expect(await store.currentSequence('run-1')).toBe(0);
    expect(await store.readRun('run-1', 0, 10)).toEqual([]);
    database.close();
  });

  it('persists cloned messages with optimistic versions', async () => {
    const database = SqliteDatabase.open(await databasePath());
    const store = new SqliteEventMessageStore(database);
    const message = {
      schemaVersion: 2 as const, id: 'message-1', runId: 'run-1', role: 'assistant' as const,
      status: 'streaming' as const, visibility: 'user' as const, blocks: [], createdAt: clock.now().toISOString(),
    };
    const created = await store.saveMessage(message, null);
    expect(created.version).toBe(1);
    expect((await store.saveMessage({ ...message, status: 'completed', completedAt: clock.now().toISOString() }, 1)).version).toBe(2);
    await expect(store.saveMessage(message, 1)).rejects.toBeInstanceOf(MessageVersionConflictError);
    expect((await store.listMessagesByRun('run-1'))[0]?.version).toBe(2);
    database.close();
  });
});
