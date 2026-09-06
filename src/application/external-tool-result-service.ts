import type {
  CheckpointStore,
  Clock,
  EventSink,
  ResolvedRisk,
  ToolExecutionResult,
  ToolResponse,
} from '../contracts/index.js';
import type { EventFactory } from '../event/event-factory.js';
import type { GuardEngine } from '../guard/guard-engine.js';
import type { HookExecutor } from '../hooks/hook-executor.js';
import type { Toolkit } from '../tool/toolkit.js';

export interface ExternalToolResultSubmission {
  runId: string;
  toolCallId: string;
  response: ToolResponse;
}

export class ExternalToolResultService {
  public constructor(
    private readonly checkpoints: CheckpointStore,
    private readonly clock: Clock,
    private readonly toolkit: Toolkit,
    private readonly guard: GuardEngine,
    private readonly hooks: HookExecutor,
    private readonly events: EventSink,
    private readonly eventFactory: EventFactory,
  ) {}

  public async submit(submission: ExternalToolResultSubmission): Promise<void> {
    const context = await this.checkpoints.load(submission.runId);
    if (context === null) throw new Error(`Checkpoint not found: ${submission.runId}`);
    const interrupt = context.pendingInterrupt;
    if (context.status !== 'paused' || interrupt?.interruptType !== 'external_tool_execution') {
      throw new Error(`Run is not awaiting external tool execution: ${submission.runId}`);
    }
    if (interrupt.toolCallId !== submission.toolCallId) {
      throw new Error(`External result does not match pending tool call: ${submission.toolCallId}`);
    }
    const pending = context.pendingToolCalls.find((call) => call.id === submission.toolCallId);
    if (pending === undefined) throw new Error(`Pending tool call not found: ${submission.toolCallId}`);

    const now = this.clock.now().toISOString();
    let replacement: ToolExecutionResult = {
      toolCallId: pending.id,
      toolName: pending.name,
      status: submission.response.isError === true ? 'failed' : 'success',
      response: submission.response,
      startedAt: interrupt.createdAt,
      finishedAt: now,
    };
    const tool = this.toolkit.get(pending.name);
    if (tool === undefined) throw new Error(`Tool not found while ingesting external result: ${pending.name}`);
    const risk = await this.guard.inspect({ runId: context.runId, tool, toolCall: pending });
    const hookResult = await this.hooks.runAfter({
      context,
      stepId: `external-${pending.id}`,
      toolCall: pending,
      tool,
      input: pending.input,
      risk: isResolvedRisk(interrupt.payload.risk) ? interrupt.payload.risk : risk,
      result: replacement,
    });
    if (hookResult.type === 'abort') {
      replacement = { ...replacement, status: 'failed', error: hookResult.error };
    }
    for (const evidenceId of submission.response.evidenceIds ?? []) {
      if (!context.evidenceIds.includes(evidenceId)) context.evidenceIds.push(evidenceId);
    }
    if (tool.kind === 'action'
      && interrupt.payload.mode === 'execute'
      && replacement.status === 'success') {
      await this.checkpoints.recordExecuted(pending, replacement);
      context.executedActions.push(replacement);
    }
    for (const message of context.messages) {
      message.blocks = message.blocks.map((block) => (
        block.type === 'tool_result' && block.result.toolCallId === pending.id
          ? { type: 'tool_result' as const, result: replacement }
          : block
      ));
    }
    context.pendingToolCalls = [];
    delete context.pendingInterrupt;
    context.status = 'running';
    context.stage = pending.name === 'bash' ? 'verification' : context.stage;
    context.contextVersion += 1;
    await this.checkpoints.save(context);
    await this.events.publish(this.eventFactory.create(
      'TOOL_RESULT',
      context.runId,
      replacement,
      `external-${pending.id}`,
    ));
  }
}

function isResolvedRisk(value: unknown): value is ResolvedRisk {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ResolvedRisk>;
  return typeof candidate.severity === 'string'
    && typeof candidate.requireConfirmation === 'boolean'
    && Array.isArray(candidate.findings);
}
