import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
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
    first.close?.();

    const second = createAgentRuntime({
      model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]), workspaceRoots: [], sqlitePath: path,
    });
    expect(await second.replayRun(result.runId)).toBeGreaterThan(0);
    const messages = await second.eventStoreV2.listMessagesByRun(result.runId);
    expect(messages.filter(({ message }) => message.role === 'assistant')).toHaveLength(1);
    expect(messages.find(({ message }) => message.role === 'assistant')?.message.status).toBe('completed');
    second.close?.();
  });
});
