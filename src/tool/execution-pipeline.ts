import type {
  AgentContext,
  AgentEvent,
  Clock,
  EventSink,
  Observability,
  ToolCall,
  ToolResponse,
  ToolExecutionResult,
  AgentEventPayloadMap,
  EventFactoryV2Like,
  EventPublisherV2Like,
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
import {
  legacyToolProgressFromChunk,
  legacyToolStartedPayload,
} from '../event/v1-payloads.js';

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
    private readonly v2Events?: { factory: EventFactoryV2Like; publisher: EventPublisherV2Like; correlationId: (runId: string) => string },
  ) {}

  public async *executeStream(
    call: ToolCall,
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, ExecutionOutcome> {
    let outcome: ExecutionOutcome;
    try {
      if (signal.aborted) throw Object.assign(new Error('Run cancelled.'), { code: 'ABORTED', retryable: false });
      outcome = yield* this.executeValidatedStream(call, context, stepId, signal);
    } catch (error) {
      const agentError = toAgentError(error);
      outcome = {
        type: 'completed',
        result: this.result(call, signal.aborted ? 'aborted' : 'failed', this.clock.now().toISOString(), undefined, agentError),
        risk: { severity: 'SAFE', requireConfirmation: false, findings: [] },
      };
    }
    await this.publishV2('TOOL_RESULT', context, {
      result: outcome.result,
      durationMs: durationOf(outcome.result),
      evidenceIds: outcome.result.response?.evidenceIds ?? [],
    }, stepId, call.id);
    yield* this.emitLegacy(context, 'TOOL_RESULT', outcome.result, stepId);
    return outcome;
  }

  public async execute(
    call: ToolCall,
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    const stream = this.executeStream(call, context, stepId, signal);
    while (true) {
      const item = await stream.next();
      if (item.done) return item.value;
    }
  }

  private async *executeValidatedStream(
    call: ToolCall,
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, ExecutionOutcome> {
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
    await this.publishV2('RISK_EVALUATED', context, {
      findings: risk.findings.map((finding) => ({ ruleId: finding.ruleId, severity: finding.severity, description: finding.description, toolName: finding.toolName })),
      mergedRisk: risk.severity,
      policyVersion: 'guard-v1',
    }, stepId, call.id);
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
      if (this.v2Events === undefined) {
        yield* this.emitLegacy(context, 'EXTERNAL_TOOL_REQUESTED', interrupt, stepId);
      }
      return { type: 'interrupted', result, risk, interrupt };
    }

    const toolContext = {
      runId: context.runId,
      stepId,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.replyId === undefined ? {} : { replyId: context.replyId }),
      ...(context.streamId === undefined ? {} : { streamId: context.streamId }),
      signal,
      mode: tool.kind === 'action' ? this.options.actionMode : 'execute' as const,
      deadline: Date.parse(context.budget.startedAt) + context.budget.maxDurationMs,
      networkAttemptBudget: context.networkAttemptBudget ??= { remaining: context.budget.maxToolCalls * 3 },
    };
    await this.publishV2('TOOL_STARTED', context, {
      toolName: tool.name,
      source: tool.name.startsWith('mcp.') ? 'mcp' : tool.name.startsWith('subagent.') ? 'subagent' : 'builtin',
      attempt: 1,
      deadline: new Date(toolContextDeadline(context)).toISOString(),
    }, stepId, call.id);
    yield* this.emitLegacy(context, 'TOOL_STARTED', legacyToolStartedPayload({
      toolCallId: call.id,
      toolName: tool.name,
      source: tool.name.startsWith('mcp.') ? 'mcp' : tool.name.startsWith('subagent.') ? 'subagent' : 'builtin',
      attempt: 1,
      deadline: new Date(toolContextDeadline(context)).toISOString(),
    }), stepId);
    const span = this.observability.startSpan({
      name: `tool.${tool.name}`,
      kind: 'tool',
      runId: context.runId,
      stepId,
      input: hookContext.input,
      attributes: { toolKind: tool.kind, riskSeverity: risk.severity },
    });

    let toolStream: ReturnType<ToolRunner['stream']> | undefined;
    let streamCompleted = false;
    try {
      const stream = this.runner.stream(tool, hookContext.input, toolContext);
      toolStream = stream;
      let response: ToolResponse;
      while (true) {
        const item = await stream.next();
        if (item.done) {
          streamCompleted = true;
          response = item.value;
          break;
        }
        const chunk = item.value;
        if (chunk.type === 'text_delta') {
          await this.publishV2('TOOL_OUTPUT_DELTA', context, {
            blockId: `tool-output:${call.id}`,
            textDelta: chunk.delta,
          }, stepId, call.id);
        }
        if (chunk.type === 'progress') {
          await this.publishV2('TOOL_PROGRESS', context, {
            progress: chunk.percent === undefined ? 0 : Math.max(0, Math.min(1, chunk.percent / 100)),
            displaySummary: chunk.message,
          }, stepId, call.id);
        }
        const legacyChunk = legacyToolProgressFromChunk(call.id, chunk);
        if (legacyChunk !== null) {
          yield* this.emitLegacy(context, 'TOOL_PROGRESS', legacyChunk, stepId);
        } else if (this.v2Events === undefined) {
          yield* this.emitLegacy(context, 'TOOL_PROGRESS', { toolCallId: call.id, chunk }, stepId);
        }
      }
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
      await this.publishV2('TOOL_FAILED', context, { error: { code: agentError.code, message: agentError.message, retryable: agentError.retryable }, attempt: 1, retryable: agentError.retryable }, stepId, call.id);
      return { type: 'completed', result, risk };
    } finally {
      if (!streamCompleted && toolStream !== undefined) {
        await toolStream.return(undefined as unknown as ToolResponse).catch(() => undefined);
      }
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

  private publishV2<T extends keyof AgentEventPayloadMap>(type: T, context: AgentContext, payload: AgentEventPayloadMap[T], stepId: string, toolCallId?: string): Promise<void> {
    if (this.v2Events === undefined) return Promise.resolve();
    const pending = this.v2Events.factory.create(type, {
      runId: context.runId,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.replyId === undefined ? {} : { replyId: context.replyId }),
      ...(context.streamId === undefined ? {} : { streamId: context.streamId }),
      correlationId: this.v2Events.correlationId(context.runId),
      visibility: 'audit',
      durability: type === 'TOOL_OUTPUT_DELTA' ? 'transient' : 'durable',
      stepId,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    }, payload);
    return this.v2Events.publisher.publish(pending).then(() => undefined);
  }

  private async *emitLegacy(
    context: AgentContext,
    type: AgentEvent['type'],
    payload: AgentEvent['payload'],
    stepId?: string,
  ): AsyncGenerator<AgentEvent, void> {
    const event = this.eventFactory.create(type, context.runId, payload, stepId);
    if (this.v2Events === undefined) await this.events.publish(event);
    yield event;
  }
}

function durationOf(result: ToolExecutionResult): number {
  const start = Date.parse(result.startedAt);
  const end = result.finishedAt === undefined ? start : Date.parse(result.finishedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function toolContextDeadline(context: AgentContext): number {
  return Date.parse(context.budget.startedAt) + context.budget.maxDurationMs;
}
