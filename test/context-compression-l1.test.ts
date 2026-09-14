import { describe, expect, it } from 'vitest';
import type { AgentContext, AgentMessage, ToolCall, ToolExecutionResult } from '../src/contracts/index.js';
import { createInitialRunGovernanceState } from '../src/contracts/index.js';
import { L1StructurePruner } from '../src/context-compressor/l1-structure-pruner.js';

const timestamp = '2026-09-14T00:00:00.000Z';

function textMessage(id: string, text: string): AgentMessage {
  return { id, role: 'assistant', createdAt: timestamp, blocks: [{ type: 'text', text }] };
}

function toolPair(callId: string, index: number): AgentMessage[] {
  const call: ToolCall = { id: callId, name: 'metrics.query', input: { index } };
  const result: ToolExecutionResult = {
    toolCallId: callId,
    toolName: call.name,
    status: 'success',
    response: { blocks: [{ type: 'json', value: { index } }] },
    startedAt: timestamp,
    finishedAt: timestamp,
  };
  return [
    { id: 'message-call-' + callId, role: 'assistant', createdAt: timestamp, blocks: [{ type: 'tool_call', call }] },
    { id: 'message-result-' + callId, role: 'tool', createdAt: timestamp, blocks: [{ type: 'tool_result', result }] },
  ];
}

function context(messages: AgentMessage[], pendingToolCalls: ToolCall[] = []): AgentContext {
  return {
    runId: 'run-1',
    status: 'running',
    stage: 'evidence_collection',
    profileId: 'group-buy-market',
    messages,
    pendingToolCalls,
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: [],
    missingEvidence: [],
    budget: {
      startedAt: timestamp,
      maxIterations: 8,
      iteration: 1,
      maxToolCalls: 64,
      toolCallsUsed: 0,
      maxDurationMs: 60_000,
    },
    contextVersion: 1,
    governance: createInitialRunGovernanceState({ profileId: 'group-buy-market', capturedAt: timestamp }),
  };
}

function visibleToolCallIds(value: AgentContext): string[] {
  return value.messages.flatMap((message) => message.blocks.flatMap((block) => (
    block.type === 'tool_call' || block.type === 'raw_tool_call' ? [block.call.id] : []
  )));
}

function visibleToolResultIds(value: AgentContext): string[] {
  return value.messages.flatMap((message) => message.blocks.flatMap((block) => (
    block.type === 'tool_result' ? [block.result.toolCallId] : []
  )));
}

function summaryCallIds(value: AgentContext): string[] {
  return value.messages.flatMap((message) => message.blocks.flatMap((block) => (
    block.type === 'context_summary' ? block.summary.keyToolCalls ?? [] : []
  )));
}

describe('L1StructurePruner', () => {
  it('summarizes complete historical exchanges without orphaning a tool call', () => {
    const oldPair = toolPair('call-old', 0);
    const recent = Array.from({ length: 40 }, (_, index) => textMessage('recent-' + index, 'recent-' + index));
    const before = context([...oldPair, ...recent]);

    const candidate = new L1StructurePruner().prune({
      context: before,
      keepRecentMessages: 4,
      maxMessages: 8,
      now: () => new Date(timestamp),
    });

    expect(visibleToolCallIds(candidate.context)).not.toContain('call-old');
    expect(summaryCallIds(candidate.context)).toContain('call-old');
    expect(visibleToolCallIds(candidate.context).filter((id) => !visibleToolResultIds(candidate.context).includes(id))).toEqual([]);
    expect(candidate.sourceMessageIds).toContain('message-call-call-old');
    expect(candidate.sourceMessageIds).toContain('message-result-call-old');
    expect(candidate.context.messages.length).toBeLessThanOrEqual(8);
    expect(before.messages).toHaveLength(42);
    expect(before.contextVersion).toBe(1);
  });

  it('keeps an unpaired pending call visible and records it as protected', () => {
    const pending: ToolCall = { id: 'call-pending', name: 'logs.search_evidence', input: { query: 'timeout' } };
    const before = context(
      [
        textMessage('old-1', 'old'),
        { id: 'message-call-pending', role: 'assistant', createdAt: timestamp, blocks: [{ type: 'tool_call', call: pending }] },
        ...Array.from({ length: 40 }, (_, index) => textMessage('recent-' + index, 'recent')),
      ],
      [pending],
    );

    const candidate = new L1StructurePruner().prune({
      context: before,
      keepRecentMessages: 4,
      maxMessages: 8,
      now: () => new Date(timestamp),
    });

    expect(visibleToolCallIds(candidate.context)).toContain('call-pending');
    expect(candidate.protectedMessageIds).toContain('old-1');
    expect(candidate.context.pendingToolCalls).toEqual([pending]);
  });

  it('preserves evidence IDs and advances the immutable compression state', () => {
    const before = context(Array.from({ length: 40 }, (_, index) => textMessage('message-' + index, 'history')));
    before.evidenceIds = ['evidence-1'];
    before.missingEvidence = ['traces'];

    const candidate = new L1StructurePruner().prune({
      context: before,
      keepRecentMessages: 4,
      maxMessages: 8,
      now: () => new Date(timestamp),
    });

    expect(candidate.evidenceIds).toEqual(['evidence-1']);
    expect(candidate.context.governance?.compression.lastLevel).toBe('L1');
    expect(candidate.context.governance?.compression.summaryVersion).toBe(1);
    expect(candidate.context.governance?.compression.sourceMessageIds).toEqual(candidate.sourceMessageIds);
    expect(candidate.context).not.toBe(before);
    expect(before.governance?.compression.summaryVersion).toBe(0);
  });
});
