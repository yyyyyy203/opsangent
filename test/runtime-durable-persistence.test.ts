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

describe('runtime durable persistence', () => {
  it('uses the SQLite persistence bundle for checkpoints across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-durable-runtime-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const first = createAgentRuntime({
      model: new ScriptedModel([{ text: 'done', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      sqlitePath,
    });
    const result = await first.agent.reply({ message: 'inspect', profileId: 'group-buy-market' });
    await first.evidence.save({
      evidenceId: 'runtime-evidence-1',
      runId: result.runId,
      source: 'metric',
      summary: { status: 'healthy' },
      raw: { marker: 'runtime-private-evidence' },
      businessTraceIds: [],
      capturedAt: '2026-09-10T00:00:00.000Z',
      captureKey: `runtime:${result.runId}:metric:0`,
    });
    await first.close();

    const second = createAgentRuntime({
      model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      sqlitePath,
    });
    try {
      expect(await second.checkpoints.load(result.runId)).toMatchObject({ runId: result.runId, status: 'completed' });
      expect(await second.evidence.get('runtime-evidence-1')).toMatchObject({ raw: { marker: 'runtime-private-evidence' } });
      expect(await second.eventStoreV2.currentSequence(result.runId)).toBeGreaterThan(0);
    } finally {
      await second.close();
    }
  });
});
