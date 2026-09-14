import { describe, expect, it } from 'vitest';
import type {
  AgentContext,
  AgentMessage,
  ChatModel,
  HistorySummaryInput,
  ModelCallOptions,
  ModelResponse,
  ModelStreamEvent,
  Tool,
} from '../src/contracts/index.js';
import { ModelHistorySummarizer } from '../src/context-compressor/history-summarizer.js';

const timestamp = '2026-09-14T00:00:00.000Z';

function validSummary(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    confirmedFacts: ['failure rate exceeded threshold'],
    hypotheses: ['settlement dependency is degraded'],
    missingEvidence: ['trace'],
    pendingActionIds: [],
    executedActionIds: ['call-1'],
    unresolvedRisks: [],
    sourceMessageIds: ['message-1'],
    keyToolCalls: ['call-1'],
    evidenceIds: ['evidence-1'],
    confirmationIds: [],
    riskRuleIds: [],
    summaryVersion: 1,
    ...overrides,
  });
}

class RecordingSummaryModel implements ChatModel {
  public readonly calls: Array<{ messages: AgentMessage[]; tools: Tool[]; options: ModelCallOptions }> = [];
  private index = 0;

  public constructor(private readonly responses: readonly string[]) {}

  public async *stream(
    messages: AgentMessage[],
    tools: Tool[],
    options: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    await Promise.resolve();
    this.calls.push({ messages, tools, options });
    const response = this.responses[this.index];
    this.index += 1;
    if (response === undefined) throw new Error('no scripted summary response');
    yield { type: 'text_delta', delta: response };
    return { text: response, toolCalls: [] };
  }
}

function input(): HistorySummaryInput {
  const context: AgentContext = {
    runId: 'run-1',
    status: 'running',
    stage: 'evidence_collection',
    profileId: 'group-buy-market',
    messages: [],
    pendingToolCalls: [],
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: ['evidence-1'],
    missingEvidence: [],
    budget: {
      startedAt: timestamp,
      maxIterations: 8,
      iteration: 1,
      maxToolCalls: 16,
      toolCallsUsed: 1,
      maxDurationMs: 60_000,
    },
    contextVersion: 1,
  };
  return {
    runId: 'run-1',
    context,
    sourceMessageIds: ['message-1'],
    messages: [{ id: 'message-1', role: 'tool', createdAt: timestamp, blocks: [{ type: 'text', text: 'untrusted log text' }] }],
    allowedMessageIds: ['message-1'],
    allowedToolCallIds: ['call-1'],
    allowedEvidenceIds: ['evidence-1'],
    allowedConfirmationIds: [],
    allowedRiskRuleIds: [],
  };
}

function options() {
  return {
    signal: new AbortController().signal,
    deadline: Date.parse(timestamp) + 60_000,
  };
}

describe('ModelHistorySummarizer', () => {
  it('parses strict JSON, marks history untrusted, and sends no tools', async () => {
    const model = new RecordingSummaryModel([validSummary()]);
    const summarizer = new ModelHistorySummarizer({
      model,
      clock: { now: () => new Date(timestamp) },
    });

    const result = await summarizer.summarize(input(), options());

    expect(result.evidenceIds).toEqual(['evidence-1']);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.tools).toEqual([]);
    expect(model.calls[0]?.messages[0]?.blocks[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(model.calls[0]?.messages)).toContain('untrusted log text');
  });

  it('accepts a fenced JSON response after extracting the object', async () => {
    const model = new RecordingSummaryModel(['Here is the result:\n~~~json\n' + validSummary() + '\n~~~']);
    const summarizer = new ModelHistorySummarizer({
      model,
      clock: { now: () => new Date(timestamp) },
    });

    await expect(summarizer.summarize(input(), options())).resolves.toMatchObject({ summaryVersion: 1 });
  });

  it('retries once after invalid JSON and accepts the next valid summary', async () => {
    const model = new RecordingSummaryModel(['not json', validSummary()]);
    const summarizer = new ModelHistorySummarizer({
      model,
      clock: { now: () => new Date(timestamp) },
    });

    await expect(summarizer.summarize(input(), options())).resolves.toMatchObject({ summaryVersion: 1 });
    expect(model.calls).toHaveLength(2);
  });

  it('rejects IDs that are not present in the input allowlist', async () => {
    const model = new RecordingSummaryModel([
      validSummary({ evidenceIds: ['evidence-not-in-history'] }),
      validSummary({ evidenceIds: ['evidence-not-in-history'] }),
    ]);
    const summarizer = new ModelHistorySummarizer({
      model,
      clock: { now: () => new Date(timestamp) },
    });

    await expect(summarizer.summarize(input(), options())).rejects.toMatchObject({
      code: 'COMPRESSION_SUMMARY_INVALID',
    });
    expect(model.calls).toHaveLength(2);
  });

  it('does not retry after abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new RecordingSummaryModel([validSummary()]);
    const summarizer = new ModelHistorySummarizer({
      model,
      clock: { now: () => new Date(timestamp) },
    });

    await expect(summarizer.summarize(input(), { signal: controller.signal, deadline: Date.now() + 1000 }))
      .rejects.toMatchObject({ code: 'ABORTED' });
    expect(model.calls).toHaveLength(0);
  });
});
