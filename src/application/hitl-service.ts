import type { CheckpointStore, Clock, ConfirmationDecision, ToolExecutionResult } from '../contracts/index.js';
import type { AgentMessage } from '../contracts/message.js';

export class HitlService {
  public constructor(
    private readonly checkpoints: CheckpointStore,
    private readonly clock: Clock,
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
      throw new Error(`Confirmation expired for tool call: ${decision.toolCallId}`);
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
}
