import type {
  AgentContext,
  AgentEvent,
  Clock,
  EventSink,
  Observability,
  ToolCall,
  ToolResponse,
  ToolExecutionResult,
  ToolExecutionJournal,
  ToolExecutionRecord,
  Tool,
  AgentEventPayloadMap,
  EventFactoryV2Like,
  EventPublisherV2Like,
  LifecycleObserverResult,
  GovernanceEvaluator,
  ToolBatchGovernanceSnapshot,
  ResolvedRisk,
  ToolLifecycleFact,
} from '../contracts/index.js';
import { checkpointChecksum, toAgentError } from '../contracts/index.js';
import type { GuardEngine } from '../guard/guard-engine.js';
import type { ControlHookExecutor } from '../hooks/control-hook-executor.js';
import type { HookExecutor } from '../hooks/hook-executor.js';
import type { HookContext } from '../hooks/types.js';
import type { LifecycleObserverExecutor } from '../hooks/lifecycle-observer-executor.js';
import type { EventFactory } from '../event/event-factory.js';
import type { CheckpointStore } from '../contracts/storage.js';
import type { ExecutionOutcome } from './execution-types.js';
import type { Toolkit } from './toolkit.js';
import type { ToolRunner } from './tool-runner.js';
import { toolInputDigest, validateToolInput } from './schema.js';
import {
  legacyToolProgressFromChunk,
  legacyToolStartedPayload,
} from '../event/v1-payloads.js';

