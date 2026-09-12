import type { AgentContext, AgentEvent, ToolBatchGovernanceSnapshot, ToolCall, ToolExecutionResult, Clock } from '../contracts/index.js';
import { systemClock } from '../contracts/index.js';
import type { ExecutionOutcome } from './execution-types.js';
import type { SerializableInterrupt } from '../contracts/hitl.js';
import type { ToolExecutionPipeline } from './execution-pipeline.js';
import type { Toolkit } from './toolkit.js';
import { mergeAsyncGenerators } from './async-generator-multiplexer.js';
import { toolInputDigest } from './schema.js';

export interface BatchExecutionResult {
  results: ToolExecutionResult[];
  deferredActions: ToolCall[];
  interrupt?: SerializableInterrupt;
}

export interface BatchExecutionCallbacks {
  onCompleted?: (call: ToolCall, outcome: Extract<ExecutionOutcome, { type: 'completed' }>) => Promise<void>;
}

export class ToolBatchExecutor {
  public constructor(
    private readonly toolkit: Toolkit,
    private readonly pipeline: ToolExecutionPipeline,
    private readonly clock: Clock = systemClock,
  ) {}

  public async *executeStream(
    calls: ToolCall[],
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
    callbacks: BatchExecutionCallbacks = {},
  ): AsyncGenerator<AgentEvent, BatchExecutionResult> {
    const evidenceOrUtility = calls.filter((call) => this.toolkit.get(call.name)?.kind !== 'action');
    const actions = calls.filter((call) => this.toolkit.get(call.name)?.kind === 'action');
    if (evidenceOrUtility.length > 0 && actions.length > 0) {
      const batch = yield* this.executeWithoutMixedActionsStream(evidenceOrUtility, context, stepId, signal, callbacks);
      return { ...batch, deferredActions: actions };
    }
    return yield* this.executeWithoutMixedActionsStream(calls, context, stepId, signal, callbacks);
  }

  public async execute(
    calls: ToolCall[],
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
    callbacks: BatchExecutionCallbacks = {},
  ): Promise<BatchExecutionResult> {
    const stream = this.executeStream(calls, context, stepId, signal, callbacks);
    while (true) {
      const item = await stream.next();
      if (item.done) return item.value;
    }
  }

  private async *executeWithoutMixedActionsStream(
    calls: ToolCall[],
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
    callbacks: BatchExecutionCallbacks,
  ): AsyncGenerator<AgentEvent, BatchExecutionResult> {
    const governance = await this.batchGovernance(calls, context, stepId, signal);
    if (governance !== undefined && context.pendingToolBatch !== undefined) {
      context.pendingToolBatch.governance = structuredClone(governance);
    }
    const isSafe = (call: ToolCall): boolean => {
      const tool = this.toolkit.get(call.name);
      if (tool?.kind === 'action') return false;
      try { return tool?.isConcurrencySafe?.(call.input) === true; }
      catch { return false; }
    };
    const safe = calls.filter(isSafe);
    const unsafe = calls.filter((call) => !isSafe(call));
    const safeStreams = safe.map((call) => this.executeOneStream(call, context, stepId, signal, callbacks, governance));
    const outcomes: ExecutionOutcome[] = yield* mergeAsyncGenerators(safeStreams);

    for (const call of unsafe) {
      const outcome = yield* this.executeOneStream(call, context, stepId, signal, callbacks, governance);
      outcomes.push(outcome);
      if (outcome.type === 'interrupted') {
        const completed = new Set(outcomes.map((item) => item.result.toolCallId));
        for (const pending of calls.filter((item) => !completed.has(item.id))) {
          const deferred = this.failure(pending, signal);
          deferred.result.status = 'skipped';
          deferred.result.error = { code: 'TOOL_ERROR', message: 'Replan after pending interaction.', retryable: false };
          outcomes.push(deferred);
        }
        return { results: this.ordered(calls, outcomes), deferredActions: [], interrupt: outcome.interrupt };
      }
    }

    const interrupted = outcomes.find((outcome) => outcome.type === 'interrupted');
    return interrupted?.type === 'interrupted'
      ? { results: this.ordered(calls, outcomes), deferredActions: [], interrupt: interrupted.interrupt }
      : { results: this.ordered(calls, outcomes), deferredActions: [] };
  }

  private async *executeOneStream(
    call: ToolCall,
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
    callbacks: BatchExecutionCallbacks,
    governance?: ToolBatchGovernanceSnapshot,
  ): AsyncGenerator<AgentEvent, ExecutionOutcome> {
    let outcome: ExecutionOutcome;
    const terminalEvents: AgentEvent[] = [];
    const pipelineStream = this.pipeline.executeStream(call, context, stepId, signal, governance);
    let pipelineCompleted = false;
    try {
      while (true) {
        const item = await pipelineStream.next();
        if (item.done) {
          pipelineCompleted = true;
          outcome = item.value;
          break;
        }
        // A durable Harness transition is committed by onCompleted below.
        // Hold the terminal V1 item until that callback has finished so a
        // consumer cannot observe TOOL_RESULT before its state is durable.
        if (item.value.type === 'TOOL_RESULT') terminalEvents.push(item.value);
        else yield item.value;
      }
    } catch {
      outcome = this.failure(call, signal);
    } finally {
      if (!pipelineCompleted) await pipelineStream.return(undefined as never).catch(() => undefined);
    }
    if (outcome.type === 'completed') await callbacks.onCompleted?.(call, outcome);
    yield* terminalEvents;
    return outcome;
  }

  private async batchGovernance(
    calls: readonly ToolCall[],
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
  ): Promise<ToolBatchGovernanceSnapshot | undefined> {
    const persisted = context.pendingToolBatch?.governance;
    const profile = context.governance?.profile;
    if (persisted !== undefined && profile !== undefined
      && context.pendingToolBatch?.stepId === stepId
      && persisted.profileRevision === profile.revision
      && persisted.profileDigest === profile.digest
      && calls.every((call) => {
        const tool = this.toolkit.get(call.name);
        return tool !== undefined && persisted.decisions.some((decision) => (
          decision.toolCallId === call.id && decision.inputDigest === toolInputDigest(tool, call)
        ));
      })) {
      return persisted;
    }
    return this.pipeline.evaluateBatchGovernance(calls, context, stepId, signal);
  }

  private ordered(calls: ToolCall[], outcomes: ExecutionOutcome[]): ToolExecutionResult[] {
    return calls.flatMap((call) => outcomes.filter((item) => item.result.toolCallId === call.id).map((item) => item.result));
  }

  private failure(call: ToolCall, signal: AbortSignal): ExecutionOutcome {
    const now = this.clock.now().toISOString();
    return {
      type: 'completed', risk: { severity: 'SAFE', requireConfirmation: false, findings: [] },
      result: { toolCallId: call.id, toolName: call.name, status: signal.aborted ? 'aborted' : 'failed', startedAt: now, finishedAt: now,
        error: { code: signal.aborted ? 'ABORTED' : 'TOOL_ERROR', message: 'Tool pipeline failed before producing a result.', retryable: false } },
    };
  }
}
