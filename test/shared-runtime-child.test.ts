import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type { Clock, IdGenerator, Tool } from '../src/contracts/index.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const clock: Clock = { now: () => new Date('2026-10-01T00:00:00.000Z') };
let idSequence = 0;
const ids: IdGenerator = { next: (prefix) => `${prefix}-deterministic-${idSequence += 1}` };
const roots: string[] = [];

afterEach(async () => {
  idSequence = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('shared runtime data plane', () => {
  it('shares the parent V2 event and evidence ports while keeping child toolkits isolated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-shared-runtime-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const childTool: Tool = {
      name: 'metrics.settlement',
      description: 'settlement evidence',
      kind: 'evidence',
      inputSchema: z.object({ service: z.string() }),
      call: () => Promise.resolve({ blocks: [{ type: 'text' as const, text: 'evidence' }] }),
    };
    const parent = createAgentRuntime({
      model: new ScriptedModel([{ text: 'parent complete', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      sqlitePath,
      clock,
      ids,
    });
    const child = createAgentRuntime({
      model: new ScriptedModel([{ text: 'child complete', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      checkpoints: parent.checkpoints,
      evidence: parent.evidence,
      evidenceRecorder: parent.evidenceRecorder,
      tools: [childTool],
      sharedEvents: parent.sharedEvents,
      clock,
      ids,
    });

    try {
      expect(parent.eventStoreV2).toBe(parent.sharedEvents.store);
      expect(parent.eventStoreV2).toBe(child.eventStoreV2);
      expect(parent.toolkit.get('metrics.settlement')).toBeUndefined();
      expect(child.toolkit.get('metrics.settlement')).toBeDefined();

      const result = await child.agent.reply({ runId: 'child-run', message: 'collect', profileId: 'simulation' });
      const events = await parent.eventStoreV2.readRun(result.runId, 0, 20);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.runId === result.runId)).toBe(true);

      const messages = await parent.eventStoreV2.listMessagesByRun(result.runId);
      expect(messages).toHaveLength(1);
      expect(new Set(messages.map((item) => item.message.id)).size).toBe(messages.length);
    } finally {
      await child.close();
      await parent.close();
    }
  });
});
