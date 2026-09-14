import type {
  AgentContext,
  AgentMessage,
  ContextSummary,
  ToolCall,
} from '../contracts/index.js';
import { checkpointChecksum } from '../contracts/stable-json.js';

export interface L1StructurePruneInput {
  context: AgentContext;
  keepRecentMessages: number;
  maxMessages: number;
  now: () => Date;
}

export interface CompressionCandidate {
  context: AgentContext;
  sourceMessageIds: string[];
  protectedMessageIds: string[];
  keyToolCalls: string[];
  evidenceIds: string[];
  summaryVersion: number;
}

interface IndexedCall {
  id: string;
  messageIndices: number[];
}

export class L1StructurePruner {
  public prune(input: L1StructurePruneInput): CompressionCandidate {
    const { context } = input;
    const messages = context.messages;
    const existingSummary = collectSummary(context);
    const summaryVersion = (context.governance?.compression.summaryVersion ?? 0) + 1;
    const callIndex = indexCalls(messages);
    const resultIndex = indexResults(messages);
    const pendingCallIds = new Set([
      ...context.pendingToolCalls.map((call) => call.id),
      ...(context.pendingToolBatch?.calls.map((call) => call.id) ?? []),
      ...(context.pendingInterrupt?.toolCallId === undefined ? [] : [context.pendingInterrupt.toolCallId]),
    ]);
    const protectedIndices = new Set<number>();

    const firstMessage = messages.at(0);
    if (
      firstMessage !== undefined
      && callsInMessage(firstMessage).length === 0
      && resultCallIdsInMessage(firstMessage).length === 0
    ) {
      protectedIndices.add(0);
    }
    for (const [index, message] of messages.entries()) {
      if (message.role === 'system' || message.role === 'user') protectedIndices.add(index);
      if (message.blocks.some((block) => block.type === 'context_summary')) protectedIndices.add(index);
      for (const call of callsInMessage(message)) {
        const isPending = pendingCallIds.has(call.id);
        const isUnpaired = !resultIndex.has(call.id);
        if (isPending || isUnpaired) protectedIndices.add(index);
      }
      for (const callId of resultCallIdsInMessage(message)) {
        if (pendingCallIds.has(callId) || !callIndex.has(callId)) protectedIndices.add(index);
      }
    }

    const selectedIndices = new Set<number>(protectedIndices);
    const recentStart = Math.max(0, messages.length - Math.max(0, input.keepRecentMessages));
    for (let index = recentStart; index < messages.length; index += 1) selectedIndices.add(index);
    closeToolPairs(selectedIndices, callIndex, resultIndex);

    const removedIndices = messages
      .map((_, index) => index)
      .filter((index) => !selectedIndices.has(index));
    if (removedIndices.length === 0) {
      return {
        context,
        sourceMessageIds: [],
        protectedMessageIds: [...protectedIndices].map((index) => requireMessage(messages, index).id),
        keyToolCalls: [],
        evidenceIds: existingSummary.evidenceIds ?? [],
        summaryVersion: context.governance?.compression.summaryVersion ?? 0,
      };
    }

    const removedMessageIds = removedIndices.map((index) => requireMessage(messages, index).id);
    const removedCallIds = uniqueInOrder(removedIndices.flatMap((index) => (
      callsInMessage(requireMessage(messages, index)).map((call) => call.id)
    )));
    const keyToolCalls = uniqueInOrder([
      ...removedCallIds,
      ...removedIndices.flatMap((index) => resultCallIdsInMessage(requireMessage(messages, index))),
    ]);
    const summary: ContextSummary = {
      confirmedFacts: existingSummary.confirmedFacts,
      hypotheses: existingSummary.hypotheses,
      missingEvidence: uniqueInOrder([...existingSummary.missingEvidence, ...context.missingEvidence]),
      pendingActionIds: uniqueInOrder([
        ...existingSummary.pendingActionIds,
        ...context.pendingToolCalls.map((call) => call.id),
        ...(context.pendingToolBatch?.calls.map((call) => call.id) ?? []),
      ]),
      executedActionIds: uniqueInOrder([
        ...existingSummary.executedActionIds,
        ...context.executedActions.map((result) => result.toolCallId),
      ]),
      unresolvedRisks: uniqueInOrder([
        ...existingSummary.unresolvedRisks,
        ...(context.pendingInterrupt === undefined ? [] : ['pending_interrupt:' + context.pendingInterrupt.interruptType]),
      ]),
      sourceMessageIds: removedMessageIds,
      keyToolCalls,
      evidenceIds: existingSummary.evidenceIds ?? [],
      confirmationIds: existingSummary.confirmationIds ?? [],
      riskRuleIds: existingSummary.riskRuleIds ?? [],
      summaryVersion,
    };
    const firstRemoved = removedIndices.at(0);
    if (firstRemoved === undefined) throw new Error('Compression candidate has no removed messages');
    const summaryMessage: AgentMessage = {
      id: summaryMessageId(context, removedMessageIds, summaryVersion),
      role: 'assistant',
      createdAt: requireMessage(messages, firstRemoved).createdAt,
      blocks: [{ type: 'context_summary', summary }],
    };
    const candidateMessages = messages.flatMap((message, index) => {
      if (index === firstRemoved) return [summaryMessage];
      return selectedIndices.has(index) ? [message] : [];
    });
    const compression = {
      summaryVersion,
      lastLevel: 'L1' as const,
      sourceMessageIds: removedMessageIds,
      protectedMessageIds: [...protectedIndices].map((index) => requireMessage(messages, index).id),
      offloadedEvidenceIds: existingSummary.evidenceIds ?? [],
      lastCompressedAt: input.now().toISOString(),
    };
    const candidateGovernance = context.governance === undefined
      ? undefined
      : { ...context.governance, compression };

    return {
      context: {
        ...context,
        messages: candidateMessages,
        contextVersion: context.contextVersion + 1,
        ...(candidateGovernance === undefined ? {} : { governance: candidateGovernance }),
      },
      sourceMessageIds: removedMessageIds,
      protectedMessageIds: compression.protectedMessageIds,
      keyToolCalls,
      evidenceIds: existingSummary.evidenceIds ?? [],
      summaryVersion,
    };
  }
}

