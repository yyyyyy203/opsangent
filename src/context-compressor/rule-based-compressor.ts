import type {
  AgentContext,
  AgentMessage,
  ContextSummary,
  EvidenceManifestStore,
  EvidenceStore,
  HistorySummaryInput,
  StructuredHistorySummary,
  ToolExecutionResult,
} from '../contracts/index.js';
import { canonicalJson } from '../contracts/index.js';
import { DefaultCompressionValidator } from './compression-validator.js';
import { DefaultToolResultCompactor } from './tool-result-compactor.js';
import { L1StructurePruner } from './l1-structure-pruner.js';
import type {
  CompressionOptions,
  CompressionResult,
  CompressionValidator,
  ContextCompressor,
  HistorySummarizer,
  ToolResultCompactor,
} from './types.js';

export interface RuleBasedCompressorOptions {
  maxMessagesBeforeL1: number;
  maxSerializedBytesBeforeL2: number;
  keepRecentMessages: number;
  toolResultCompactor?: ToolResultCompactor;
  summarizer?: HistorySummarizer;
  validator?: CompressionValidator;
  evidence?: EvidenceStore;
  evidenceManifests?: EvidenceManifestStore;
  now?: () => Date;
}

export class RuleBasedContextCompressor implements ContextCompressor {
  private readonly toolResultCompactor: ToolResultCompactor;
  private readonly l1Pruner = new L1StructurePruner();
  private readonly validator: CompressionValidator;

  public constructor(private readonly options: RuleBasedCompressorOptions) {
    this.toolResultCompactor = options.toolResultCompactor ?? new DefaultToolResultCompactor();
    if (options.validator !== undefined) {
      this.validator = options.validator;
    } else {
      const validatorOptions = {
        ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
        ...(options.evidenceManifests === undefined ? {} : { evidenceManifests: options.evidenceManifests }),
      };
      this.validator = new DefaultCompressionValidator(validatorOptions);
    }
  }

  public async compress(context: AgentContext, options?: CompressionOptions): Promise<CompressionResult> {
    const effectiveOptions = options ?? {
      signal: new AbortController().signal,
      deadline: Number.MAX_SAFE_INTEGER,
      now: this.options.now ?? (() => new Date()),
    };
    const serializedBytes = Buffer.byteLength(canonicalJson(context.messages), 'utf8');
    const messageThresholdReached = context.messages.length >= this.options.maxMessagesBeforeL1;
    const byteThresholdReached = serializedBytes >= this.options.maxSerializedBytesBeforeL2;
    if (!messageThresholdReached && !byteThresholdReached) {
      return { context, decision: { level: 'none', reason: 'below_thresholds' } };
    }

    const candidate = this.l1Pruner.prune({
      context,
      keepRecentMessages: this.options.keepRecentMessages,
      maxMessages: this.options.maxMessagesBeforeL1,
      now: effectiveOptions.now,
    });
    if (candidate.sourceMessageIds.length === 0) {
      return { context, decision: { level: 'none', reason: 'no_compressible_history' } };
    }

    const l1Context = candidate.context;
    const l1Trace = this.trace(
      candidate.sourceMessageIds,
      candidate.protectedMessageIds,
      candidate.keyToolCalls,
      candidate.evidenceIds,
      candidate.summaryVersion,
      serializedBytes,
      l1Context,
    );
    const l1Validation = await this.validator.validate({
      before: context,
      candidate: l1Context,
      sourceMessageIds: candidate.sourceMessageIds,
      maxMessages: this.options.maxMessagesBeforeL1,
      maxBytes: this.options.maxSerializedBytesBeforeL2,
    });
    if (!l1Validation.valid) {
      return {
        context,
        decision: { level: 'none', reason: 'compression_validation_failed' },
        trace: l1Trace,
        validation: l1Validation,
      };
    }
    const validatedL1Context = l1Validation.repairedContext ?? l1Context;

    if (byteThresholdReached && this.options.summarizer !== undefined) {
      const summaryInput = this.createSummaryInput(context, candidate);
      try {
        const structuredSummary = await this.options.summarizer.summarize(summaryInput, {
          signal: effectiveOptions.signal,
          deadline: effectiveOptions.deadline,
        });
        const l2Context = replaceSummary(
          validatedL1Context,
          structuredSummary,
          candidate.protectedMessageIds,
          effectiveOptions.now,
        );
        const l2Validation = await this.validator.validate({
          before: context,
          candidate: l2Context,
          sourceMessageIds: candidate.sourceMessageIds,
          maxMessages: this.options.maxMessagesBeforeL1,
          maxBytes: this.options.maxSerializedBytesBeforeL2,
        });
        if (l2Validation.valid) {
          const accepted = l2Validation.repairedContext ?? l2Context;
          return {
            context: accepted,
            decision: { level: 'L2', reason: 'serialized_context_bytes' },
            trace: this.trace(
              candidate.sourceMessageIds,
              candidate.protectedMessageIds,
              structuredSummary.keyToolCalls,
              structuredSummary.evidenceIds,
              structuredSummary.summaryVersion,
              serializedBytes,
              accepted,
            ),
            validation: l2Validation,
          };
        }
        return {
          context: validatedL1Context,
          decision: { level: 'L1', reason: 'l2_validation_failed' },
          trace: l1Trace,
          validation: {
            valid: true,
            status: 'summary_fallback',
            reasonCode: l2Validation.reasonCode ?? 'l2_validation_failed',
            ...(l2Validation.affectedIds === undefined ? {} : { affectedIds: l2Validation.affectedIds }),
          },
        };
      } catch (error) {
        return {
          context: validatedL1Context,
          decision: { level: 'L1', reason: 'l2_summary_failed' },
          trace: l1Trace,
          validation: {
            valid: true,
            status: 'summary_fallback',
            reasonCode: safeCompressionErrorCode(error),
          },
        };
      }
    }

    return {
      context: validatedL1Context,
      decision: { level: 'L1', reason: messageThresholdReached ? 'message_count' : 'serialized_context_bytes' },
      trace: l1Trace,
      validation: l1Validation,
    };
  }

