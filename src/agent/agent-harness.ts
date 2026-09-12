import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  ChatModel,
  CheckpointStore,
  DurableRunState,
  Clock,
  IdGenerator,
  MessageBlock,
  ModelResponse,
  Observability,
  AgentEventPayloadMap,
  AgentEventTypeV2,
  AgentErrorCode,
  PendingAgentEventV2,
  DurableExecutionTransition,
  EventPublisherV2Dependencies,
  ToolCall,
  RawToolCall,
  ToolExecutionResult,
  ToolExecutionRecord,
  RiskSeverity,
} from '../contracts/index.js';
import { CheckpointConflictError, checkpointChecksum, createInitialRunGovernanceState, toAgentError } from '../contracts/index.js';
import type { ContextCompressor } from '../context-compressor/types.js';
import type { EventBus } from '../event/event-bus.js';
import type { EventFactory } from '../event/event-factory.js';
import type { BatchExecutionCallbacks, ToolBatchExecutor } from '../tool/batch-executor.js';
import type { Toolkit } from '../tool/toolkit.js';
import type { ToolAdmission } from '../tool/admission.js';
import { legacyRunFinishedPayload } from '../event/v1-payloads.js';
import { admitToolBatch } from './admit-tool-batch.js';
import { planPendingBatchRecovery } from './run-recovery.js';
import type { DiagnosisAgent, DiagnosisRunResult, ReplyOptions } from './types.js';

export interface AgentHarnessDependencies {
  model: ChatModel;
  toolkit: Toolkit;
  batchExecutor: ToolBatchExecutor;
  checkpoints: CheckpointStore;
  compressor: ContextCompressor;
  events: EventBus;
  eventFactory: EventFactory;
  observability: Observability;
  clock: Clock;
  ids: IdGenerator;
  admission: ToolAdmission;
  durableState?: DurableRunState;
  v2Events?: Omit<EventPublisherV2Dependencies, 'correlationId'> & {
    correlationId: string | ((runId: string) => string);
  };
}

type RunTerminalOutcome = 'completed' | 'paused' | 'failed' | 'cancelled';

interface RunExecutionFrame {
  context: AgentContext;
  finalText: string;
  activeStepId?: string;
  activeStepStartedAt?: number;
  checkpointRevision?: number;
  terminalOutcome?: RunTerminalOutcome;
  naturalExit: boolean;
}

export class AgentHarness implements DiagnosisAgent {
  public constructor(private readonly dependencies: AgentHarnessDependencies) {}

  public async reply(options: ReplyOptions): Promise<DiagnosisRunResult> {
    const stream = this.replyStream(options);
    while (true) {
      const item = await stream.next();
      if (item.done) return item.value;
    }
  }

  public async *replyStream(options: ReplyOptions): AsyncGenerator<AgentEvent, DiagnosisRunResult> {
    const frame: RunExecutionFrame = {
      context: this.createContext(options),
      finalText: '',
      naturalExit: false,
    };
    return yield* this.forwardRunStream(this.run(frame, options.signal ?? new AbortController().signal));
  }

  public async *resumeStream(runId: string, signal = new AbortController().signal): AsyncGenerator<AgentEvent, DiagnosisRunResult> {
    const loaded = await this.loadCheckpoint(runId);
    if (loaded === null) throw new Error(`Checkpoint not found: ${runId}`);
    const { context } = loaded;
    context.sessionId ??= this.dependencies.ids.next('session');
    context.replyId ??= this.dependencies.ids.next('reply');
    const newStreamId = this.dependencies.ids.next('stream');
    context.streamId = newStreamId;
    const frame: RunExecutionFrame = {
      context,
      finalText: '',
      naturalExit: false,
      ...(loaded.revision === undefined ? {} : { checkpointRevision: loaded.revision }),
    };
    await this.publishTransitionV2(frame, 'RUN_RESUMED', {
      checkpointVersion: loaded.revision === undefined
        ? String(context.contextVersion)
        : String(loaded.revision + 1),
      resumeReason: 'explicit_resume',
      newStreamId,
    });
    return yield* this.forwardRunStream(this.run(frame, signal, true));
  }

  private async *forwardRunStream(
    inner: AsyncGenerator<AgentEvent, DiagnosisRunResult>,
  ): AsyncGenerator<AgentEvent, DiagnosisRunResult> {
    let innerCompleted = false;
    try {
      while (true) {
        const item = await inner.next();
        if (item.done) {
          innerCompleted = true;
          return item.value;
        }
        yield item.value;
      }
    } catch (error) {
      if (!innerCompleted) {
        innerCompleted = true;
        await inner.return(undefined as never);
      }
      throw error;
    } finally {
      if (!innerCompleted) {
        innerCompleted = true;
        await inner.return(undefined as never);
      }
    }
  }

