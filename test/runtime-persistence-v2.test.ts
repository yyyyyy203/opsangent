import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { SqliteDatabase, SqliteEventMessageStore } from '../src/infrastructure/sqlite/index.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runtime SQLite restart recovery', () => {
  it('replays a persisted run without duplicating its terminal message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-runtime-v2-'));
    roots.push(root);
    const path = join(root, 'runtime.sqlite');
    const first = createAgentRuntime({
      model: new ScriptedModel([{ text: '完成', toolCalls: [] }]), workspaceRoots: [], sqlitePath: path,
    });
    const result = await first.agent.reply({ message: '巡检', profileId: 'group-buy-market' });
    const before = await first.eventStoreV2.listMessagesByRun(result.runId);
    expect(before.filter(({ message }) => message.role === 'assistant')).toHaveLength(1);
    await first.close?.();

    const second = createAgentRuntime({
      model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]), workspaceRoots: [], sqlitePath: path,
    });
    expect(await second.ready).toBeGreaterThan(0);
    const messages = await second.eventStoreV2.listMessagesByRun(result.runId);
    expect(messages.filter(({ message }) => message.role === 'assistant')).toHaveLength(1);
    expect(messages.find(({ message }) => message.role === 'assistant')?.message.status).toBe('completed');
    expect(await second.projectionCheckpointsV2.load('audit', result.runId))
      .toBe(await second.eventStoreV2.currentSequence(result.runId));
    await second.close?.();
  });

  it('recovers projection checkpoints across non-durable sequence gaps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-runtime-gap-'));
    roots.push(root);
    const path = join(root, 'runtime.sqlite');
    const database = SqliteDatabase.open(path);
    const store = new SqliteEventMessageStore(database);
    await store.reserveSequence('run-gap', 0, 1);
    const factory = new EventFactoryV2(
      { now: () => new Date('2026-09-09T00:00:00.000Z') },
      { next: (prefix) => `${prefix}-gap` },
    );
    await store.append('run-gap', 1, [factory.create('RUN_STARTED', {
      runId: 'run-gap', correlationId: 'corr-gap', visibility: 'public', durability: 'durable',
    }, {
      profile: 'group-buy-market', trigger: 'recovery-test', deadline: '2026-09-09T00:30:00.000Z', versionSnapshot: {},
    })]);
    database.close();

    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]), workspaceRoots: [], sqlitePath: path,
    });
    expect(await runtime.ready).toBe(1);
    expect(await runtime.projectionCheckpointsV2.load('audit', 'run-gap')).toBe(2);
    await runtime.close?.();
  });
});
