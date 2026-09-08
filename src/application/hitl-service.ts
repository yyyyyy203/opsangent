import type { AgentContext, AgentEventPayloadMap, CheckpointStore, Clock, ConfirmationDecision, EventFactoryV2Like, EventPublisherV2Like, ToolExecutionResult } from '../contracts/index.js';
import type { AgentMessage } from '../contracts/message.js';

export class HitlService {
  public constructor(
    private readonly checkpoints: CheckpointStore,
    private readonly clock: Clock,
    private readonly v2Events?: { factory: EventFactoryV2Like; publisher: EventPublisherV2Like; correlationId: (runId: string) => string },
  ) {}

  public async decide(decision: ConfirmationDecision): Promise<void> {
    const context = await this.checkpoints.load(decision.runId);
    if (context === null) throw new Error(`Checkpoint not found: ${decision.runId}`);
    const interrupt = context.pendingInterrupt;
    if (context.status !== 'awaiting_confirmation' || interrupt === undefined) {
      throw new Error(`Run is not awaiting confirmation: ${decision.runId}`);
    }
    if (interrupt.toolCallId !== decision.toolCallId) {
      throw new Error(`Confirmation does not match pending tool call: ${decision.toolCallId}`);
    }
    if (interrupt.expiresAt !== undefined && this.clock.now().getTime() >= Date.parse(interrupt.expiresAt)) {
      const expiredAt = this.clock.now().toISOString();
      const replacement = this.rejectedResult(context, decision.toolCallId, expiredAt, 'Confirmation expired.');
      this.replaceInterruptedResult(context.messages, replacement);
      context.pendingToolCalls = [];
      delete context.pendingInterrupt;
      context.rejectedToolCallIds.push(decision.toolCallId);
      context.status = 'running';
      context.contextVersion += 1;
      await this.checkpoints.save(context);
      await this.publishV2('CONFIRMATION_EXPIRED', context, {
        confirmationId: confirmationId(context.runId, decision.toolCallId), toolCallIds: [decision.toolCallId], expiredAt,
      });
      await this.publishV2('TOOL_RESULT', context, { result: replacement, durationMs: 0, evidenceIds: [] }, decision.toolCallId);
      return;
    }

    if (decision.confirmed) {
      if (!context.confirmedToolCallIds.includes(decision.toolCallId)) {
        context.confirmedToolCallIds.push(decision.toolCallId);
      }
    } else {
      context.rejectedToolCallIds.push(decision.toolCallId);
      const now = this.clock.now().toISOString();
      this.replaceInterruptedResult(context.messages, {
        toolCallId: decision.toolCallId,
        toolName: context.pendingToolCalls[0]?.name ?? 'unknown',
        status: 'aborted',
        error: {
          code: 'USER_REJECTED',
          message: decision.reason ?? 'User rejected the action.',
          retryable: false,
          details: { actor: decision.actor, decidedAt: decision.decidedAt },
        },
        startedAt: now,
        finishedAt: now,
      });
      context.pendingToolCalls = [];
      delete context.pendingInterrupt;
    }
    context.status = 'running';
    context.contextVersion += 1;
    await this.checkpoints.save(context);
    await this.publishV2('CONFIRMATION_RESOLVED', context, {
      decision: decision.confirmed ? 'approved' : 'rejected', actor: decision.actor, toolCallIds: [decision.toolCallId], decidedAt: decision.decidedAt,
    });
    if (!decision.confirmed) {
      const result = context.messages.flatMap((message) => message.blocks)
        .find((block) => block.type === 'tool_result' && block.result.toolCallId === decision.toolCallId);
      if (result?.type === 'tool_result') await this.publishV2('TOOL_RESULT', context, { result: result.result, durationMs: 0, evidenceIds: [] }, decision.toolCallId);
    }
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

  private rejectedResult(context: AgentContext, toolCallId: string, now: string, message: string): ToolExecutionResult {
    return { toolCallId, toolName: context.pendingToolCalls[0]?.name ?? 'unknown', status: 'aborted', error: { code: 'CONFIRMATION_EXPIRED', message, retryable: false }, startedAt: now, finishedAt: now };
  }

  private publishV2<T extends keyof AgentEventPayloadMap>(type: T, context: AgentContext, payload: AgentEventPayloadMap[T], toolCallId?: string): Promise<void> {
    if (this.v2Events === undefined) return Promise.resolve();
    const pending = this.v2Events.factory.create(type, {
      runId: context.runId,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.replyId === undefined ? {} : { replyId: context.replyId }),
      ...(context.streamId === undefined ? {} : { streamId: context.streamId }),
      correlationId: this.v2Events.correlationId(context.runId),
      visibility: 'audit',
      durability: 'durable',
      ...(toolCallId === undefined ? {} : { toolCallId }),
    }, payload);
    return this.v2Events.publisher.publish(pending).then(() => undefined);
  }
}

function confirmationId(runId: string, toolCallId: string): string { return `confirmation:${runId}:${toolCallId}`; }
