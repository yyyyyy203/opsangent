import type { AgentContext, ToolCall, ToolExecutionResult, Clock } from '../contracts/index.js';
import { systemClock } from '../contracts/index.js';
import type { ExecutionOutcome } from './execution-types.js';
import type { SerializableInterrupt } from '../contracts/hitl.js';
import type { ToolExecutionPipeline } from './execution-pipeline.js';
import type { Toolkit } from './toolkit.js';

export interface BatchExecutionResult {
  results: ToolExecutionResult[];
  deferredActions: ToolCall[];
  interrupt?: SerializableInterrupt;
}

export class ToolBatchExecutor {
  public constructor(
    private readonly toolkit: Toolkit,
    private readonly pipeline: ToolExecutionPipeline,
    private readonly clock: Clock = systemClock,
  ) {}

  public async execute(
    calls: ToolCall[],
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
  ): Promise<BatchExecutionResult> {
    const evidenceOrUtility = calls.filter((call) => this.toolkit.get(call.name)?.kind !== 'action');
    const actions = calls.filter((call) => this.toolkit.get(call.name)?.kind === 'action');
    if (evidenceOrUtility.length > 0 && actions.length > 0) {
      const batch = await this.executeWithoutMixedActions(evidenceOrUtility, context, stepId, signal);
      return { ...batch, deferredActions: actions };
    }
    return this.executeWithoutMixedActions(calls, context, stepId, signal);
  }

  private async executeWithoutMixedActions(
    calls: ToolCall[],
    context: AgentContext,
    stepId: string,
    signal: AbortSignal,
  ): Promise<BatchExecutionResult> {
    const isSafe = (call: ToolCall): boolean => {
      const tool = this.toolkit.get(call.name);
      if (tool?.kind === 'action') return false;
      try { return tool?.isConcurrencySafe?.(call.input) === true; }
      catch { return false; }
    };
    const safe = calls.filter(isSafe);
    const unsafe = calls.filter((call) => !isSafe(call));
    const settled = await Promise.allSettled(safe.map(async (call) => this.pipeline.execute(call, context, stepId, signal)));
    const outcomes: ExecutionOutcome[] = settled.map((item, index) => {
      if (item.status === 'fulfilled') return item.value;
      const call = safe[index];
      if (!call) throw new Error('Missing scheduled call.');
      return this.failure(call, signal);
    });

    for (const call of unsafe) {
      const outcome = await this.pipeline.execute(call, context, stepId, signal).catch(() => this.failure(call, signal));
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
