import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEventEnvelopeV2 } from '../src/contracts/index.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { EventPublisherV2, InMemoryProjectionFailureSink } from '../src/event/v2/event-publisher.js';
import { InMemoryProjectionCheckpointStore, ProjectionRunnerV2 } from '../src/event/v2/projection-runner.js';
import { ReplayBufferV2 } from '../src/event/v2/replay-buffer.js';
import { SqliteDatabase, SqliteEventMessageStore, SqliteProjectionCheckpointStore, SqliteProjectionFailureSink } from '../src/infrastructure/sqlite/index.js';

const roots: string[] = [];
async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentops-projection-v2-'));
  roots.push(root);
  return join(root, 'events.sqlite');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function cancelled(sequence = 1): AgentEventEnvelopeV2<'RUN_CANCELLED'> {
  return {
    schemaVersion: 2, eventId: `event-${sequence}`, sequence, type: 'RUN_CANCELLED',
    payload: { actor: 'user-1', reason: 'stop', stage: 'triage' }, runId: 'run-1', correlationId: 'corr-1',
    timestamp: '2026-09-08T00:00:00.000Z', visibility: 'audit', durability: 'durable',
  };
}

describe('SQLite projection recovery', () => {
  it('persists checkpoints and failure records across restart', async () => {
    const path = await databasePath();
    const firstDb = SqliteDatabase.open(path);
    const firstFailures = new SqliteProjectionFailureSink(firstDb, () => '2026-09-08T00:00:00.000Z');
    let projected = 0;
    const failing = new ProjectionRunnerV2({ name: 'audit', project: () => { projected += 1; throw new Error('temporary'); } }, new SqliteProjectionCheckpointStore(firstDb), firstFailures, { maxAttempts: 1 });
    await failing.project(cancelled());
    expect(projected).toBe(1);
    expect(firstDb.raw.prepare('SELECT COUNT(*) AS count FROM projection_failures').get()).toMatchObject({ count: 1 });
    firstDb.close();

    const secondDb = SqliteDatabase.open(path);
    const recovered = new SqliteProjectionCheckpointStore(secondDb);
    expect(await recovered.load('audit', 'run-1')).toBe(0);
    const successful = new ProjectionRunnerV2({ name: 'audit', project: () => { projected += 1; } }, recovered, new InMemoryProjectionFailureSink(), { maxAttempts: 1 });
    await successful.project(cancelled());
    expect(projected).toBe(2);
    expect(await recovered.load('audit', 'run-1')).toBe(1);
    secondDb.close();
  });

  it('replays durable events into a new runtime projection after restart', async () => {
    const path = await databasePath();
    const database = SqliteDatabase.open(path);
    const store = new SqliteEventMessageStore(database);
    const event = new EventFactoryV2({ now: () => new Date('2026-09-08T00:00:00.000Z') }, { next: (prefix) => `${prefix}-1` })
      .create('RUN_CANCELLED', { runId: 'run-replay', correlationId: 'corr-1', visibility: 'audit', durability: 'durable' }, { actor: 'user-1', reason: 'stop', stage: 'triage' });
    await store.append('run-replay', 0, [event]);
    const seen: string[] = [];
    const publisher = new EventPublisherV2(store, new ReplayBufferV2({ maxEvents: 10, maxBytes: 10_000 }), new InMemoryProjectionFailureSink());
    publisher.subscribe(new ProjectionRunnerV2({ name: 'replay', project: (received) => { seen.push(received.eventId); } }, new InMemoryProjectionCheckpointStore(), new InMemoryProjectionFailureSink(), { maxAttempts: 1 }));
    expect(await publisher.replayRun('run-replay')).toBe(1);
    expect(seen).toEqual(['event-1']);
    database.close();
  });
});
