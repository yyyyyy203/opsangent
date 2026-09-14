import type { AgentContext, AgentMessage, EvidenceManifestStore, EvidenceStore } from '../contracts/index.js';
import { canonicalJson } from '../contracts/stable-json.js';
import type {
  CompressionValidationInput,
  CompressionValidator,
  CompressionValidatorOptions,
} from './types.js';
import type { CompressionValidationResult } from '../contracts/context-compression.js';

export class DefaultCompressionValidator implements CompressionValidator {
  private readonly evidence: EvidenceStore | undefined;
  private readonly evidenceManifests: EvidenceManifestStore | undefined;

  public constructor(options: CompressionValidatorOptions = {}) {
    this.evidence = options.evidence;
    this.evidenceManifests = options.evidenceManifests;
  }

  public async validate(input: CompressionValidationInput): Promise<CompressionValidationResult> {
    if (input.candidate.messages.length > input.maxMessages) {
      return failure('compression_size_exceeded');
    }
    if (Buffer.byteLength(canonicalJson(input.candidate.messages), 'utf8') > input.maxBytes) {
      return failure('compression_size_exceeded');
    }

    const sourceIds = new Set(input.sourceMessageIds);
    const beforeMessageIds = new Set(input.before.messages.map((message) => message.id));
    for (const sourceId of sourceIds) {
      if (!beforeMessageIds.has(sourceId)) return failure('unknown_source_message');
    }

    const beforeCalls = indexCalls(input.before.messages);
    const candidateCalls = indexCalls(input.candidate.messages);
    const candidateResults = indexResults(input.candidate.messages);
    const pendingCalls = new Set([
      ...input.candidate.pendingToolCalls.map((call) => call.id),
      ...(input.candidate.pendingToolBatch?.calls.map((call) => call.id) ?? []),
      ...(input.candidate.pendingInterrupt?.toolCallId === undefined ? [] : [input.candidate.pendingInterrupt.toolCallId]),
    ]);
    const summary = collectSummary(input.candidate);
    const summaryCallIds = new Set(summary.keyToolCalls);

    for (const callId of summaryCallIds) {
      if (!beforeCalls.has(callId) && !pendingCalls.has(callId)) return failure('summary_tool_call_unknown', [callId]);
    }

    for (const [callId, messageIds] of beforeCalls) {
      if (candidateCalls.has(callId)) continue;
      if (!summaryCallIds.has(callId)) return failure('missing_summary_tool_call', [callId]);
      if (messageIds.some((messageId) => !sourceIds.has(messageId))) {
        return failure('missing_source_message', messageIds);
      }
    }

    for (const [callId] of candidateCalls) {
      if (candidateResults.has(callId) || pendingCalls.has(callId)) continue;
      const originalResult = findResultMessage(input.before.messages, callId);
      if (originalResult !== undefined && sourceIds.has(originalResult.id)) {
        const repairedContext = restoreMessageAfterCall(input.candidate, callId, originalResult);
        return {
          valid: true,
          status: 'repaired',
          repairable: true,
          reasonCode: 'restore_tool_result',
          repairType: 'restore_tool_result',
          affectedIds: [callId],
          repairedContext,
        };
      }
      return failure('orphan_visible_tool_call', [callId]);
    }

    const preservedState = compareDurableState(input.before, input.candidate);
    if (!preservedState) return failure('durable_state_changed');

    const beforeEvidenceIds = collectEvidenceIds(input.before);
    const candidateEvidenceIds = collectEvidenceIds(input.candidate);
    for (const evidenceId of candidateEvidenceIds) {
      if (!beforeEvidenceIds.has(evidenceId)) return failure('unknown_evidence_id', [evidenceId]);
    }
    const evidenceResult = await this.validateEvidence(input.candidate.runId, candidateEvidenceIds);
    if (!evidenceResult.valid) return evidenceResult;

    return { valid: true, status: 'valid' };
  }