  private async *run(
    frame: RunExecutionFrame,
    signal: AbortSignal,
    resumed = false,
  ): AsyncGenerator<AgentEvent, DiagnosisRunResult> {
    const rootSpan = this.dependencies.observability.startSpan({
      name: 'inspection.run', kind: 'chain', runId: frame.context.runId,
      attributes: { profileId: frame.context.profileId },
    });
    try {
      if (!resumed) {
        await this.publishTransitionV2(frame, 'RUN_STARTED', {
          profile: frame.context.profileId,
          trigger: 'manual',
          deadline: new Date(Date.parse(frame.context.budget.startedAt) + frame.context.budget.maxDurationMs).toISOString(),
          versionSnapshot: {},
        });
        yield* this.publishStream('RUN_STARTED', frame.context, { profileId: frame.context.profileId });
      }

      delete frame.context.failure;
      const pausedForExternalExecution = yield* this.resumePendingToolCallStream(frame, signal);
      if (pausedForExternalExecution) {
        const result = this.result(frame.context, frame.finalText);
        frame.terminalOutcome = 'paused';
        rootSpan.end(result);
        frame.naturalExit = true;
        return result;
      }
      const pausedForRecovery = yield* this.resumePendingToolBatchStream(frame, signal);
      if (pausedForRecovery) {
        const result = this.result(frame.context, frame.finalText);
        frame.terminalOutcome = 'paused';
        rootSpan.end(result);
        frame.naturalExit = true;
        return result;
      }
      return yield* this.mainLoop(frame, signal, rootSpan);
    } catch (error) {
      const context = frame.context;
      context.status = signal.aborted ? 'cancelled' : 'failed';
      const failure = signal.aborted
        ? { code: 'ABORTED' as const, message: 'Agent run aborted.', retryable: false }
        : toAgentError(asDurableAgentError(error));
      context.failure = failure;
      frame.terminalOutcome = context.status;
      const failureCategory = typeof failure.details?.category === 'string' ? failure.details.category : undefined;
      if (frame.activeStepId !== undefined && context.budget.iteration > 0) {
        await this.publishV2('STEP_FAILED', context, {
          iteration: context.budget.iteration,
          error: eventError(failure),
          retryable: failure.retryable,
        }, frame.activeStepId);
      }
      const failurePayload = {
        error: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          ...(failureCategory === undefined ? {} : { details: { category: failureCategory } }),
        },
        stage: context.stage,
        recoverable: failure.retryable,
      };
      try {
        await this.publishTransitionV2(frame, 'RUN_FAILED', failurePayload);
      } catch (failureCommitError) {
        if (this.dependencies.durableState === undefined || !(failureCommitError instanceof CheckpointConflictError)) throw failureCommitError;
        const latest = await this.dependencies.durableState.checkpoints.load(context.runId);
        if (latest === null) throw failureCommitError;
        frame.context = latest.context;
        frame.context.status = signal.aborted ? 'cancelled' : 'failed';
        frame.context.failure = failure;
        frame.checkpointRevision = latest.revision;
        await this.publishTransitionV2(frame, 'RUN_FAILED', {
          ...failurePayload,
          stage: frame.context.stage,
        });
      }
      rootSpan.fail(error);
      yield* this.publishStream('RUN_FAILED', frame.context, {
        message: failure.message,
        code: failure.code,
        retryable: failure.retryable,
        ...(failureCategory === undefined ? {} : { category: failureCategory }),
      });
      frame.naturalExit = true;
      if (error instanceof CheckpointConflictError) throw error;
      return this.result(frame.context, frame.finalText);
    } finally {
      if (!frame.naturalExit && frame.terminalOutcome === undefined) {
        const context = frame.context;
        const cancellation = { code: 'ABORTED' as const, message: 'Agent stream consumer closed.', retryable: false };
        context.status = 'cancelled';
        context.failure = cancellation;
        frame.terminalOutcome = 'cancelled';
        rootSpan.fail(cancellation);
        await this.publishTransitionV2(frame, 'RUN_CANCELLED', {
          actor: 'stream_consumer',
          reason: 'stream_consumer_closed',
          stage: context.stage,
        });
      }
      try {
        await this.saveCheckpoint(frame);
      } finally {
        await this.dependencies.observability.flush();
      }
    }
  }

  private async *mainLoop(
    frame: RunExecutionFrame,
    signal: AbortSignal,
    rootSpan: { end(output?: unknown): void; fail(error: unknown): void },
  ): AsyncGenerator<AgentEvent, DiagnosisRunResult> {
    while (frame.context.budget.iteration < frame.context.budget.maxIterations) {
      const context = frame.context;
      if (signal.aborted) throw new Error('Agent run aborted.');
      if (this.dependencies.clock.now().getTime() - Date.parse(context.budget.startedAt) >= context.budget.maxDurationMs) {
        throw new Error('Agent run duration budget exhausted.');
      }

      const before = Buffer.byteLength(JSON.stringify(context.messages), 'utf8');
      const compressed = await this.dependencies.compressor.compress(context);
      frame.context = compressed.context;
      if (compressed.decision.level !== 'none') {
        const compressionPayload = {
          level: compressed.decision.level,
          before,
          after: Buffer.byteLength(JSON.stringify(frame.context.messages), 'utf8'),
          offloadedEvidenceIds: [],
          savedTokens: 0,
        };
        await this.publishV2('CONTEXT_COMPRESSED', frame.context, compressionPayload);
        yield* this.publishStream('CONTEXT_COMPRESSED', frame.context, compressionPayload);
      }

      frame.context.budget.iteration += 1;
      const stepId = this.dependencies.ids.next('step');
      frame.activeStepId = stepId;
      frame.activeStepStartedAt = this.dependencies.clock.now().getTime();
      await this.publishV2('STEP_STARTED', frame.context, {
        iteration: frame.context.budget.iteration,
        stage: frame.context.stage,
        budgetSnapshot: { toolCallsUsed: frame.context.budget.toolCallsUsed },
      }, stepId);
      yield* this.publishStream('STEP_STARTED', frame.context, { iteration: frame.context.budget.iteration }, stepId);
      await this.publishV2('REASONING_STARTED', frame.context, {
        stage: frame.context.stage,
        objective: `inspection:${frame.context.profileId}`,
      }, stepId);
      yield* this.publishStream('REASONING_STARTED', frame.context, { stage: frame.context.stage }, stepId);

      const response = yield* this.reasonStream(frame.context, stepId, signal);
      const candidates: Array<ToolCall | RawToolCall> = [...response.toolCalls, ...(response.rawToolCalls ?? [])];
      const seenIds = new Set(frame.context.messages.flatMap((message) => message.blocks.flatMap((block) =>
        block.type === 'tool_call' || block.type === 'raw_tool_call' ? [block.call.id] : [])));
      if (candidates.length > 32) throw new Error('Model tool batch exceeds admission limit.');
      for (const candidate of candidates) {
        if (!candidate.id || seenIds.has(candidate.id)) throw new Error('Model returned a missing or duplicate tool call ID.');
        seenIds.add(candidate.id);
      }
      if (response.text !== undefined) frame.finalText += response.text;
      if (candidates.length === 0) {
        this.appendToolExchange(frame.context, response.text, candidates, []);
        frame.context.status = 'completed';
        const stepDuration = this.stepDuration(frame.activeStepStartedAt);
        await this.publishV2('STEP_COMPLETED', frame.context, {
          iteration: frame.context.budget.iteration,
          exitDecision: 'complete',
          durationMs: stepDuration,
        }, stepId);
        delete frame.activeStepId;
        delete frame.activeStepStartedAt;
        const finishPayload = {
          outcome: 'complete' as const,
          finalText: frame.finalText,
          durationMs: this.elapsed(frame.context),
        };
        await this.publishTransitionV2(frame, 'RUN_FINISHED', finishPayload);
        frame.terminalOutcome = 'completed';
        const result = this.result(frame.context, frame.finalText);
        rootSpan.end(result);
        yield* this.publishStream('RUN_FINISHED', frame.context, legacyRunFinishedPayload(finishPayload));
        frame.naturalExit = true;
        return result;
      }

      if (this.dependencies.v2Events === undefined) {
        for (const call of candidates) {
          yield* this.publishStream('TOOL_CALL_CREATED', frame.context, { id: call.id, name: call.name }, stepId);
        }
      }
      const admission = admitToolBatch(candidates, frame.context, this.dependencies.admission, this.dependencies.clock, signal);
      for (const repair of admission.repairs) {
        const repairPayload = { toolCallId: repair.toolCallId, stage: repair.stage, repairs: repair.repairs };
        if (this.dependencies.v2Events === undefined) yield* this.publishStream('TOOL_PROGRESS', frame.context, repairPayload, stepId);
        await this.publishV2('TOOL_CALL_REPAIR_COMPLETED', frame.context, {
          strategy: 'json_syntax_repair', changedPaths: repair.repairs, attempt: 1,
        }, stepId, repair.toolCallId);
        if (this.dependencies.v2Events !== undefined) yield* this.publishStream('TOOL_PROGRESS', frame.context, repairPayload, stepId);
      }
      for (const gate of admission.gates) {
        for (const record of gate.records) {
          await this.publishV2('TOOL_CALL_ADMISSION_UPDATED', frame.context, {
            gate: record.gate,
            outcome: record.outcome,
            attempt: 1,
            ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
          }, stepId, gate.toolCallId);
        }
      }
      for (const call of admission.calls) {
        await this.publishV2('TOOL_CALL_CREATED', frame.context, { call }, stepId, call.id);
        if (this.dependencies.v2Events !== undefined) {
          yield* this.publishStream('TOOL_CALL_CREATED', frame.context, { id: call.id, name: call.name }, stepId);
        }
      }
      if (admission.calls.length > 0) {
        this.openPendingBatch(frame, admission.calls, stepId);
        if (this.dependencies.durableState !== undefined) await this.saveCheckpoint(frame);
      }
      const batch = yield* this.dependencies.batchExecutor.executeStream(
        admission.calls,
        frame.context,
        stepId,
        signal,
        this.completionCallbacks(frame),
      );
      const results = [...admission.rejected, ...batch.results];
      for (const deferred of batch.deferredActions) results.push(this.deferredResult(deferred));
      for (const result of results) await this.persistUnjournaledResult(frame, result);
      const orderedResults = candidates.flatMap((candidate) => results.filter((result) => result.toolCallId === candidate.id));
      this.appendToolExchange(frame.context, response.text, candidates, orderedResults);

      if (batch.interrupt !== undefined) {
        frame.context.status = batch.interrupt.interruptType === 'external_tool_execution' ? 'paused' : 'awaiting_confirmation';
        frame.context.pendingInterrupt = batch.interrupt;
        frame.context.pendingToolCalls = admission.calls.filter((call) => call.id === batch.interrupt?.toolCallId);
        if (frame.context.pendingToolBatch !== undefined) {
          frame.context.pendingToolBatch.state = batch.interrupt.interruptType === 'external_tool_execution'
            ? 'awaiting_external'
            : 'awaiting_confirmation';
        }
        frame.context.contextVersion += 1;
        yield* this.publishAdmissionRejectionsStream(frame, admission.rejected, stepId);
        const expiresAt = batch.interrupt.expiresAt ?? new Date(this.dependencies.clock.now().getTime() + 300_000).toISOString();
        if (frame.context.status === 'awaiting_confirmation') {
          const risk = interruptRisk(batch.interrupt);
          const confirmation = {
            confirmationId: `confirmation:${frame.context.runId}:${batch.interrupt.toolCallId}`,
            toolCallIds: [batch.interrupt.toolCallId], riskSummary: `风险等级：${risk}`, expiresAt,
          };
          await this.publishV2('RISK_EVALUATED', frame.context, { findings: [], mergedRisk: risk, policyVersion: 'risk-v1' }, stepId, batch.interrupt.toolCallId);
          await this.publishV2('CONFIRMATION_REQUESTED', frame.context, confirmation, stepId, batch.interrupt.toolCallId);
          yield* this.publishStream('REQUIRE_CONFIRM', frame.context, this.dependencies.v2Events === undefined ? batch.interrupt : confirmation, stepId);
        } else {
          const external = {
            requestId: `external:${frame.context.runId}:${batch.interrupt.toolCallId}`,
            toolCallId: batch.interrupt.toolCallId,
            interactionPayload: { type: 'external_tool_execution', toolCallId: batch.interrupt.toolCallId },
            expiresAt,
          };
          await this.publishV2('EXTERNAL_EXECUTION_REQUESTED', frame.context, external, stepId, batch.interrupt.toolCallId);
          if (this.dependencies.v2Events !== undefined) yield* this.publishStream('EXTERNAL_TOOL_REQUESTED', frame.context, external, stepId);
        }
        await this.publishTransitionV2(frame, 'RUN_PAUSED', {
          interruptId: batch.interrupt.hookId,
          reason: batch.interrupt.interruptType,
          expiresAt,
          checkpointVersion: this.nextCheckpointVersion(frame),
        }, stepId);
        await this.publishV2('STEP_COMPLETED', frame.context, {
          iteration: frame.context.budget.iteration,
          exitDecision: frame.context.status === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'external_execution',
          durationMs: this.stepDuration(frame.activeStepStartedAt),
        }, stepId);
        delete frame.activeStepId;
        delete frame.activeStepStartedAt;
        frame.terminalOutcome = 'paused';
        const result = this.result(frame.context, frame.finalText);
        rootSpan.end(result);
        yield* this.publishStream('RUN_PAUSED', frame.context, { reason: batch.interrupt.interruptType }, stepId);
        frame.naturalExit = true;
        return result;
      }

      frame.context.pendingToolCalls = [];
      delete frame.context.pendingToolBatch;
      frame.context.contextVersion += 1;
      const nextStage = this.nextStage(admission.calls);
      if (nextStage !== frame.context.stage) {
        const previousStage = frame.context.stage;
        frame.context.stage = nextStage;
        await this.publishV2('STAGE_CHANGED', frame.context, { from: previousStage, to: nextStage, reason: 'tool_batch_completed' }, stepId);
      }
      await this.saveCheckpoint(frame);
      yield* this.publishAdmissionRejectionsStream(frame, admission.rejected, stepId);
      await this.publishV2('STEP_COMPLETED', frame.context, {
        iteration: frame.context.budget.iteration,
        exitDecision: 'continue',
        durationMs: this.stepDuration(frame.activeStepStartedAt),
      }, stepId);
      delete frame.activeStepId;
      delete frame.activeStepStartedAt;
    }
    throw new Error('Agent iteration budget exhausted.');
  }

  private async *resumePendingToolCallStream(frame: RunExecutionFrame, signal: AbortSignal): AsyncGenerator<AgentEvent, boolean> {
    let context = frame.context;
    if (context.pendingToolCalls.length === 0) return false;
    if (context.pendingInterrupt?.interruptType === 'external_tool_execution') return true;
    const pending = context.pendingToolCalls[0];
    if (pending === undefined || !context.confirmedToolCallIds.includes(pending.id)) return false;

    const stepId = context.pendingToolBatch?.stepId ?? this.dependencies.ids.next('step');
    const batch = yield* this.dependencies.batchExecutor.executeStream(
      [pending],
      context,
      stepId,
      signal,
      this.completionCallbacks(frame),
    );
    context = frame.context;
    if (batch.interrupt !== undefined) {
      if (batch.interrupt.interruptType !== 'external_tool_execution') {
        throw new Error(`Confirmed tool call was interrupted again: ${pending.id}`);
      }
      this.replaceToolResult(context, batch.results[0] ?? this.deferredResult(pending));
      context.pendingInterrupt = batch.interrupt;
      context.status = 'paused';
      if (context.pendingToolBatch !== undefined) context.pendingToolBatch.state = 'awaiting_external';
      context.contextVersion += 1;
      const expiresAt = batch.interrupt.expiresAt ?? new Date(this.dependencies.clock.now().getTime() + 300_000).toISOString();
      const external = {
        requestId: `external:${context.runId}:${batch.interrupt.toolCallId}`,
        toolCallId: batch.interrupt.toolCallId,
        interactionPayload: { type: 'external_tool_execution', toolCallId: batch.interrupt.toolCallId },
        expiresAt,
      };
      await this.publishV2('EXTERNAL_EXECUTION_REQUESTED', context, external, stepId, batch.interrupt.toolCallId);
      if (this.dependencies.v2Events !== undefined) yield* this.publishStream('EXTERNAL_TOOL_REQUESTED', context, external, stepId);
      await this.publishTransitionV2(frame, 'RUN_PAUSED', {
        interruptId: batch.interrupt.hookId,
        reason: 'external_tool_execution',
        expiresAt,
        checkpointVersion: this.nextCheckpointVersion(frame),
      }, stepId);
      yield* this.publishStream('RUN_PAUSED', context, { reason: 'external_tool_execution' }, stepId);
      return true;
    }
    const result = batch.results[0];
    if (result === undefined) throw new Error(`Confirmed tool call produced no result: ${pending.id}`);
    this.replaceToolResult(context, result);
    context.pendingToolCalls = [];
    delete context.pendingInterrupt;
    context.status = 'running';
    context.stage = 'verification';
    context.contextVersion += 1;
    await this.saveCheckpoint(frame);
    return false;
  }

  private async *resumePendingToolBatchStream(
    frame: RunExecutionFrame,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, boolean> {
    const durable = this.dependencies.durableState;
    let context = frame.context;
    const pending = context.pendingToolBatch;
    if (durable === undefined || pending === undefined || context.pendingInterrupt !== undefined) return false;

    const plan = await planPendingBatchRecovery({
      context,
      toolkit: this.dependencies.toolkit,
      executions: durable.executions,
      now: this.dependencies.clock.now().toISOString(),
    });
    if (plan.type === 'none') return false;
    if (plan.type === 'storage_error') throw Object.assign(new Error(plan.error.message), plan.error);

    for (const completed of plan.completed) {
      const committed = await this.persistCompletedOutcome(frame, undefined, completed.result, completed.execution);
      context = frame.context;
      if (committed) yield* this.publishStream('TOOL_RESULT', context, completed.result, pending.stepId);
    }

    if (plan.type === 'uncertain') {
      const wasPrepared = plan.execution.state === 'prepared';
      context.status = 'paused';
      context.pendingToolCalls = [];
      const missing = `recovery_verification:${plan.call.id}`;
      if (!context.missingEvidence.includes(missing)) context.missingEvidence.push(missing);
      context.contextVersion += 1;
      if (wasPrepared) {
        await this.publishTransitionV2(frame, 'EXTERNAL_EXECUTION_UNCERTAIN', {
          requestId: `external:${context.runId}:${plan.call.id}`,
          reason: 'prepared_action_recovery',
          requiredVerification: 'Verify the external action state before any retry.',
        }, pending.stepId, plan.call.id, { kind: 'uncertain', record: plan.execution, reasonCode: 'prepared_action_recovery' });
      }
      yield* this.publishRecoveredPause(frame, pending.stepId, `recovery-uncertain-${plan.call.id}`, 'external_execution_uncertain');
      return true;
    }

    if (plan.type === 'verification_required') {
      context.status = 'paused';
      context.pendingToolCalls = [];
      const missing = `recovery_verification:${plan.call.id}`;
      if (!context.missingEvidence.includes(missing)) context.missingEvidence.push(missing);
      context.contextVersion += 1;
      yield* this.publishRecoveredPause(frame, pending.stepId, `recovery-verify-${plan.call.id}`, 'recovery_verification_required');
      return true;
    }

    if (plan.type === 'execute') {
      const batch = yield* this.dependencies.batchExecutor.executeStream(
        plan.calls,
        context,
        pending.stepId,
        signal,
        this.completionCallbacks(frame),
      );
      for (const result of batch.results) await this.persistUnjournaledResult(frame, result);
      if (batch.interrupt !== undefined) {
        context.status = batch.interrupt.interruptType === 'external_tool_execution' ? 'paused' : 'awaiting_confirmation';
        context.pendingInterrupt = batch.interrupt;
        context.pendingToolCalls = [plan.calls.find((call) => call.id === batch.interrupt?.toolCallId) ?? plan.calls[0]].filter(
          (call): call is ToolCall => call !== undefined,
        );
        const pendingBatch = context.pendingToolBatch;
        if (pendingBatch === undefined) throw new Error(`Recovered batch disappeared: ${context.runId}`);
        pendingBatch.state = batch.interrupt.interruptType === 'external_tool_execution'
          ? 'awaiting_external'
          : 'awaiting_confirmation';
        context.contextVersion += 1;
        yield* this.publishRecoveredPause(frame, pending.stepId, batch.interrupt.hookId, batch.interrupt.interruptType);
        return true;
      }
    }

    this.completeRecoveredBatch(frame);
    await this.saveCheckpoint(frame);
    return false;
  }

  private async *publishRecoveredPause(
    frame: RunExecutionFrame,
    stepId: string,
    interruptId: string,
    reason: string,
  ): AsyncGenerator<AgentEvent, void> {
    const expiresAt = new Date(this.dependencies.clock.now().getTime() + 300_000).toISOString();
    await this.publishTransitionV2(frame, 'RUN_PAUSED', {
      interruptId,
      reason,
      expiresAt,
      checkpointVersion: this.nextCheckpointVersion(frame),
    }, stepId);
    yield* this.publishStream('RUN_PAUSED', frame.context, { reason }, stepId);
  }

  private openPendingBatch(frame: RunExecutionFrame, calls: ToolCall[], stepId: string): void {
    frame.context.pendingToolBatch = {
      batchId: this.dependencies.ids.next('batch'),
      stepId,
      calls: structuredClone(calls),
      completedResults: [],
      state: 'admitted',
      createdAt: this.dependencies.clock.now().toISOString(),
    };
    frame.context.pendingToolCalls = structuredClone(calls);
    frame.context.contextVersion += 1;
  }

  private completionCallbacks(frame: RunExecutionFrame): BatchExecutionCallbacks {
    if (this.dependencies.durableState === undefined) return {};
    let tail: Promise<void> = Promise.resolve();
    return {
      onCompleted: (call, outcome) => {
        const completion = tail.then(async () => {
          await this.persistCompletedOutcome(frame, call, outcome.result, outcome.execution);
        });
        tail = completion.then(() => undefined, () => undefined);
        return completion;
      },
    };
  }

  private async persistUnjournaledResult(frame: RunExecutionFrame, result: ToolExecutionResult): Promise<void> {
    const pending = frame.context.pendingToolBatch;
    if (pending === undefined || !pending.calls.some((call) => call.id === result.toolCallId)) return;
    if (!isTerminalBatchResult(result)) return;
    if (pending.completedResults.some((candidate) => candidate.toolCallId === result.toolCallId)) return;
    await this.persistCompletedOutcome(frame, undefined, result);
  }

  private async persistCompletedOutcome(
    frame: RunExecutionFrame,
    call: ToolCall | undefined,
    result: ToolExecutionResult,
    execution?: ToolExecutionRecord,
  ): Promise<boolean> {
    const pending = frame.context.pendingToolBatch;
    if (pending === undefined || !pending.calls.some((candidate) => candidate.id === result.toolCallId)) return false;
    if (call !== undefined && (call.id !== result.toolCallId || call.name !== result.toolName)) {
      throw new Error(`Batch callback result does not match call: ${result.toolCallId}`);
    }
    const existing = pending.completedResults.find((candidate) => candidate.toolCallId === result.toolCallId);
    if (existing !== undefined) {
      if (checkpointChecksum(existing) !== checkpointChecksum(result)) {
        throw new Error(`Tool result conflicts with pending batch: ${result.toolCallId}`);
      }
      return false;
    }
    const durable = this.dependencies.durableState;
    if (durable === undefined) return false;
    if (execution !== undefined) {
      await this.publishTransitionV2(
        frame,
        'TOOL_RESULT',
        toolResultPayload(result),
        pending.stepId,
        result.toolCallId,
        { kind: 'completed', record: execution, result },
      );
      return true;
    }
    this.appendPendingResult(frame.context, result);
    await this.publishTransitionV2(frame, 'TOOL_RESULT', toolResultPayload(result), pending.stepId, result.toolCallId);
    return true;
  }

  private async *publishAdmissionRejectionsStream(
    frame: RunExecutionFrame,
    results: readonly ToolExecutionResult[],
    stepId: string,
  ): AsyncGenerator<AgentEvent, void> {
    for (const result of results) {
      await this.publishV2('TOOL_CALL_REJECTED', frame.context, {
        toolName: result.toolName,
        gate: gateForError(result.error?.code),
        error: eventError(result.error),
      }, stepId, result.toolCallId);
      await this.publishTransitionV2(frame, 'TOOL_RESULT', toolResultPayload(result), stepId, result.toolCallId);
      yield* this.publishStream('TOOL_RESULT', frame.context, result, stepId);
    }
  }

  private appendPendingResult(context: AgentContext, result: ToolExecutionResult): void {
    const pending = context.pendingToolBatch;
    if (pending === undefined) return;
    const call = pending.calls.find((candidate) => candidate.id === result.toolCallId);
    if (call === undefined || call.name !== result.toolName) {
      throw new Error(`Tool result does not belong to pending batch: ${result.toolCallId}`);
    }
    const existing = pending.completedResults.find((candidate) => candidate.toolCallId === result.toolCallId);
    if (existing !== undefined) {
      if (checkpointChecksum(existing) !== checkpointChecksum(result)) {
        throw new Error(`Tool result conflicts with pending batch: ${result.toolCallId}`);
      }
      return;
    }
    pending.completedResults.push(structuredClone(result));
  }

  private completeRecoveredBatch(frame: RunExecutionFrame): void {
    const pending = frame.context.pendingToolBatch;
    if (pending === undefined) return;
    if (pending.completedResults.length !== pending.calls.length) {
      throw new Error(`Recovered batch is incomplete: ${pending.batchId}`);
    }
    this.appendToolExchange(frame.context, undefined, pending.calls, pending.completedResults);
    frame.context.pendingToolCalls = [];
    delete frame.context.pendingInterrupt;
    delete frame.context.pendingToolBatch;
    frame.context.status = 'running';
    const nextStage = this.nextStage(pending.calls);
    if (nextStage !== frame.context.stage) frame.context.stage = nextStage;
    frame.context.contextVersion += 1;
  }

  private async saveCheckpoint(frame: RunExecutionFrame): Promise<void> {
    const durable = this.dependencies.durableState;
    if (durable === undefined) {
      await this.dependencies.checkpoints.save(frame.context);
      return;
    }
    const saved = await durable.checkpoints.save(frame.context, frame.checkpointRevision ?? null);
    frame.checkpointRevision = saved.revision;
  }

  private async loadCheckpoint(runId: string): Promise<{ context: AgentContext; revision?: number } | null> {
    const durable = this.dependencies.durableState;
    if (durable === undefined) {
      const context = await this.dependencies.checkpoints.load(runId);
      return context === null ? null : { context };
    }
    const checkpoint = await durable.checkpoints.load(runId);
    return checkpoint === null ? null : { context: checkpoint.context, revision: checkpoint.revision };
  }

  private requireCheckpointRevision(frame: RunExecutionFrame): number {
    if (frame.checkpointRevision === undefined) throw new Error(`Missing durable checkpoint revision: ${frame.context.runId}`);
    return frame.checkpointRevision;
  }

  private nextCheckpointVersion(frame: RunExecutionFrame): string {
    return frame.checkpointRevision === undefined
      ? String(frame.context.contextVersion)
      : String(frame.checkpointRevision + 1);
  }

  private replaceToolResult(context: AgentContext, replacement: ToolExecutionResult): void {
    for (const message of context.messages) {
      message.blocks = message.blocks.map((block) => (
        block.type === 'tool_result' && block.result.toolCallId === replacement.toolCallId
          ? { type: 'tool_result' as const, result: replacement }
          : block
      ));
    }
  }

  private async *reasonStream(context: AgentContext, stepId: string, signal: AbortSignal): AsyncGenerator<AgentEvent, ModelResponse> {
    const span = this.dependencies.observability.startSpan({
      name: 'model.reasoning', kind: 'llm', runId: context.runId, stepId,
      attributes: { stage: context.stage, iteration: context.budget.iteration },
    });
    const deadline = Date.parse(context.budget.startedAt) + context.budget.maxDurationMs;
    const stream = this.dependencies.model.stream(context.messages, this.dependencies.toolkit.list(), {
      signal,
      runId: context.runId,
      stepId,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.replyId === undefined ? {} : { replyId: context.replyId }),
      ...(context.streamId === undefined ? {} : { streamId: context.streamId }),
      deadline,
    });
    let completed = false;
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) {
          completed = true;
          span.end({ toolCallCount: item.value.toolCalls.length + (item.value.rawToolCalls?.length ?? 0), usage: item.value.usage });
          return item.value;
        }
        if (item.value.type === 'text_delta') yield* this.publishStream('TEXT_DELTA', context, { delta: item.value.delta }, stepId);
      }
    } catch (error) {
      span.fail(error);
      throw error;
    } finally {
      if (!completed) await stream.return(undefined as unknown as ModelResponse).catch(() => undefined);
    }
  }

  private createContext(options: ReplyOptions): AgentContext {
    const now = this.dependencies.clock.now().toISOString();
    const runId = options.runId ?? this.dependencies.ids.next('run');
    const userMessage: AgentMessage = {
      id: this.dependencies.ids.next('msg'), role: 'user', createdAt: now,
      blocks: [{ type: 'text', text: options.message }],
    };
    return {
      runId,
      sessionId: options.sessionId ?? this.dependencies.ids.next('session'),
      replyId: options.replyId ?? this.dependencies.ids.next('reply'),
      streamId: this.dependencies.ids.next('stream'),
      status: 'running',
      stage: 'triage',
      profileId: options.profileId,
      messages: [userMessage],
      pendingToolCalls: [],
      confirmedToolCallIds: [],
      rejectedToolCallIds: [],
      executedActions: [],
      evidenceIds: [],
      missingEvidence: [],
      budget: {
        startedAt: now,
        maxIterations: options.maxIterations ?? 15,
        iteration: 0,
        maxToolCalls: options.maxToolCalls ?? 20,
        toolCallsUsed: 0,
        maxDurationMs: options.maxDurationMs ?? 120_000,
      },
      contextVersion: 1,
      governance: createInitialRunGovernanceState({ profileId: options.profileId, capturedAt: now }),
    };
  }

  private result(context: AgentContext, finalText: string): DiagnosisRunResult {
    return {
      runId: context.runId,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.replyId === undefined ? {} : { replyId: context.replyId }),
      ...(context.streamId === undefined ? {} : { streamId: context.streamId }),
      status: context.status,
      finalText,
      contextVersion: context.contextVersion,
    };
  }

  private appendToolExchange(
    context: AgentContext,
    text: string | undefined,
    calls: Array<ToolCall | RawToolCall>,
    results: ToolExecutionResult[],
  ): void {
    const now = this.dependencies.clock.now().toISOString();
    const blocks: MessageBlock[] = [];
    if (text !== undefined && text.length > 0) blocks.push({ type: 'text', text });
    blocks.push(...calls.map((call) => 'arguments' in call
      ? { type: 'raw_tool_call' as const, call }
      : { type: 'tool_call' as const, call }));
    context.messages.push({
      id: this.dependencies.ids.next('msg'), role: 'assistant', createdAt: now,
      blocks,
    });
    for (const result of results) {
      context.messages.push({
        id: this.dependencies.ids.next('msg'), role: 'tool', createdAt: now,
        blocks: [{ type: 'tool_result', result }],
      });
    }
  }

  private deferredResult(call: ToolCall): ToolExecutionResult {
    const now = this.dependencies.clock.now().toISOString();
    return {
      toolCallId: call.id,
      toolName: call.name,
      status: 'skipped',
      response: { blocks: [{ type: 'json', value: { reason: 'replan_after_evidence' } }] },
      startedAt: now,
      finishedAt: now,
    };
  }

  private nextStage(calls: ToolCall[]): AgentContext['stage'] {
    return calls.some((call) => this.dependencies.toolkit.get(call.name)?.kind === 'action')
      ? 'verification'
      : 'hypothesis';
  }

  private async *publishStream(
    type: AgentEvent['type'],
    context: AgentContext,
    payload: AgentEvent['payload'],
    stepId?: string,
  ): AsyncGenerator<AgentEvent, void> {
    const event = this.dependencies.eventFactory.create(type, context.runId, payload, stepId);
    if (this.dependencies.v2Events === undefined) await this.dependencies.events.publish(event);
    yield event;
  }

  private publishV2<T extends AgentEventTypeV2>(
    type: T,
    context: AgentContext,
    payload: AgentEventPayloadMap[T],
    stepId?: string,
    toolCallId?: string,
  ): Promise<void> {
    const v2 = this.dependencies.v2Events;
    if (v2 === undefined) return Promise.resolve();
    const pending = this.createPendingV2(type, context, payload, stepId, toolCallId);
    return v2.publisher.publish(pending).then(() => undefined);
  }

  /**
   * Commits a state-coupled durable fact and only then dispatches its outbox
   * row. The generator-facing V1 event is yielded by the caller after this
   * promise resolves, so both delivery paths observe the committed state.
   */
  private async publishTransitionV2<T extends AgentEventTypeV2>(
    frame: RunExecutionFrame,
    type: T,
    payload: AgentEventPayloadMap[T],
    stepId?: string,
    toolCallId?: string,
    execution?: DurableExecutionTransition,
  ): Promise<void> {
    const durable = this.dependencies.durableState;
    const v2 = this.dependencies.v2Events;
    if (durable === undefined) {
      if (v2 !== undefined) await v2.publisher.publish(this.createPendingV2(type, frame.context, payload, stepId, toolCallId));
      return;
    }

    const pending = v2 === undefined
      ? undefined
      : this.createPendingV2(type, frame.context, payload, stepId, toolCallId);
    const dispatcher = v2?.dispatcher;
    if (pending !== undefined && dispatcher === undefined) {
      throw new Error(`Durable V2 event dispatcher is not configured: ${type}`);
    }
    const saved = await durable.transitions.commit({
      expectedRevision: frame.checkpointRevision ?? null,
      context: frame.context,
      ...(execution === undefined ? {} : { execution }),
      outboxEvents: pending === undefined ? [] : [pending],
    });
    frame.context = saved.context;
    frame.checkpointRevision = saved.revision;
    if (pending !== undefined && dispatcher !== undefined) await dispatcher.drainRun(frame.context.runId);
  }

  private createPendingV2<T extends AgentEventTypeV2>(
    type: T,
    context: AgentContext,
    payload: AgentEventPayloadMap[T],
    stepId?: string,
    toolCallId?: string,
  ): PendingAgentEventV2<T> {
    const v2 = this.dependencies.v2Events;
    if (v2 === undefined) throw new Error(`V2 event dependencies are not configured: ${type}`);
    return v2.factory.create(type, {
      runId: context.runId,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.replyId === undefined ? {} : { replyId: context.replyId }),
      ...(context.streamId === undefined ? {} : { streamId: context.streamId }),
      correlationId: typeof v2.correlationId === 'function' ? v2.correlationId(context.runId) : v2.correlationId,
      visibility: type.startsWith('RUN_') || type.startsWith('STEP_') || type === 'REASONING_STARTED' ? 'public' : 'audit',
      durability: 'durable',
      ...(stepId === undefined ? {} : { stepId }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
    }, payload);
  }

  private elapsed(context: AgentContext): number {
    return Math.max(0, this.dependencies.clock.now().getTime() - Date.parse(context.budget.startedAt));
  }

  private stepDuration(startedAt: number | undefined): number {
    return startedAt === undefined ? 0 : Math.max(0, this.dependencies.clock.now().getTime() - startedAt);
  }
}