function indexCalls(messages: readonly AgentMessage[]): Map<string, IndexedCall> {
  const index = new Map<string, IndexedCall>();
  messages.forEach((message, messageIndex) => {
    for (const call of callsInMessage(message)) {
      const current = index.get(call.id);
      if (current === undefined) {
        index.set(call.id, { id: call.id, messageIndices: [messageIndex] });
      } else {
        current.messageIndices.push(messageIndex);
      }
    }
  });
  return index;
}

function indexResults(messages: readonly AgentMessage[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  messages.forEach((message, messageIndex) => {
    for (const callId of resultCallIdsInMessage(message)) {
      const current = index.get(callId) ?? [];
      current.push(messageIndex);
      index.set(callId, current);
    }
  });
  return index;
}

function closeToolPairs(
  selectedIndices: Set<number>,
  calls: Map<string, IndexedCall>,
  results: Map<string, number[]>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [callId, indexed] of calls) {
      const related = [...indexed.messageIndices, ...(results.get(callId) ?? [])];
      if (!related.some((index) => selectedIndices.has(index))) continue;
      for (const index of related) {
        if (selectedIndices.has(index)) continue;
        selectedIndices.add(index);
        changed = true;
      }
    }
  }
}

function callsInMessage(message: AgentMessage): ToolCall[] {
  return message.blocks.flatMap((block) => (
    block.type === 'tool_call' ? [block.call] : []
  ));
}

function resultCallIdsInMessage(message: AgentMessage): string[] {
  return message.blocks.flatMap((block) => (
    block.type === 'tool_result' ? [block.result.toolCallId] : []
  ));
}

function collectSummary(context: AgentContext): ContextSummary {
  const summaries = context.messages.flatMap((message) => message.blocks.flatMap((block) => (
    block.type === 'context_summary' ? [block.summary] : []
  )));
  return {
    confirmedFacts: uniqueInOrder(summaries.flatMap((summary) => summary.confirmedFacts)),
    hypotheses: uniqueInOrder(summaries.flatMap((summary) => summary.hypotheses)),
    missingEvidence: uniqueInOrder(summaries.flatMap((summary) => summary.missingEvidence)),
    pendingActionIds: uniqueInOrder(summaries.flatMap((summary) => summary.pendingActionIds)),
    executedActionIds: uniqueInOrder(summaries.flatMap((summary) => summary.executedActionIds)),
    unresolvedRisks: uniqueInOrder(summaries.flatMap((summary) => summary.unresolvedRisks)),
    sourceMessageIds: uniqueInOrder(summaries.flatMap((summary) => summary.sourceMessageIds ?? [])),
    keyToolCalls: uniqueInOrder(summaries.flatMap((summary) => summary.keyToolCalls ?? [])),
    evidenceIds: uniqueInOrder([
      ...context.evidenceIds,
      ...summaries.flatMap((summary) => summary.evidenceIds ?? []),
      ...context.messages.flatMap((message) => message.blocks.flatMap((block) => (
        block.type === 'tool_result' ? block.result.response?.evidenceIds ?? [] : []
      ))),
    ]),
    confirmationIds: uniqueInOrder(summaries.flatMap((summary) => summary.confirmationIds ?? [])),
    riskRuleIds: uniqueInOrder(summaries.flatMap((summary) => summary.riskRuleIds ?? [])),
    summaryVersion: summaries.reduce((version, summary) => Math.max(version, summary.summaryVersion ?? 0), 0),
  };
}

function summaryMessageId(context: AgentContext, sourceMessageIds: readonly string[], version: number): string {
  const digest = checkpointChecksum({ runId: context.runId, sourceMessageIds, version }).slice(0, 16);
  return 'context-summary-' + context.runId + '-' + version + '-' + digest;
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requireMessage(messages: readonly AgentMessage[], index: number): AgentMessage {
  const message = messages[index];
  if (message === undefined) throw new Error('Compression message index is out of bounds');
  return message;
}
