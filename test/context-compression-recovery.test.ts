import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentContext } from '../src/contracts/index.js';
import { createInitialRunGovernanceState } from '../src/contracts/index.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { createSqlitePersistence } from '../src/infrastructure/sqlite/persistence-bundle.js';
import { RuleBasedContextCompressor } from '../src/context-compressor/rule-based-compressor.js';
import type { CompressionOptions, CompressionResult, ContextCompressor } from '../src/context-compressor/types.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const timestamp = '2026-09-14T00:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class CountingCompressor implements ContextCompressor {
  public calls = 0;

  public constructor(private readonly delegate: ContextCompressor) {}

  public compress(context: AgentContext, options?: CompressionOptions): Promise<CompressionResult> {
    this.calls += 1;
    return this.delegate.compress(context, options);
  }

  public pruneToolResult(result: Parameters<ContextCompressor['pruneToolResult']>[0]): ReturnType<ContextCompressor['pruneToolResult']> {
    return this.delegate.pruneToolResult(result);
  }
}

function seededContext(runId: string): AgentContext {
  return {
    runId,
    status: 'running',
    stage: 'evidence_collection',
    profileId: 'group-buy-market',
    messages: Array.from({ length: 45 }, (_, index) => ({
      id: 'history-' + index,
      role: 'assistant' as const,
      createdAt: timestamp,
      blocks: [{ type: 'text' as const, text: 'historical observation ' + index }],
    })),
    pendingToolCalls: [],
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: [],
    missingEvidence: [],
    budget: {
      startedAt: timestamp,
      maxIterations: 4,
      iteration: 0,
      maxToolCalls: 16,
      toolCallsUsed: 0,
      maxDurationMs: 60_000,
    },
    contextVersion: 1,
    governance: createInitialRunGovernanceState({ profileId: 'group-buy-market', capturedAt: timestamp }),
  };
}

async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  while (!(await stream.next()).done) { /* drain */ }
}

describe('context compression restart recovery', () => {
  it('persists CompressionState and does not summarize the same source range after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-compression-recovery-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const runId = 'compression-recovery-run';
    const seed = createSqlitePersistence({
      path: sqlitePath,
      clock: { now: () => new Date(timestamp) },
    });
    await seed.checkpoints.save(seededContext(runId), null);
    seed.close();

    const compressor = new CountingCompressor(new RuleBasedContextCompressor({
      maxMessagesBeforeL1: 40,
      maxSerializedBytesBeforeL2: 256_000,
      keepRecentMessages: 16,
    }));
    const first = createAgentRuntime({
      model: new ScriptedModel([{ text: 'first resume complete', toolCalls: [] }]),
      workspaceRoots: [],
      sqlitePath,
      compressor,
      clock: { now: () => new Date(timestamp) },
    });
    await drain(first.agent.resumeStream(runId));
    const firstCheckpoint = await first.checkpoints.load(runId);
    const firstEvents = await first.eventStoreV2.readRun(runId, 0, 500);
    await first.close?.();

    expect(firstCheckpoint?.governance?.compression.lastLevel).toBe('L1');
    expect(firstCheckpoint?.governance?.compression.summaryVersion).toBe(1);
    expect(firstCheckpoint?.messages.filter((message) => message.blocks.some((block) => block.type === 'context_summary'))).toHaveLength(1);
    expect(firstEvents.filter((event) => event.type === 'CONTEXT_COMPRESSED')).toHaveLength(1);

    const second = createAgentRuntime({
      model: new ScriptedModel([{ text: 'second resume complete', toolCalls: [] }]),
      workspaceRoots: [],
      sqlitePath,
      compressor,
      clock: { now: () => new Date(timestamp) },
    });
    await drain(second.agent.resumeStream(runId));
    const secondCheckpoint = await second.checkpoints.load(runId);
    const secondEvents = await second.eventStoreV2.readRun(runId, 0, 1_000);
    await second.close?.();

    expect(compressor.calls).toBe(2);
    expect(secondCheckpoint?.governance?.compression.summaryVersion).toBe(1);
    expect(secondCheckpoint?.messages.filter((message) => message.blocks.some((block) => block.type === 'context_summary'))).toHaveLength(1);
    expect(secondEvents.filter((event) => event.type === 'CONTEXT_COMPRESSION_STARTED')).toHaveLength(1);
    expect(secondEvents.filter((event) => event.type === 'CONTEXT_COMPRESSED')).toHaveLength(1);
  });
});
