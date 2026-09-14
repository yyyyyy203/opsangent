import { describe, expect, it } from 'vitest';
import type {
  AgentContext,
  AgentMessage,
  CompressionValidationResult,
  StructuredHistorySummary,
} from '../src/contracts/index.js';
import { createInitialRunGovernanceState } from '../src/contracts/index.js';
import { RuleBasedContextCompressor } from '../src/context-compressor/rule-based-compressor.js';
import type { HistorySummarizer } from '../src/context-compressor/types.js';

const timestamp = '2026-09-14T00:00:00.000Z';

function context(): AgentContext {
  const messages: AgentMessage[] = Array.from({ length: 45 }, (_, index) => ({
    id: 'message-' + index,
    role: 'assistant' as const,
    createdAt: timestamp,
    blocks: [{ type: 'text' as const, text: 'history-' + index + '-' + 'x'.repeat(1_000) }],
  }));
  return {
    runId: 'run-1',
    status: 'running',
    stage: 'evidence_collection',
    profileId: 'group-buy-market',
    messages,
    pendingToolCalls: [],
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: [],
    missingEvidence: [],
    budget: {
      startedAt: timestamp,
      maxIterations: 8,
      iteration: 1,
      maxToolCalls: 32,
      toolCallsUsed: 0,
      maxDurationMs: 60_000,
    },
    contextVersion: 1,
    governance: createInitialRunGovernanceState({ profileId: 'group-buy-market', capturedAt: timestamp }),
  };
}

function summary(): StructuredHistorySummary {
  return {
    confirmedFacts: ['known fact'],
    hypotheses: ['known hypothesis'],
    missingEvidence: [],
    pendingActionIds: [],
    executedActionIds: [],
    unresolvedRisks: [],
    sourceMessageIds: Array.from({ length: 41 }, (_, index) => 'message-' + index),
    keyToolCalls: [],
    evidenceIds: [],
    confirmationIds: [],
    riskRuleIds: [],
    summaryVersion: 1,
  };
}

describe('RuleBasedContextCompressor layered behavior', () => {
  it('returns the validated L1 candidate when no compact model is configured', async () => {
    const original = context();
    const compressor = new RuleBasedContextCompressor({
      maxMessagesBeforeL1: 40,
      maxSerializedBytesBeforeL2: 10_000,
      keepRecentMessages: 4,
    });

    const result = await compressor.compress(original, {
      signal: new AbortController().signal,
      deadline: Date.parse(timestamp) + 60_000,
      now: () => new Date(timestamp),
    });

    expect(result.decision.level).toBe('L1');
    expect(result.validation).toMatchObject({ valid: true, status: 'valid' });
    expect(result.context.messages).not.toEqual(original.messages);
  });

  it('falls back to the validated L1 candidate when compact summarization fails', async () => {
    const summarizer: HistorySummarizer = {
      summarize: () => Promise.reject(new Error('compact model unavailable')),
    };
    const compressor = new RuleBasedContextCompressor({
      maxMessagesBeforeL1: 40,
      maxSerializedBytesBeforeL2: 10_000,
      keepRecentMessages: 4,
      summarizer,
    });

    const result = await compressor.compress(context(), {
      signal: new AbortController().signal,
      deadline: Date.parse(timestamp) + 60_000,
      now: () => new Date(timestamp),
    });

    expect(result.decision.level).toBe('L1');
    expect(result.validation).toMatchObject({ valid: true, status: 'summary_fallback' });
  });

  it('accepts a strictly validated L2 summary and updates compression state', async () => {
    const summarizer: HistorySummarizer = {
      summarize: () => Promise.resolve(summary()),
    };
    const compressor = new RuleBasedContextCompressor({
      maxMessagesBeforeL1: 40,
      maxSerializedBytesBeforeL2: 10_000,
      keepRecentMessages: 4,
      summarizer,
    });

    const result = await compressor.compress(context(), {
      signal: new AbortController().signal,
      deadline: Date.parse(timestamp) + 60_000,
      now: () => new Date(timestamp),
    });

    expect(result.decision.level).toBe('L2');
    expect(result.context.governance?.compression.lastLevel).toBe('L2');
    const summaryBlocks = result.context.messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'context_summary');
    expect(summaryBlocks.some((block) => block.summary.summaryVersion === 1)).toBe(true);
  });

  it('retains the original context when L1 validation fails', async () => {
    const invalid: CompressionValidationResult = {
      valid: false,
      status: 'failed',
      reasonCode: 'compression_size_exceeded',
    };
    const compressor = new RuleBasedContextCompressor({
      maxMessagesBeforeL1: 40,
      maxSerializedBytesBeforeL2: 10_000,
      keepRecentMessages: 4,
      validator: { validate: () => Promise.resolve(invalid) },
    });
    const original = context();

    const result = await compressor.compress(original, {
      signal: new AbortController().signal,
      deadline: Date.parse(timestamp) + 60_000,
      now: () => new Date(timestamp),
    });

    expect(result.decision.level).toBe('none');
    expect(result.context).toBe(original);
    expect(result.validation).toEqual(invalid);
  });
});