function eventError(error: ToolExecutionResult['error']): { code: NonNullable<ToolExecutionResult['error']>['code']; message: string; retryable: boolean } {
  return error === undefined ? { code: 'TOOL_ERROR', message: 'Tool call rejected.', retryable: false } : {
    code: error.code, message: error.message, retryable: error.retryable,
  };
}

function gateForError(code: AgentErrorCode | undefined): 'tool_existence' | 'json_parse' | 'schema_validation' | 'semantic_validation' {
  switch (code) {
    case 'TOOL_NOT_FOUND': return 'tool_existence';
    case 'TOOL_ARGUMENTS_PARSE_FAILED': return 'json_parse';
    case 'TOOL_ARGUMENTS_SEMANTIC_INVALID': return 'semantic_validation';
    default: return 'schema_validation';
  }
}

function toolResultPayload(result: ToolExecutionResult): AgentEventPayloadMap['TOOL_RESULT'] {
  const started = Date.parse(result.startedAt);
  const finished = result.finishedAt === undefined ? started : Date.parse(result.finishedAt);
  return { result, durationMs: Math.max(0, finished - started), evidenceIds: result.response?.evidenceIds ?? [] };
}

function interruptRisk(interrupt: { payload: Record<string, unknown> }): RiskSeverity {
  const value = interrupt.payload.severity;
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL' ? value : 'SAFE';
}

function isTerminalBatchResult(result: ToolExecutionResult): boolean {
  return result.status !== 'interrupted' && result.status !== 'awaiting_external';
}

function asDurableAgentError(error: unknown): unknown {
  if (error instanceof CheckpointConflictError) {
    return {
      code: 'STORAGE_ERROR' as const,
      message: error.message,
      retryable: false,
      details: { category: error.category },
    };
  }
  return error;
}
