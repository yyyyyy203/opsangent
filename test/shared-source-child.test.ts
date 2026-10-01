import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { createSharedSourceChildAgentFactory } from '../src/bootstrap/shared-source-child.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import type { ChatModel, ModelCallOptions, ModelResponse, ModelStreamEvent, Tool } from '../src/index.js';

class ToolRecordingModel implements ChatModel {
  public readonly toolNames: string[][] = [];

  public async *stream(
    _messages: never[],
    tools: Tool[],
    _options: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    void _messages;
    void _options;
    await Promise.resolve();
    this.toolNames.push(tools.map((tool) => tool.name));
    yield* [];
    return { text: 'child complete', toolCalls: [] };
  }
}

describe('shared source child factory', () => {
  it('creates an isolated dry-run child with the exact tools and parent-owned stores', async () => {
    const model = new ToolRecordingModel();
    const parent = createInspectionRuntime({
      model: new ScriptedModel([{ text: 'parent', toolCalls: [] }]),
      workspaceRoots: [],
      allowedToolNames: [],
      includeExternalBash: false,
    });
    const factory = createSharedSourceChildAgentFactory({
      model,
      workspaceRoots: [],
      checkpoints: parent.checkpoints,
      evidence: parent.evidence,
      evidenceRecorder: parent.evidenceRecorder,
      sharedEvents: parent.sharedEvents,
    });
    const childTools: Tool[] = [
      {
        name: 'metrics.settlement',
        description: 'settlement evidence',
        kind: 'evidence',
        inputSchema: z.object({ service: z.string() }).strict(),
        call: () => Promise.resolve({ blocks: [{ type: 'text' as const, text: 'evidence' }] }),
      },
      {
        name: 'source_report',
        description: 'source report',
        kind: 'utility',
        inputSchema: z.object({}).strict(),
        call: () => Promise.resolve({ blocks: [{ type: 'json' as const, value: {} }] }),
      },
    ];

    try {
      const child = factory.create({
        childRunId: 'child-run',
        source: 'metrics',
        tools: childTools,
        maxToolCalls: 3,
        maxDurationMs: 5_000,
        profileId: 'simulation',
      });

      await drain(child.replyStream({
        runId: 'child-run',
        profileId: 'simulation',
        message: 'collect',
        signal: new AbortController().signal,
        maxToolCalls: 3,
        maxDurationMs: 5_000,
      }));

      expect(model.toolNames).toEqual([['metrics.settlement', 'source_report']]);
      expect(parent.toolkit.get('metrics.settlement')).toBeUndefined();
      expect(parent.toolkit.get('source_report')).toBeUndefined();
      expect(parent.toolkit.get('bash')).toBeUndefined();
      expect(await parent.checkpoints.load('child-run')).not.toBeNull();
      expect(await parent.eventStoreV2.readRun('child-run', 0, 20)).not.toHaveLength(0);
      expect('close' in child).toBe(false);
    } finally {
      await parent.close();
    }
  });
});

async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<unknown> {
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
