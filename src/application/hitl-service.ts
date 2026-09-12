import type { AgentContext, AgentEventPayloadMap, CheckpointStore, Clock, ConfirmationDecision, DurableRunState, EventPublisherV2Dependencies, PendingAgentEventV2, ToolCall, ToolExecutionResult } from '../contracts/index.js';
import { CheckpointConflictError, checkpointChecksum } from '../contracts/index.js';
import type { AgentMessage } from '../contracts/message.js';

export class HitlService {
  public constructor(
    private readonly checkpoints: CheckpointStore,
    private readonly clock: Clock,
    private readonly v2Events?: EventPublisherV2Dependencies,
    private readonly durableState?: DurableRunState,
  ) {}

  public async decide(decision: ConfirmationDecision): Promise<void> {
    const stored = await this.loadCheckpoint(decision.runId);
    if (stored === null) throw new Error(`Checkpoint not found: ${decision.runId}`);
    const { context } = stored;
    const interrupt = context.pendingInterrupt;
    if (context.status !== 'awaiting_confirmation' || interrupt === undefined) {
      throw new Error(`Run is not awaiting confirmation: ${decision.runId}`);
    }
    if (interrupt.toolCallId !== decision.toolCallId) {
      throw new Error(`Confirmation does not match pending tool call: ${decision.toolCallId}`);
    }
    const pending = this.pendingCall(context, decision.toolCallId);
    if (interrupt.expiresAt !== undefined && this.clock.now().getTime() >= Date.parse(interrupt.expiresAt)) {
      const expiredAt = this.clock.now().toISOString();
      const replacement = this.rejectedResult(pending, expiredAt, 'Confirmation expired.');
      this.replaceInterruptedResult(context.messages, replacement);
      this.storeTerminalPendingResult(context, replacement);
      context.pendingToolCalls = [];
      delete context.pendingInterrupt;
      context.rejectedToolCallIds.push(decision.toolCallId);
      context.status = 'running';
      context.contextVersion += 1;
      const events = this.v2Events === undefined ? [] : [
        this.createPendingV2('CONFIRMATION_EXPIRED', context, {
          confirmationId: confirmationId(context.runId, decision.toolCallId),
          toolCallIds: [decision.toolCallId],
          expiredAt,
        }),
        this.createPendingV2('TOOL_RESULT', context, { result: replacement, durationMs: 0, evidenceIds: [] }, decision.toolCallId),
      ];
      await this.persistTransition(context, stored.revision, events);
      return;
    }

    if (decision.confirmed) {
      if (!context.confirmedToolCallIds.includes(decision.toolCallId)) {
        context.confirmedToolCallIds.push(decision.toolCallId);
      }
      this.discardProvisionalPendingResult(context, decision.toolCallId);
      if (context.pendingToolBatch !== undefined) context.pendingToolBatch.state = 'executing';
    } else {
      context.rejectedToolCallIds.push(decision.toolCallId);
      const now = this.clock.now().toISOString();
      const replacement: ToolExecutionResult = {
        toolCallId: decision.toolCallId,
        toolName: pending.name,
        status: 'aborted',
        error: {
          code: 'USER_REJECTED',
          message: decision.reason ?? 'User rejected the action.',
          retryable: false,
          details: { actor: decision.actor, decidedAt: decision.decidedAt },
        },
        startedAt: now,
        finishedAt: now,
      };
      this.replaceInterruptedResult(context.messages, replacement);
      this.storeTerminalPendingResult(context, replacement);
      context.pendingToolCalls = [];
      delete context.pendingInterrupt;
    }
    context.status = 'running';
    context.contextVersion += 1;
    const events: PendingAgentEventV2[] = this.v2Events === undefined ? [] : [this.createPendingV2('CONFIRMATION_RESOLVED', context, {
      decision: decision.confirmed ? 'approved' : 'rejected', actor: decision.actor, toolCallIds: [decision.toolCallId], decidedAt: decision.decidedAt,
    })];
    if (!decision.confirmed) {
      const result = context.messages.flatMap((message) => message.blocks)
        .find((block) => block.type === 'tool_result' && block.result.toolCallId === decision.toolCallId);
      if (result?.type === 'tool_result' && this.v2Events !== undefined) {
        events.push(this.createPendingV2('TOOL_RESULT', context, { result: result.result, durationMs: 0, evidenceIds: [] }, decision.toolCallId));
      }
    }
    await this.persistTransition(context, stored.revision, events);
  }

  private replaceInterruptedResult(
    messages: AgentMessage[],
    replacement: ToolExecutionResult,
  ): void {
    for (const message of messages) {
      message.blocks = message.blocks.map((block) => (
        block.type === 'tool_result' && block.result.toolCallId === replacement.toolCallId
          ? { type: 'tool_result' as const, result: replacement }
          : block
      ));
    }
  }

  private rejectedResult(call: ToolCall, now: string, message: string): ToolExecutionResult {
    return { toolCallId: call.id, toolName: call.name, status: 'aborted', error: { code: 'CONFIRMATION_EXPIRED', message, retryable: false }, startedAt: now, finishedAt: now };
  }

  private async loadCheckpoint(runId: string): Promise<{ context: AgentContext; revision?: number } | null> {
    if (this.durableState === undefined) {
      const context = await this.checkpoints.load(runId);
      return context === null ? null : { context };
    }
    const checkpoint = await this.durableState.checkpoints.load(runId);
    return checkpoint === null ? null : { context: checkpoint.context, revision: checkpoint.revision };
  }

