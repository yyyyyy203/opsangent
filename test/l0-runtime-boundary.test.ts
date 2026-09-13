import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  ChatModel,
  EvidenceBlobStore,
  EvidenceManifestStore,
  ModelResponse,
  ModelStreamEvent,
  Tool,
} from '../src/contracts/index.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { DefaultToolResultCompactor } from '../src/context-compressor/tool-result-compactor.js';
import { DefaultStreamingEvidenceRecorder } from '../src/application/streaming-evidence-recorder.js';

describe('L0 runtime boundary', () => {
  it('exposes injected L0 ports without coupling the Harness to a Blob implementation', () => {
    const blobStore = {} as EvidenceBlobStore;
    const manifests = {} as EvidenceManifestStore;
    const runtime = createAgentRuntime({
      model: idleModel(),
      workspaceRoots: [],
      l0: { blobStore, manifests },
    });

    expect(runtime.evidenceBlobs).toBe(blobStore);
    expect(runtime.evidenceManifests).toBe(manifests);
    expect(runtime.streamingEvidenceRecorder).toBeInstanceOf(DefaultStreamingEvidenceRecorder);
    expect(runtime.toolResultCompactor).toBeDefined();
  });

  it('passes a bounded model view while preserving the durable context result', async () => {
    let calls = 0;
    let observedMessages: Parameters<ChatModel['stream']>[0] | undefined;
    const model: ChatModel = {
      async *stream(messages): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        await Promise.resolve();
        yield* [] as ModelStreamEvent[];
        if (calls === 0) {
          calls += 1;
          return { toolCalls: [{ id: 'logs-1', name: 'logs.capture', input: {} }] };
        }
        observedMessages = messages;
        return { text: 'done', toolCalls: [] };
      },
    };
    const tool: Tool = {
      name: 'logs.capture',
      description: 'capture logs',
      kind: 'evidence',
      inputSchema: z.object({}),
      isConcurrencySafe: () => true,
      call: () => ({
        blocks: [
          { type: 'text', text: 'raw-log-marker-' + 'x'.repeat(20_000) },
          { type: 'evidence_ref', evidenceId: 'evidence-1' },
        ],
        evidenceIds: ['evidence-1'],
      }),
    };
    const runtime = createAgentRuntime({
      model,
      workspaceRoots: [],
      tools: [tool],
      l0: { toolResultCompactor: new DefaultToolResultCompactor({ maxBytes: 1024 }) },
    });

    await runtime.agent.reply({ message: 'inspect', profileId: 'group-buy-market', runId: 'run-1' });
    const toolResult = observedMessages?.flatMap((message) => message.blocks).find((block) => block.type === 'tool_result');
    expect(toolResult?.type).toBe('tool_result');
    if (toolResult?.type !== 'tool_result') throw new Error('Missing tool result in model view');
    expect(JSON.stringify(toolResult.result.response)).not.toContain('raw-log-marker');
    expect(toolResult.result.response?.evidenceIds).toEqual(['evidence-1']);

    const durable = (await runtime.checkpoints.load('run-1'))?.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'tool_result');
    expect(durable?.type).toBe('tool_result');
    if (durable?.type !== 'tool_result') throw new Error('Missing durable tool result');
    expect(JSON.stringify(durable.result.response)).toContain('raw-log-marker');
  });

  it('creates SQLite Blob storage only from an explicit absolute root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-l0-runtime-'));
    try {
      const withBlob = createAgentRuntime({
        model: idleModel(),
        workspaceRoots: [],
        sqlitePath: join(root, 'with-blob.sqlite'),
        evidenceBlobRootPath: join(root, 'blobs'),
      });
      expect(withBlob.evidenceBlobs).toBeDefined();
      expect(withBlob.streamingEvidenceRecorder).toBeInstanceOf(DefaultStreamingEvidenceRecorder);
      await withBlob.close();

      const withoutBlob = createAgentRuntime({
        model: idleModel(),
        workspaceRoots: [],
        sqlitePath: join(root, 'without-blob.sqlite'),
      });
      expect(withoutBlob.evidenceBlobs).toBeUndefined();
      expect(withoutBlob.streamingEvidenceRecorder).toBeUndefined();
      await withoutBlob.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function idleModel(): ChatModel {
  return {
    async *stream(): AsyncGenerator<ModelStreamEvent, ModelResponse> {
      await Promise.resolve();
      yield* [] as ModelStreamEvent[];
      return { text: 'idle', toolCalls: [] };
    },
  };
}