  public pruneToolResult(result: ToolExecutionResult): Promise<ToolExecutionResult> {
    return Promise.resolve(this.toolResultCompactor.compact(result).result);
  }

  private createSummaryInput(context: AgentContext, candidate: { sourceMessageIds: string[] }): HistorySummaryInput {
    const sourceMessageIds = new Set(candidate.sourceMessageIds);
    const allowedToolCallIds = context.messages.flatMap((message) => (
      sourceMessageIds.has(message.id)
        ? message.blocks.flatMap((block) => block.type === 'tool_call' ? [block.call.id] : [])
        : []
    ));
    const summary = collectSummary(context.messages);
    return {
      runId: context.runId,
      context,
      sourceMessageIds: candidate.sourceMessageIds,
      messages: context.messages,
      previousSummary: summary,
      allowedMessageIds: candidate.sourceMessageIds,
      allowedToolCallIds: [...new Set(allowedToolCallIds)],
      allowedEvidenceIds: collectEvidenceIds(context),
      allowedConfirmationIds: summary.confirmationIds ?? [],
      allowedRiskRuleIds: summary.riskRuleIds ?? [],
    };
  }

  private trace(
    sourceMessageIds: string[],
    protectedMessageIds: string[],
    keyToolCalls: string[],
    evidenceIds: string[],
    summaryVersion: number,
    beforeBytes: number,
    context: AgentContext,
  ) {
    const afterBytes = Buffer.byteLength(canonicalJson(context.messages), 'utf8');
    return {
      sourceMessageIds: [...sourceMessageIds],
      protectedMessageIds: [...protectedMessageIds],
      keyToolCalls: [...keyToolCalls],
      evidenceIds: [...evidenceIds],
      summaryVersion,
      beforeBytes,
      afterBytes,
      savedBytes: Math.max(0, beforeBytes - afterBytes),
      offloadedEvidenceIds: [...evidenceIds],
    };
  }
}

function replaceSummary(
  context: AgentContext,
  summary: StructuredHistorySummary,
  protectedMessageIds: readonly string[],
  now: () => Date,
): AgentContext {
  let replaced = false;
  const messages = context.messages.map((message) => {
    const blocks = message.blocks.map((block) => {
      if (block.type !== 'context_summary' || replaced) return block;
      replaced = true;
      return { ...block, summary };
    });
    return blocks === message.blocks ? message : { ...message, blocks };
  });
  const nextMessages = replaced
    ? messages
    : [...messages, {
      id: 'context-summary-l2-' + context.runId + '-' + summary.summaryVersion,
      role: 'assistant' as const,
      createdAt: now().toISOString(),
      blocks: [{ type: 'context_summary' as const, summary }],
    }];
  const governance = context.governance === undefined
    ? undefined
    : {
      ...context.governance,
      compression: {
        ...context.governance.compression,
        summaryVersion: summary.summaryVersion,
        lastLevel: 'L2' as const,
        sourceMessageIds: [...summary.sourceMessageIds],
        protectedMessageIds: [...protectedMessageIds],
        offloadedEvidenceIds: [...summary.evidenceIds],
        lastCompressedAt: now().toISOString(),
      },
    };
  return {
    ...context,
    messages: nextMessages,
    ...(governance === undefined ? {} : { governance }),
  };
}

function collectSummary(messages: readonly AgentMessage[]): ContextSummary {
  const summaries = messages.flatMap((message) => message.blocks.flatMap((block) => (
    block.type === 'context_summary' ? [block.summary] : []
  )));
  return {
    confirmedFacts: [...new Set(summaries.flatMap((summary) => summary.confirmedFacts))],
    hypotheses: [...new Set(summaries.flatMap((summary) => summary.hypotheses))],
    missingEvidence: [...new Set(summaries.flatMap((summary) => summary.missingEvidence))],
    pendingActionIds: [...new Set(summaries.flatMap((summary) => summary.pendingActionIds))],
    executedActionIds: [...new Set(summaries.flatMap((summary) => summary.executedActionIds))],
    unresolvedRisks: [...new Set(summaries.flatMap((summary) => summary.unresolvedRisks))],
    evidenceIds: [...new Set(summaries.flatMap((summary) => summary.evidenceIds ?? []))],
    confirmationIds: [...new Set(summaries.flatMap((summary) => summary.confirmationIds ?? []))],
    riskRuleIds: [...new Set(summaries.flatMap((summary) => summary.riskRuleIds ?? []))],
  };
}

function collectEvidenceIds(context: AgentContext): string[] {
  const evidenceIds = new Set(context.evidenceIds);
  for (const message of context.messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_result') continue;
      for (const evidenceId of block.result.response?.evidenceIds ?? []) evidenceIds.add(evidenceId);
      for (const responseBlock of block.result.response?.blocks ?? []) {
        if (responseBlock.type === 'evidence_ref') evidenceIds.add(responseBlock.evidenceId);
      }
    }
  }
  return [...evidenceIds];
}

function safeCompressionErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code.toLowerCase();
  }
  return 'compression_summary_failed';
}