  private async validateEvidence(
    runId: string,
    evidenceIds: ReadonlySet<string>,
  ): Promise<CompressionValidationResult> {
    for (const evidenceId of evidenceIds) {
      let visible = false;
      let wrongRun = false;
      if (this.evidenceManifests !== undefined) {
        const manifest = await this.evidenceManifests.getVisible(evidenceId);
        if (manifest !== null) {
          visible = true;
          wrongRun ||= manifest.runId !== runId;
        }
      }
      if (!visible && this.evidence !== undefined) {
        const record = await this.evidence.get(evidenceId);
        if (record !== null) {
          visible = true;
          wrongRun ||= record.runId !== runId;
        }
      }
      if (wrongRun) return failure('evidence_not_visible_for_run', [evidenceId]);
      if (!visible) return failure('evidence_not_visible', [evidenceId]);
    }
    return { valid: true, status: 'valid' };
  }
}

function failure(reasonCode: string, affectedIds: readonly string[] = []): CompressionValidationResult {
  return {
    valid: false,
    status: 'failed',
    repairable: false,
    reasonCode,
    ...(affectedIds.length === 0 ? {} : { affectedIds: [...affectedIds] }),
  };
}

function indexCalls(messages: readonly AgentMessage[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_call') continue;
      const ids = result.get(block.call.id) ?? [];
      ids.push(message.id);
      result.set(block.call.id, ids);
    }
  }
  return result;
}

function indexResults(messages: readonly AgentMessage[]): Set<string> {
  const result = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') result.add(block.result.toolCallId);
    }
  }
  return result;
}

function findResultMessage(messages: readonly AgentMessage[], toolCallId: string): AgentMessage | undefined {
  return messages.find((message) => message.blocks.some((block) => (
    block.type === 'tool_result' && block.result.toolCallId === toolCallId
  )));
}

function restoreMessageAfterCall(
  context: AgentContext,
  toolCallId: string,
  resultMessage: AgentMessage,
): AgentContext {
  const callIndex = context.messages.findIndex((message) => message.blocks.some((block) => (
    block.type === 'tool_call' && block.call.id === toolCallId
  )));
  const insertAt = callIndex < 0 ? context.messages.length : callIndex + 1;
  const messages = [...context.messages];
  messages.splice(insertAt, 0, structuredClone(resultMessage));
  return { ...context, messages, contextVersion: context.contextVersion + 1 };
}

function collectSummary(context: AgentContext): {
  keyToolCalls: string[];
  evidenceIds: string[];
} {
  const keyToolCalls: string[] = [];
  const evidenceIds: string[] = [];
  for (const message of context.messages) {
    for (const block of message.blocks) {
      if (block.type !== 'context_summary') continue;
      keyToolCalls.push(...(block.summary.keyToolCalls ?? []));
      evidenceIds.push(...(block.summary.evidenceIds ?? []));
    }
  }
  return { keyToolCalls: [...new Set(keyToolCalls)], evidenceIds: [...new Set(evidenceIds)] };
}

function collectEvidenceIds(context: AgentContext): Set<string> {
  const result = new Set(context.evidenceIds);
  for (const message of context.messages) {
    for (const block of message.blocks) {
      if (block.type === 'context_summary') {
        for (const evidenceId of block.summary.evidenceIds ?? []) result.add(evidenceId);
      }
      if (block.type === 'tool_result') {
        for (const evidenceId of block.result.response?.evidenceIds ?? []) result.add(evidenceId);
        for (const responseBlock of block.result.response?.blocks ?? []) {
          if (responseBlock.type === 'evidence_ref') result.add(responseBlock.evidenceId);
        }
      }
    }
  }
  return result;
}

function compareDurableState(before: AgentContext, candidate: AgentContext): boolean {
  return canonicalJson(durableState(before)) === canonicalJson(durableState(candidate));
}

function durableState(context: AgentContext): Record<string, unknown> {
  return {
    pendingToolCalls: context.pendingToolCalls,
    ...(context.pendingToolBatch === undefined ? {} : { pendingToolBatch: context.pendingToolBatch }),
    ...(context.pendingInterrupt === undefined ? {} : { pendingInterrupt: context.pendingInterrupt }),
    confirmedToolCallIds: context.confirmedToolCallIds,
    rejectedToolCallIds: context.rejectedToolCallIds,
    executedActions: context.executedActions,
    missingEvidence: context.missingEvidence,
    evidenceIds: context.evidenceIds,
  };
}
