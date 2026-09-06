import type {
  AgentContext,
  Clock,
  EventSink,
  Observability,
  ToolCall,
  ToolResponse,
  ToolExecutionResult,
} from '../contracts/index.js';
import { toAgentError } from '../contracts/errors.js';
import type { GuardEngine } from '../guard/guard-engine.js';
import type { HookExecutor } from '../hooks/hook-executor.js';
import type { HookContext } from '../hooks/types.js';
import type { EventFactory } from '../event/event-factory.js';
import type { CheckpointStore } from '../contracts/storage.js';
import type { ExecutionOutcome } from './execution-types.js';
import type { Toolkit } from './toolkit.js';
import type { ToolRunner } from './tool-runner.js';
import { validateToolInput } from './schema.js';

export interface ExecutionPipelineOptions {
  actionMode: 'dry_run' | 'execute';
}

export class ToolExecutionPipeline {
  public constructor(
    private readonly toolkit: Toolkit,
    private readonly guard: GuardEngine,
    private readonly hooks: HookExecutor,
    private readonly runner: ToolRunner,
    private readonly checkpoints: CheckpointStore,
    private readonly events: EventSink,
    private readonly eventFactory: EventFactory,
    private readonly observability: Observability,
    private readonly clock: Clock,
    private readonly options: ExecutionPipelineOptions,
  ) {}

  public async execute(
    call: ToolCall,
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    let outcome: ExecutionOutcome;
    try {
      if (signal.aborted) throw Object.assign(new Error('Run cancelled.'), { code: 'ABORTED', retryable: false });
      outcome = await this.executeValidated(call, context, stepId, signal);
    } catch (error) {
      const agentError = toAgentError(error);
      outcome = {
        type: 'completed',
        result: this.result(call, signal.aborted ? 'aborted' : 'failed', this.clock.now().toISOString(), undefined, agentError),
        risk: { severity: 'SAFE', requireConfirmation: false, findings: [] },
      };
    }
    await this.events.publish(this.eventFactory.create('TOOL_RESULT', context.runId, outcome.result, stepId));
    return outcome;
  }

  private async executeValidated(
    call: ToolCall,
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    const startedAt = this.clock.now().toISOString();
    const tool = this.toolkit.get(call.name);
    if (tool === undefined) {
      const result = this.result(call, 'failed', startedAt, undefined, {
        code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${call.name}`, retryable: false,
      });
      return { type: 'completed', result, risk: { severity: 'SAFE', requireConfirmation: false, findings: [] } };
    }

    const validation = validateToolInput(tool, call.input);
    if (!validation.valid) {
      const result = this.result(call, 'failed', startedAt, undefined, validation.error ?? {
        code: 'INVALID_INPUT', message: `Invalid input for ${tool.name}`, retryable: false,
      });
      return { type: 'completed', result, risk: { severity: 'SAFE', requireConfirmation: false, findings: [] } };
    }

    const semantics = tool.validateSemantics?.(validation.value ?? call.input);
    if (semantics && !semantics.valid) {
      return { type: 'completed', result: this.result(call, 'failed', startedAt, undefined, semantics.error),
        risk: { severity: 'SAFE', requireConfirmation: false, findings: [] } };
    }
    const normalizedCall = { ...call, input: semantics?.value ?? validation.value ?? call.input };
    const risk = await this.guard.inspect({ runId: context.runId, tool, toolCall: normalizedCall });
    const hookContext: HookContext = {
      context,
      stepId,
      toolCall: normalizedCall,
      tool,
      input: normalizedCall.input,
      risk,
    };
    const pre = await this.hooks.runBefore(hookContext);
    if (pre.type === 'abort') {
      return { type: 'completed', result: this.result(call, 'aborted', startedAt, undefined, pre.error), risk };
    }
    if (pre.type === 'interrupt') {
      const result = this.result(call, 'interrupted', startedAt);
      return { type: 'interrupted', result, risk, interrupt: pre.interrupt };
    }

    if (tool.kind === 'action' && await this.checkpoints.hasExecuted(call)) {
      return {
        type: 'completed',
        result: this.result(call, 'skipped', startedAt, {
          blocks: [{ type: 'json', value: { reason: 'already_executed' } }],
        }),
        risk,
      };
    }

    if (tool.call === undefined) {
      const interrupt = {
        hookId: 'external-tool-execution',
        interruptType: 'external_tool_execution',
        toolCallId: call.id,
        createdAt: this.clock.now().toISOString(),
        payload: {
          toolName: tool.name,
          input: hookContext.input,
          label: tool.userFacingLabel?.(hookContext.input) ?? tool.description,
          mode: tool.kind === 'action' ? this.options.actionMode : 'execute',
          risk,
        },
      };
      const result = this.result(call, 'awaiting_external', startedAt);
      await this.events.publish(this.eventFactory.create('EXTERNAL_TOOL_REQUESTED', context.runId, interrupt, stepId));
      return { type: 'interrupted', result, risk, interrupt };
    }

    const toolContext = {
      runId: context.runId,
      stepId,
      signal,
      mode: tool.kind === 'action' ? this.options.actionMode : 'execute' as const,
      deadline: Date.parse(context.budget.startedAt) + context.budget.maxDurationMs,
      networkAttemptBudget: context.networkAttemptBudget ??= { remaining: context.budget.maxToolCalls * 3 },
    };
    await this.events.publish(this.eventFactory.create('TOOL_STARTED', context.runId, call, stepId));
    const span = this.observability.startSpan({
      name: `tool.${tool.name}`,
      kind: 'tool',
      runId: context.runId,
      stepId,
      input: hookContext.input,
      attributes: { toolKind: tool.kind, riskSeverity: risk.severity },
    });

    try {
      const response = await this.runner.execute(tool, hookContext.input, toolContext, {
        onChunk: async (chunk) => this.events.publish(
          this.eventFactory.create('TOOL_PROGRESS', context.runId, { toolCallId: call.id, chunk }, stepId),
        ),
      });
      const result = this.result(call, response.isError === true ? 'failed' : 'success', startedAt, response);
      hookContext.result = result;
      const post = await this.hooks.runAfter(hookContext);
      if (post.type === 'abort') {
        span.fail(post.error);
        return { type: 'completed', result: { ...result, status: 'failed', error: post.error }, risk };
      }
      for (const evidenceId of response.evidenceIds ?? []) {
        if (!context.evidenceIds.includes(evidenceId)) context.evidenceIds.push(evidenceId);
      }
      if (tool.kind === 'action' && this.options.actionMode === 'execute' && result.status === 'success') {
        await this.checkpoints.recordExecuted(call, result);
        context.executedActions.push(result);
      }
      span.end(response);
      return { type: 'completed', result, risk };
    } catch (error) {
      const agentError = signal.aborted
        ? { code: 'ABORTED' as const, message: 'Tool execution aborted.', retryable: false }
        : toAgentError(error);
      const result = this.result(call, signal.aborted ? 'aborted' : 'failed', startedAt, undefined, agentError);
      span.fail(agentError);
      return { type: 'completed', result, risk };
    }
  }

  private result(
    call: ToolCall,
    status: ToolExecutionResult['status'],
    startedAt: string,
    response?: ToolResponse,
    error?: ToolExecutionResult['error'],
  ): ToolExecutionResult {
    return {
      toolCallId: call.id,
      toolName: call.name,
      status,
      startedAt,
      finishedAt: this.clock.now().toISOString(),
      ...(response === undefined ? {} : { response }),
      ...(error === undefined ? {} : { error }),
    };
  }
}