  private async saveCheckpoint(context: AgentContext, revision: number | undefined): Promise<void> {
    if (this.durableState === undefined) {
      await this.checkpoints.save(context);
      return;
    }
    if (revision === undefined) throw new Error(`Missing durable checkpoint revision: ${context.runId}`);
    try {
      await this.durableState.checkpoints.save(context, revision);
    } catch (error) {
      throw durableStorageError(error);
    }
  }

  private async persistTransition(
    context: AgentContext,
    revision: number | undefined,
    events: readonly PendingAgentEventV2[],
  ): Promise<void> {
    if (this.durableState !== undefined) {
      if (events.length > 0 && this.v2Events?.dispatcher === undefined) {
        throw new Error(`Durable V2 event dispatcher is not configured: ${context.runId}`);
      }
      try {
        await this.durableState.transitions.commit({
          expectedRevision: revision ?? null,
          context,
          outboxEvents: events,
        });
        if (events.length > 0) await this.v2Events!.dispatcher!.drainRun(context.runId);
      } catch (error) {
        throw durableStorageError(error);
      }
      return;
    }
    await this.saveCheckpoint(context, revision);
    for (const event of events) await this.v2Events?.publisher.publish(event);
  }

  private pendingCall(context: AgentContext, toolCallId: string): ToolCall {
    const batch = context.pendingToolBatch;
    if (this.durableState !== undefined) {
      if (batch === undefined) throw new Error(`Durable confirmation is missing its pending batch: ${context.runId}`);
      if (batch.state !== 'awaiting_confirmation') {
        throw new Error(`Durable confirmation batch is not awaiting confirmation: ${context.runId}`);
      }
      const durableCall = batch.calls.find((candidate) => candidate.id === toolCallId);
      if (durableCall === undefined) throw new Error(`Pending tool call not found in durable batch: ${toolCallId}`);
      return durableCall;
    }
    const call = batch?.calls.find((candidate) => candidate.id === toolCallId)
      ?? context.pendingToolCalls.find((candidate) => candidate.id === toolCallId);
    if (call === undefined) throw new Error(`Pending tool call not found: ${toolCallId}`);
    return call;
  }

  private discardProvisionalPendingResult(context: AgentContext, toolCallId: string): void {
    const batch = context.pendingToolBatch;
    if (batch === undefined) return;
    batch.completedResults = batch.completedResults.filter((candidate) => (
      candidate.toolCallId !== toolCallId || !isProvisionalResult(candidate)
    ));
  }

  private storeTerminalPendingResult(context: AgentContext, result: ToolExecutionResult): void {
    const batch = context.pendingToolBatch;
    if (batch === undefined) return;
    if (isProvisionalResult(result)) throw new Error(`Confirmation result is not terminal: ${result.toolCallId}`);
    const call = batch.calls.find((candidate) => candidate.id === result.toolCallId);
    if (call === undefined || call.name !== result.toolName) {
      throw new Error(`Confirmation result does not belong to pending batch: ${result.toolCallId}`);
    }
    const index = batch.completedResults.findIndex((candidate) => candidate.toolCallId === result.toolCallId);
    if (index < 0) {
      batch.completedResults.push(structuredClone(result));
      return;
    }
    const existing = batch.completedResults[index];
    if (existing !== undefined && isProvisionalResult(existing)) {
      batch.completedResults[index] = structuredClone(result);
      return;
    }
    if (existing !== undefined && checkpointChecksum(existing) !== checkpointChecksum(result)) {
      throw new Error(`Confirmation result conflicts with pending batch: ${result.toolCallId}`);
    }
  }

  private publishV2<T extends keyof AgentEventPayloadMap>(type: T, context: AgentContext, payload: AgentEventPayloadMap[T], toolCallId?: string): Promise<void> {
    if (this.v2Events === undefined) return Promise.resolve();
    const pending = this.createPendingV2(type, context, payload, toolCallId);
    return this.v2Events.publisher.publish(pending).then(() => undefined);
  }

  private createPendingV2<T extends keyof AgentEventPayloadMap>(
    type: T,
    context: AgentContext,
    payload: AgentEventPayloadMap[T],
    toolCallId?: string,
  ): PendingAgentEventV2<T> {
    if (this.v2Events === undefined) throw new Error(`V2 event dependencies are not configured: ${type}`);
    return this.v2Events.factory.create(type, {
      runId: context.runId,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.replyId === undefined ? {} : { replyId: context.replyId }),
      ...(context.streamId === undefined ? {} : { streamId: context.streamId }),
      correlationId: this.v2Events.correlationId(context.runId),
      visibility: 'audit',
      durability: 'durable',
      ...(toolCallId === undefined ? {} : { toolCallId }),
    }, payload);
  }
}

function confirmationId(runId: string, toolCallId: string): string { return `confirmation:${runId}:${toolCallId}`; }

function isProvisionalResult(result: ToolExecutionResult): boolean {
  return result.status === 'interrupted' || result.status === 'awaiting_external';
}

function durableStorageError(error: unknown): Error {
  if (error instanceof CheckpointConflictError) {
    return Object.assign(new Error(error.message), {
      code: 'STORAGE_ERROR' as const,
      retryable: false,
      details: { category: error.category },
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}
