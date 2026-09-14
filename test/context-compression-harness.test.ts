import { describe, expect, it } from 'vitest';
import type {
  AgentContext,
  AgentEvent,
  ChatModel,
  ModelResponse,
  ToolExecutionResult,
} from '../src/contracts/index.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type { CompressionResult, ContextCompressor } from '../src/context-compressor/types.js';

const timestamp = '2026-09-14T00:00:00.000Z';

class ScriptedCompression implements ContextCompressor {
  public calls = 0;

  public constructor(private readonly build: (context: AgentContext) => CompressionResult) {}

  public compress(context: AgentContext): Promise<CompressionResult> {
    this.calls += 1;
    return Promise.resolve(this.build(context));
  }

  public pruneToolResult(result: ToolExecutionResult): Promise<ToolExecutionResult> {
    return Promise.resolve(result);
  }
}

function oneShotModel(): ChatModel {
  const response: ModelResponse = { text: 'done', toolCalls: [] };
  return {
    async *stream() {
      await Promise.resolve();
      yield { type: 'text_delta' as const, delta: 'done' };
      return response;
    },
  };
}

function compressedContext(context: AgentContext): AgentContext {
  const governance = context.governance;
  return {
    ...context,
    messages: [...context.messages, {
      id: 'compression-summary-1',
      role: 'assistant',
      createdAt: timestamp,
      blocks: [{
        type: 'context_summary',
        summary: {
          confirmedFacts: ['failure rate is elevated'],
          hypotheses: [],
          missingEvidence: [],
          pendingActionIds: [],
          executedActionIds: [],
          unresolvedRisks: [],
          sourceMessageIds: context.messages.map((message) => message.id),
          keyToolCalls: [],
          evidenceIds: [],
          confirmationIds: [],
          riskRuleIds: [],
          summaryVersion: 1,
        },
      }],
    }],
    contextVersion: context.contextVersion + 1,
    ...(governance === undefined ? {} : { governance: {
      ...governance,
      compression: {
        ...governance.compression,
        summaryVersion: 1,
        lastLevel: 'L1',
        sourceMessageIds: context.messages.map((message) => message.id),
        protectedMessageIds: [],
        offloadedEvidenceIds: [],
        lastCompressedAt: timestamp,
      },
    } }),
  };
}

function compressionResult(context: AgentContext, overrides: Partial<CompressionResult> = {}): CompressionResult {
  return {
    context: compressedContext(context),
    decision: { level: 'L1', reason: 'message_count' },
    trace: {
      sourceMessageIds: context.messages.map((message) => message.id),
      protectedMessageIds: [],
      keyToolCalls: [],
      evidenceIds: [],
      summaryVersion: 1,
      beforeBytes: 200,
      afterBytes: 100,
      savedBytes: 100,
      offloadedEvidenceIds: [],
    },
    validation: { valid: true, status: 'valid' },
    ...overrides,
  };
}

async function runWith(compressor: ContextCompressor, runId: string) {
  const runtime = createAgentRuntime({
    model: oneShotModel(),
    workspaceRoots: [],
    compressor,
    clock: { now: () => new Date(timestamp) },
    ids: (() => {
      let sequence = 0;
      return { next: (prefix: string) => `${prefix}-${++sequence}` };
    })(),
  });
  const legacyEvents: AgentEvent[] = [];
  runtime.events.subscribe((event) => { legacyEvents.push(event); });
  const result = await runtime.agent.reply({ runId, message: 'inspect', profileId: 'settlement' });
  const events = await runtime.eventStoreV2.readRun(runId, 0, 100);
  return { runtime, result, events, legacyEvents };
}

describe('Agent Harness context compression lifecycle', () => {
  it('commits the candidate before publishing ordered compression lifecycle facts', async () => {
    const compressor = new ScriptedCompression((context) => compressionResult(context));
    const { runtime, result, events, legacyEvents } = await runWith(compressor, 'compression-run');
    const types = events.map((event) => event.type);
    const started = types.indexOf('CONTEXT_COMPRESSION_STARTED');
    const completed = types.indexOf('CONTEXT_COMPRESSED');
    const step = types.indexOf('STEP_STARTED');

    expect(result.status).toBe('completed');
    expect(started).toBeGreaterThan(-1);
    expect(completed).toBeGreaterThan(started);
    expect(step).toBeGreaterThan(completed);
    const v2Completed = events.find((event) => event.type === 'CONTEXT_COMPRESSED');
    const legacyCompleted = legacyEvents.find((event) => event.type === 'CONTEXT_COMPRESSED');
    expect(legacyCompleted?.payload).toEqual(v2Completed?.payload);
    expect((await runtime.checkpoints.load('compression-run'))?.governance?.compression.lastLevel).toBe('L1');
  });

  it('retains the previous context when validation fails and emits a failure fact', async () => {
    const compressor = new ScriptedCompression((context) => compressionResult(context, {
      context,
      decision: { level: 'none', reason: 'compression_validation_failed' },
      validation: { valid: false, status: 'failed', reasonCode: 'missing_summary_tool_call' },
    }));
    const { runtime, result, events } = await runWith(compressor, 'compression-failed-run');
    const types = events.map((event) => event.type);

    expect(result.status).toBe('completed');
    expect(types).toContain('CONTEXT_COMPRESSION_STARTED');
    expect(types).toContain('CONTEXT_COMPRESSION_FAILED');
    expect(types).not.toContain('CONTEXT_COMPRESSED');
    expect((await runtime.checkpoints.load('compression-failed-run'))?.governance?.compression.lastLevel).toBe('none');
  });

  it('records L2 fallback and still publishes the accepted L1 candidate', async () => {
    const compressor = new ScriptedCompression((context) => compressionResult(context, {
      decision: { level: 'L1', reason: 'l2_summary_failed' },
      validation: { valid: true, status: 'summary_fallback', reasonCode: 'compression_summary_model_failed' },
    }));
    const { events } = await runWith(compressor, 'compression-fallback-run');
    const types = events.map((event) => event.type);

    expect(types).toContain('CONTEXT_COMPRESSION_STARTED');
    expect(types).toContain('CONTEXT_COMPRESSION_FAILED');
    expect(types).toContain('CONTEXT_COMPRESSED');
    expect(events.find((event) => event.type === 'CONTEXT_COMPRESSION_FAILED')?.payload).toMatchObject({
      level: 'L2', fallbackPolicy: 'defer',
    });
    expect(events.find((event) => event.type === 'CONTEXT_COMPRESSED')?.payload).toMatchObject({ level: 'L1' });
  });

  it('publishes an integrity repair fact when the validator restores an exact result', async () => {
    const compressor = new ScriptedCompression((context) => compressionResult(context, {
      validation: {
        valid: true,
        status: 'repaired',
        repairType: 'restore_tool_result',
        affectedIds: ['tool-call-1'],
      },
    }));
    const { events } = await runWith(compressor, 'compression-repaired-run');

    expect(events.map((event) => event.type)).toContain('CONTEXT_INTEGRITY_REPAIRED');
    expect(events.find((event) => event.type === 'CONTEXT_INTEGRITY_REPAIRED')?.payload).toEqual({
      repairType: 'restore_tool_result',
      affectedIds: ['tool-call-1'],
      validationResult: 'valid',
    });
  });
});