export interface ExecutionPipelineOptions {
  actionMode: 'dry_run' | 'execute';
  /** The Harness publishes V2 results only after its durable result commit succeeds. */
  deferV2ResultPublication?: boolean;
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
    private readonly executionJournal?: ToolExecutionJournal,
    private readonly governanceEvaluator?: GovernanceEvaluator,
    private readonly controlHooks?: ControlHookExecutor,
    private readonly lifecycleObservers?: LifecycleObserverExecutor,
  ) {}

  public async evaluateBatchGovernance(
    calls: readonly ToolCall[],
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
  ): Promise<ToolBatchGovernanceSnapshot | undefined> {
    if (this.governanceEvaluator === undefined || context.governance === undefined) return undefined;
    return this.governanceEvaluator.evaluateBatch({
      runId: context.runId,
      stepId,
      profile: context.governance.profile,
      calls,
      signal,
      deadline: toolContextDeadline(context),
    });
  }

  public async *executeStream(
    call: ToolCall,
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
    governance?: ToolBatchGovernanceSnapshot,
  ): AsyncGenerator<AgentEvent, ExecutionOutcome> {
    let outcome: ExecutionOutcome;
    try {
      if (signal.aborted) throw Object.assign(new Error('Run cancelled.'), { code: 'ABORTED', retryable: false });
      outcome = yield* this.executeValidatedStream(call, context, stepId, signal, governance);
    } catch (error) {
      const agentError = toAgentError(error);
      outcome = {
        type: 'completed',
        result: this.result(call, signal.aborted ? 'aborted' : 'failed', this.clock.now().toISOString(), undefined, agentError),
        risk: { severity: 'SAFE', requireConfirmation: false, findings: [] },
      };
    }
    const observation = await this.observeLifecycle(call, context, stepId, outcome);
    outcome = {
      ...outcome,
      effects: observation.effects,
      observerFailures: observation.failedObserverIds,
    };
    if (!this.options.deferV2ResultPublication) {
      await this.publishV2('TOOL_RESULT', context, {
        result: outcome.result,
        durationMs: durationOf(outcome.result),
        evidenceIds: outcome.result.response?.evidenceIds ?? [],
      }, stepId, call.id);
    }
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
    governance?: ToolBatchGovernanceSnapshot,
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
    const risk = await this.resolveRisk(context, stepId, signal, tool, normalizedCall, governance);
    if (signal.aborted) throw Object.assign(new Error('Run cancelled.'), { code: 'ABORTED', retryable: false });
    await this.publishV2('RISK_EVALUATED', context, {
      findings: risk.findings.map((finding) => ({ ruleId: finding.ruleId, severity: finding.severity, description: finding.description, toolName: finding.toolName })),
      mergedRisk: risk.severity,
      policyVersion: risk.policyVersion ?? 'guard-v1',
    }, stepId, call.id);
    if (signal.aborted) throw Object.assign(new Error('Run cancelled.'), { code: 'ABORTED', retryable: false });
    if (risk.disposition === 'deny' && this.controlHooks === undefined) {
      return {
        type: 'completed',
        result: this.result(call, 'failed', startedAt, undefined, {
          code: 'POLICY_DENIED',
          message: 'Tool call denied by policy.',
          retryable: false,
          details: { category: 'risk_policy' },
        }),
        risk,
      };
    }
    const hookContext: HookContext = {
      context,
      stepId,
      toolCall: normalizedCall,
      tool,
      input: normalizedCall.input,
      risk,
    };
    const originalInputDigest = toolInputDigest(tool, normalizedCall);
    const control = this.controlHooks === undefined
      ? { type: 'continue' as const, modifiedInput: hookContext.input }
      : await this.controlHooks.runBefore(hookContext);
    if (control.type === 'abort') {
      const status = control.error.code === 'POLICY_DENIED' ? 'failed' : 'aborted';
      return { type: 'completed', result: this.result(call, status, startedAt, undefined, control.error), risk };
    }
    if (control.type === 'interrupt') {
      const result = this.result(call, 'interrupted', startedAt);
      return { type: 'interrupted', result, risk, interrupt: control.interrupt };
    }
    const controlledInput = this.revalidateHookInput(tool, normalizedCall, control.modifiedInput ?? hookContext.input, originalInputDigest);
    if (!controlledInput.valid) {
      return { type: 'completed', result: this.result(call, 'failed', startedAt, undefined, controlledInput.error), risk };
    }
    hookContext.input = controlledInput.input;
    hookContext.toolCall = { ...normalizedCall, input: controlledInput.input };

    const pre = await this.hooks.runBefore(hookContext);
    if (pre.type === 'abort') {
      const status = pre.error.code === 'POLICY_DENIED' ? 'failed' : 'aborted';
      return { type: 'completed', result: this.result(call, status, startedAt, undefined, pre.error), risk };
    }
    if (pre.type === 'interrupt') {
      const result = this.result(call, 'interrupted', startedAt);
      return { type: 'interrupted', result, risk, interrupt: pre.interrupt };
    }
    const legacyInput = this.revalidateHookInput(tool, normalizedCall, pre.modifiedInput ?? hookContext.input, originalInputDigest);
    if (!legacyInput.valid) {
      return { type: 'completed', result: this.result(call, 'failed', startedAt, undefined, legacyInput.error), risk };
    }
    hookContext.input = legacyInput.input;
    hookContext.toolCall = { ...normalizedCall, input: legacyInput.input };

    if (tool.kind === 'action' && await this.checkpoints.hasExecuted(call)) {
      return {
        type: 'completed',
        result: this.result(call, 'skipped', startedAt, {
          blocks: [{ type: 'json', value: { reason: 'already_executed' } }],
        }),
        risk,
      };
    }

    const execution = await this.prepareExecution(tool, normalizedCall, context, stepId);
    if (execution?.state === 'succeeded' || execution?.state === 'failed') {
      if (execution.result === undefined) throw new Error(`Terminal execution is missing a result: ${call.id}`);
      return { type: 'completed', result: execution.result, risk, execution };
    }
    if (execution?.state === 'uncertain') {
      throw new Error(`Uncertain execution cannot be invoked: ${call.id}`);
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
          inputDigest: toolInputDigest(tool, hookContext.toolCall),
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
      toolCallId: call.id,
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
      source: toolSource(tool),
      attempt: 1,
      deadline: new Date(toolContextDeadline(context)).toISOString(),
    }, stepId, call.id);
    yield* this.emitLegacy(context, 'TOOL_STARTED', legacyToolStartedPayload({
      toolCallId: call.id,
      toolName: tool.name,
      source: toolSource(tool),
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
        return {
          type: 'completed',
          result: { ...result, status: 'failed', error: post.error },
          risk,
          ...(execution === undefined ? {} : { execution }),
        };
      }
      for (const evidenceId of response.evidenceIds ?? []) {
        if (!context.evidenceIds.includes(evidenceId)) context.evidenceIds.push(evidenceId);
      }
      if (tool.kind === 'action' && this.options.actionMode === 'execute' && result.status === 'success') {
        await this.checkpoints.recordExecuted(call, result);
        context.executedActions.push(result);
      }
      span.end(response);
      return { type: 'completed', result, risk, ...(execution === undefined ? {} : { execution }) };
    } catch (error) {
      const agentError = signal.aborted
        ? { code: 'ABORTED' as const, message: 'Tool execution aborted.', retryable: false }
        : toAgentError(error);
      const result = this.result(call, signal.aborted ? 'aborted' : 'failed', startedAt, undefined, agentError);
      span.fail(agentError);
      await this.publishV2('TOOL_FAILED', context, { error: { code: agentError.code, message: agentError.message, retryable: agentError.retryable }, attempt: 1, retryable: agentError.retryable }, stepId, call.id);
      return { type: 'completed', result, risk, ...(execution === undefined ? {} : { execution }) };
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

  private revalidateHookInput(
    tool: NonNullable<ReturnType<Toolkit['get']>>,
    originalCall: ToolCall,
    candidate: Record<string, unknown>,
    originalInputDigest: string,
  ): { valid: true; input: Record<string, unknown> } | { valid: false; error: NonNullable<ToolExecutionResult['error']> } {
    const validation = validateToolInput(tool, candidate);
    if (!validation.valid || validation.value === undefined) {
      return {
        valid: false,
        error: validation.error ?? { code: 'INVALID_INPUT', message: `Invalid input for ${tool.name}.`, retryable: false },
      };
    }
    const semantics = tool.validateSemantics?.(validation.value);
    if (semantics !== undefined && !semantics.valid) return { valid: false, error: semantics.error };
    const input = semantics?.value ?? validation.value;
    const digest = toolInputDigest(tool, { ...originalCall, input });
    if (digest !== originalInputDigest) {
      return {
        valid: false,
        error: {
          code: 'POLICY_DENIED',
          message: 'Tool input changed after risk evaluation.',
          retryable: false,
          details: { category: 'risk_policy', reason: 'input_changed_after_risk' },
        },
      };
    }
    return { valid: true, input };
  }

  private async observeLifecycle(
    call: ToolCall,
    context: AgentContext,
    stepId: string,
    outcome: ExecutionOutcome,
  ): Promise<LifecycleObserverResult> {
    if (this.lifecycleObservers === undefined) return { effects: [], failedObserverIds: [] };
    const tool = this.toolkit.get(call.name);
    const fact: ToolLifecycleFact = {
      schemaVersion: 1,
      runId: context.runId,
      stepId,
      toolCallId: call.id,
      toolName: call.name,
      toolKind: tool?.kind ?? 'unknown',
      source: tool === undefined ? 'unknown' : toolSource(tool) as ToolLifecycleFact['source'],
      phase: lifecyclePhase(outcome.result),
      outcome: outcome.result.status,
      inputDigest: safeInputDigest(tool, call),
      risk: {
        disposition: outcome.risk.disposition ?? (outcome.risk.requireConfirmation ? 'confirm' : 'allow'),
        severity: outcome.risk.severity,
        policyVersion: outcome.risk.policyVersion ?? 'legacy/v1',
        findingCount: outcome.risk.findings.length,
      },
      result: {
        status: outcome.result.status,
        evidenceIds: [...(outcome.result.response?.evidenceIds ?? [])],
        hasResponse: outcome.result.response !== undefined,
        ...(outcome.result.error?.code === undefined ? {} : { errorCode: outcome.result.error.code }),
        ...(outcome.result.error?.retryable === undefined ? {} : { retryable: outcome.result.error.retryable }),
      },
      startedAt: outcome.result.startedAt,
      finishedAt: outcome.result.finishedAt ?? outcome.result.startedAt,
      ...(outcome.type === 'interrupted' ? { interruptType: outcome.interrupt.interruptType } : {}),
    };
    try {
      return await this.lifecycleObservers.observe(fact);
    } catch {
      // The executor is expected to isolate observer failures. Keep the
      // pipeline fail-safe if a custom executor violates that contract.
      return { effects: [], failedObserverIds: ['lifecycle-observer-executor'] };
    }
  }

  private async resolveRisk(
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
    tool: NonNullable<ReturnType<Toolkit['get']>>,
    call: ToolCall,
    governance?: ToolBatchGovernanceSnapshot,
  ): Promise<ResolvedRisk> {
    if (this.governanceEvaluator === undefined) {
      return this.guard.inspect({ runId: context.runId, tool, toolCall: call });
    }
    const snapshot = governance ?? await this.evaluateBatchGovernance([call], context, stepId, signal);
    const profile = context.governance?.profile;
    const decision = snapshot?.decisions.find((item) => item.toolCallId === call.id);
    if (snapshot === undefined || profile === undefined || snapshot.profileDigest !== profile.digest
      || snapshot.profileRevision !== profile.revision || decision === undefined
      || decision.inputDigest !== toolInputDigest(tool, call)) {
      return {
        severity: 'CRITICAL',
        requireConfirmation: false,
        disposition: 'deny',
        policyVersion: 'risk/v2',
        findings: [{
          ruleId: 'governance.snapshot-invalid',
          severity: 'CRITICAL',
          description: '治理快照与当前工具调用不一致。',
          toolName: tool.name,
        }],
      };
    }
    return decision.decision;
  }

  private prepareExecution(
    tool: NonNullable<ReturnType<Toolkit['get']>>,
    call: ToolCall,
    context: AgentContext,
    stepId: string,
  ): Promise<ToolExecutionRecord | undefined> {
    if (this.executionJournal === undefined) return Promise.resolve(undefined);
    return this.executionJournal.prepare({
      toolCallId: call.id,
      runId: context.runId,
      stepId,
      toolName: tool.name,
      toolKind: tool.kind,
       inputDigest: toolInputDigest(tool, call),
      state: 'prepared',
      preparedAt: this.clock.now().toISOString(),
    });
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

function toolSource(tool: Tool): string {
  return tool.source
    ?? (tool.name.startsWith('mcp.') ? 'mcp' : tool.name.startsWith('subagent.') ? 'subagent' : 'builtin');
}

function toolContextDeadline(context: AgentContext): number {
  return Date.parse(context.budget.startedAt) + context.budget.maxDurationMs;
}

function lifecyclePhase(result: ToolExecutionResult): ToolLifecycleFact['phase'] {
  if (result.error?.code === 'POLICY_DENIED') return 'governance';
  if (result.error?.code === 'TOOL_NOT_FOUND'
    || result.error?.code === 'INVALID_INPUT'
    || result.error?.code === 'TOOL_ARGUMENTS_SCHEMA_INVALID'
    || result.error?.code === 'TOOL_ARGUMENTS_SEMANTIC_INVALID'
    || result.error?.code === 'TOOL_ARGUMENTS_PARSE_FAILED') return 'admission';
  if (result.status === 'interrupted' || result.status === 'awaiting_external') return 'governance';
  return result.status === 'success' || result.status === 'failed' || result.status === 'timeout'
    || result.status === 'aborted' || result.status === 'skipped' ? 'completion' : 'execution';
}

function safeInputDigest(tool: Tool | undefined, call: ToolCall): string {
  try {
    return tool === undefined ? checkpointChecksum(call.input) : toolInputDigest(tool, call);
  } catch {
    return 'unavailable';
  }
}
