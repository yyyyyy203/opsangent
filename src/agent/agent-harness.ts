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
  GovernanceEffect,
  HookRegistryLike,
  ProfileResolver,
  ToolCall,
  RawToolCall,
  ToolExecutionResult,
  ToolExecutionRecord,
  RiskSeverity,
} from '../contracts/index.js';
import { CheckpointConflictError, checkpointChecksum, createInitialRunGovernanceState, toAgentError } from '../contracts/index.js';
import type { CompressionResult, ContextCompressor } from '../context-compressor/types.js';
import type { EventBus } from '../event/event-bus.js';
import type { EventFactory } from '../event/event-factory.js';
import type { BatchExecutionCallbacks, ToolBatchExecutor } from '../tool/batch-executor.js';
import type { Toolkit } from '../tool/toolkit.js';
import type { ToolAdmission } from '../tool/admission.js';
import { legacyRunFinishedPayload } from '../event/v1-payloads.js';
import { admitToolBatch } from './admit-tool-batch.js';
import { planPendingBatchRecovery } from './run-recovery.js';
import { toolInputDigest } from '../tool/schema.js';
import type { DiagnosisAgent, DiagnosisRunResult, ReplyOptions } from './types.js';
import { createLoopCallSignature, isLoopCallBlocked, recordLoopSample, type LoopIntervention } from './loop-detection/index.js';

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
  /** Resolves exactly one immutable Profile snapshot for a fresh Run. */
  profileResolver?: ProfileResolver;
  hookRegistry?: HookRegistryLike;
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
  lifecycleEffects: Map<string, readonly GovernanceEffect[]>;
  loopHint?: string;
  loopTermination?: LoopIntervention;
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
      lifecycleEffects: new Map(),
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
      lifecycleEffects: new Map(),
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
        if (this.dependencies.profileResolver !== undefined) {
          const capturedAt = frame.context.governance?.profile.capturedAt ?? this.dependencies.clock.now().toISOString();
          const profile = await this.dependencies.profileResolver.resolve({
            profileId: frame.context.profileId,
            capturedAt,
            signal,
          });
          const governance = frame.context.governance ?? createInitialRunGovernanceState({
            profileId: frame.context.profileId,
            capturedAt,
          });
          frame.context.governance = { ...governance, profile };
        }
        await this.publishTransitionV2(frame, 'RUN_STARTED', {
          profile: frame.context.profileId,
          trigger: 'manual',
          deadline: new Date(Date.parse(frame.context.budget.startedAt) + frame.context.budget.maxDurationMs).toISOString(),
          versionSnapshot: governanceVersionSnapshot(frame.context),
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
      const deadline = Date.parse(context.budget.startedAt) + context.budget.maxDurationMs;
      let compressed: CompressionResult;
      try {
        compressed = await this.dependencies.compressor.compress(context, {
          signal,
          deadline,
          now: () => this.dependencies.clock.now(),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        compressed = {
          context,
          decision: { level: 'none', reason: 'compression_failed' },
          validation: {
            valid: false,
            status: 'failed',
            reasonCode: compressionFailureReason(error),
          },
        };
      }
      yield* this.publishCompressionOutcome(frame, compressed, before);

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

      const loopHint = frame.loopHint;
      delete frame.loopHint;
      const response = yield* this.reasonStream(frame.context, stepId, signal, loopHint);
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
      const admission = admitToolBatch(
        candidates,
        frame.context,
        this.dependencies.admission,
        this.dependencies.clock,
        signal,
        (call) => this.isLoopCallBlocked(frame.context, call),
      );
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
        this.completionCallbacks(frame, this.loopExecutableCalls(admission.calls), stepId),
      );
      const results = [...admission.rejected, ...batch.results];
      for (const deferred of batch.deferredActions) results.push(this.deferredResult(deferred));
      for (const result of results) await this.persistUnjournaledResult(frame, result);
      await this.publishPolicyRejections(frame, batch.results, stepId);
      const orderedResults = candidates.flatMap((candidate) => results.filter((result) => result.toolCallId === candidate.id));
      this.appendToolExchange(frame.context, response.text, candidates, orderedResults);
      this.throwIfLoopTerminated(frame);

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
        const lifecycleEffects = this.lifecycleEffectsFor(frame, batch.interrupt.toolCallId);
        await this.publishTransitionV2(frame, 'RUN_PAUSED', {
          interruptId: batch.interrupt.hookId,
          reason: batch.interrupt.interruptType,
          expiresAt,
          checkpointVersion: this.nextCheckpointVersion(frame),
        }, stepId, undefined, undefined, lifecycleEffects);
        frame.lifecycleEffects.delete(batch.interrupt.toolCallId);
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
    const pending = context.pendingToolCalls[0];
    if (pending === undefined) return false;
    const invalidReason = this.pendingResumeInvalidReason(context, pending);
    if (invalidReason !== undefined) return yield* this.rejectPendingInterruptStream(frame, pending, invalidReason);
    if (context.pendingInterrupt?.interruptType === 'external_tool_execution') return true;
    if (!context.confirmedToolCallIds.includes(pending.id)) return false;

    const stepId = context.pendingToolBatch?.stepId ?? this.dependencies.ids.next('step');
    const batch = yield* this.dependencies.batchExecutor.executeStream(
      [pending],
      context,
      stepId,
      signal,
      this.completionCallbacks(frame, [pending], stepId),
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
      const lifecycleEffects = this.lifecycleEffectsFor(frame, batch.interrupt.toolCallId);
      await this.publishTransitionV2(frame, 'RUN_PAUSED', {
        interruptId: batch.interrupt.hookId,
        reason: 'external_tool_execution',
        expiresAt,
        checkpointVersion: this.nextCheckpointVersion(frame),
      }, stepId, undefined, undefined, lifecycleEffects);
      frame.lifecycleEffects.delete(batch.interrupt.toolCallId);
      yield* this.publishStream('RUN_PAUSED', context, { reason: 'external_tool_execution' }, stepId);
      return true;
    }
    const result = batch.results[0];
    if (result === undefined) throw new Error(`Confirmed tool call produced no result: ${pending.id}`);
    this.replaceToolResult(context, result);
    this.throwIfLoopTerminated(frame);
    context.pendingToolCalls = [];
    delete context.pendingInterrupt;
    context.status = 'running';
    context.stage = 'verification';
    context.contextVersion += 1;
    await this.saveCheckpoint(frame);
    return false;
  }

  private pendingResumeInvalidReason(context: AgentContext, pending: ToolCall): string | undefined {
    const interrupt = context.pendingInterrupt;
    if (interrupt === undefined) return undefined;
    if (interrupt.toolCallId !== pending.id) return 'tool_call_mismatch';
    const registry = this.dependencies.hookRegistry;
    if (registry !== undefined) {
      const validation = registry.validate(interrupt, this.dependencies.clock.now());
      if (!validation.valid) return validation.reason;
    }
    const tool = this.dependencies.toolkit.get(pending.name);
    if (tool === undefined) return 'tool_not_found';
    const digest = toolInputDigest(tool, pending);
    if (typeof interrupt.payload.inputDigest === 'string' && interrupt.payload.inputDigest !== digest) {
      return 'input_digest_mismatch';
    }
    const decision = context.pendingToolBatch?.governance?.decisions.find((candidate) => candidate.toolCallId === pending.id);
    if (decision !== undefined && decision.inputDigest !== digest) return 'governance_digest_mismatch';
    return undefined;
  }

  private async *rejectPendingInterruptStream(
    frame: RunExecutionFrame,
    pending: ToolCall,
    reason: string,
  ): AsyncGenerator<AgentEvent, boolean> {
    const context = frame.context;
    const now = this.dependencies.clock.now().toISOString();
    const expired = reason === 'expired';
    const replacement: ToolExecutionResult = {
      toolCallId: pending.id,
      toolName: pending.name,
      status: 'aborted',
      error: expired
        ? { code: 'CONFIRMATION_EXPIRED', message: 'Pending interaction expired.', retryable: false }
        : { code: 'POLICY_DENIED', message: 'Pending interaction failed closed.', retryable: false, details: { category: 'risk_policy', reason } },
      startedAt: context.pendingInterrupt?.createdAt ?? now,
      finishedAt: now,
    };
    this.replaceToolResult(context, replacement);
    const batch = context.pendingToolBatch;
    if (batch !== undefined) {
      for (const call of batch.calls) {
        if (call.id === pending.id || hasTerminalToolResult(context, call.id)) continue;
        context.messages.push({
          id: this.dependencies.ids.next('msg'),
          role: 'tool',
          createdAt: now,
          blocks: [{ type: 'tool_result', result: {
            toolCallId: call.id,
            toolName: call.name,
            status: 'skipped',
            response: { blocks: [{ type: 'json', value: { reason: 'pending_interaction_rejected' } }] },
            startedAt: now,
            finishedAt: now,
          } }],
        });
      }
    }
    context.pendingToolCalls = [];
    delete context.pendingInterrupt;
    delete context.pendingToolBatch;
    context.status = 'running';
    context.contextVersion += 1;
    await this.publishTransitionV2(frame, 'TOOL_RESULT', toolResultPayload(replacement), undefined, replacement.toolCallId);
    await this.publishV2('TOOL_CALL_REJECTED', context, {
      toolName: replacement.toolName,
      gate: 'semantic_validation',
      error: eventError(replacement.error),
    }, undefined, replacement.toolCallId);
    if (this.dependencies.durableState === undefined) await this.saveCheckpoint(frame);
    yield* this.publishStream('TOOL_RESULT', context, replacement, undefined);
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
      const recoveredCall = pending.calls.find((call) => call.id === completed.result.toolCallId);
      const intervention = completed.execution === undefined || recoveredCall === undefined
        ? undefined
        : this.recordLoopOutcome(frame, recoveredCall, completed.result, pending.stepId);
      const committed = await this.persistCompletedOutcome(frame, recoveredCall, completed.result, completed.execution, undefined, intervention);
      context = frame.context;
      if (committed) yield* this.publishStream('TOOL_RESULT', context, completed.result, pending.stepId);
    }
    this.throwIfLoopTerminated(frame);

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
      this.completionCallbacks(frame, this.loopExecutableCalls(plan.calls), pending.stepId),
      );
      for (const result of batch.results) await this.persistUnjournaledResult(frame, result);
      this.throwIfLoopTerminated(frame);
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

  private completionCallbacks(frame: RunExecutionFrame, calls: readonly ToolCall[], stepId: string): BatchExecutionCallbacks {
    const indexes = new Map(calls.map((call, index) => [call.id, index]));
    const ready = calls.map(() => deferred());
    const done = calls.map(() => deferred());
    let failure: Error | undefined;
    return {
      onOutcome: (call, outcome) => {
        frame.lifecycleEffects.set(call.id, outcome.effects ?? []);
        const index = indexes.get(call.id);
        if (index === undefined) return Promise.resolve();
        ready[index]?.resolve();
        if (outcome.type !== 'completed') done[index]?.resolve();
        return Promise.resolve();
      },
      onCompleted: async (call, outcome) => {
        const index = indexes.get(call.id);
        if (index === undefined) return;
        await ready[index]!.promise;
        if (index > 0) await done[index - 1]!.promise;
        if (failure !== undefined) throw failure;
        try {
          const intervention = this.recordLoopOutcome(frame, call, outcome.result, stepId);
          await this.persistCompletedOutcome(frame, call, outcome.result, outcome.execution, outcome.effects, intervention);
          if (intervention !== undefined && this.dependencies.durableState === undefined) {
            await this.publishV2('LOOP_DETECTED', frame.context, loopEventPayload(intervention), stepId, call.id);
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          throw failure;
        } finally {
          done[index]?.resolve();
        }
      },
    };
  }

  private recordLoopOutcome(
    frame: RunExecutionFrame,
    call: ToolCall,
    result: ToolExecutionResult,
    stepId: string,
  ): LoopIntervention | undefined {
    const tool = this.dependencies.toolkit.get(call.name);
    if (tool === undefined) return undefined;
    const capturedAt = frame.context.governance?.profile.capturedAt ?? this.dependencies.clock.now().toISOString();
    const governance = frame.context.governance ?? createInitialRunGovernanceState({
      profileId: frame.context.profileId,
      capturedAt,
    });
    const decision = recordLoopSample(governance.loop, {
      stage: frame.context.stage,
      tool,
      call,
      result,
      stepId,
      recordedAt: result.finishedAt ?? this.dependencies.clock.now().toISOString(),
    });
    if (!decision.counted) return undefined;
    frame.context.governance = { ...governance, loop: decision.state };
    if (decision.intervention !== undefined) {
      frame.loopHint = loopHint(decision.intervention);
      if (decision.intervention.level === 'force_break') frame.loopTermination = decision.intervention;
    }
    return decision.intervention;
  }

  private isLoopCallBlocked(context: AgentContext, call: ToolCall): boolean {
    const tool = this.dependencies.toolkit.get(call.name);
    const loop = context.governance?.loop;
    return tool !== undefined && loop !== undefined
      && isLoopCallBlocked(loop, createLoopCallSignature({ stage: context.stage, tool, call }));
  }

  private loopExecutableCalls(calls: readonly ToolCall[]): ToolCall[] {
    const hasAction = calls.some((call) => this.dependencies.toolkit.get(call.name)?.kind === 'action');
    const hasEvidence = calls.some((call) => this.dependencies.toolkit.get(call.name)?.kind !== 'action');
    return hasAction && hasEvidence
      ? calls.filter((call) => this.dependencies.toolkit.get(call.name)?.kind !== 'action')
      : [...calls];
  }

  private throwIfLoopTerminated(frame: RunExecutionFrame): void {
    const termination = frame.loopTermination;
    if (termination === undefined) return;
    const missingEvidence = `loop_detection:${termination.toolName}`;
    if (!frame.context.missingEvidence.includes(missingEvidence)) frame.context.missingEvidence.push(missingEvidence);
    frame.context.pendingToolCalls = [];
    delete frame.context.pendingToolBatch;
    frame.context.contextVersion += 1;
    throw new LoopDetectionError(termination);
  }

  private async persistUnjournaledResult(frame: RunExecutionFrame, result: ToolExecutionResult): Promise<void> {
    const pending = frame.context.pendingToolBatch;
    if (pending === undefined || !pending.calls.some((call) => call.id === result.toolCallId)) return;
    if (!isTerminalBatchResult(result)) return;
    if (pending.completedResults.some((candidate) => candidate.toolCallId === result.toolCallId)) return;
    await this.persistCompletedOutcome(frame, undefined, result, undefined, frame.lifecycleEffects.get(result.toolCallId));
  }

  private async persistCompletedOutcome(
    frame: RunExecutionFrame,
    call: ToolCall | undefined,
    result: ToolExecutionResult,
    execution?: ToolExecutionRecord,
    effects?: readonly GovernanceEffect[],
    intervention?: LoopIntervention,
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
    const loopEvents = this.dependencies.v2Events === undefined || intervention === undefined
      ? []
      : [this.createPendingV2('LOOP_DETECTED', frame.context, loopEventPayload(intervention), pending.stepId, result.toolCallId)];
    if (execution !== undefined) {
      await this.publishTransitionV2(
        frame,
        'TOOL_RESULT',
        toolResultPayload(result),
        pending.stepId,
        result.toolCallId,
        { kind: 'completed', record: execution, result },
        effects,
        loopEvents,
      );
      frame.lifecycleEffects.delete(result.toolCallId);
      return true;
    }
    this.appendPendingResult(frame.context, result);
    await this.publishTransitionV2(frame, 'TOOL_RESULT', toolResultPayload(result), pending.stepId, result.toolCallId, undefined, effects, loopEvents);
    frame.lifecycleEffects.delete(result.toolCallId);
    return true;
  }

  private async publishPolicyRejections(
    frame: RunExecutionFrame,
    results: readonly ToolExecutionResult[],
    stepId: string,
  ): Promise<void> {
    for (const result of results) {
      if (result.error?.code !== 'POLICY_DENIED') continue;
      await this.publishV2('TOOL_CALL_REJECTED', frame.context, {
        toolName: result.toolName,
        // Keep the published AdmissionGate enum stable; the error category
        // carries the newer risk-policy stage without a contract break.
        gate: 'semantic_validation',
        error: eventError(result.error),
      }, stepId, result.toolCallId);
    }
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

  private async *publishCompressionOutcome(
    frame: RunExecutionFrame,
    compressed: CompressionResult,
    before: number,
  ): AsyncGenerator<AgentEvent, void> {
    const validation = compressed.validation;
    const shouldPublish = compressed.decision.level !== 'none' || validation !== undefined;
    if (!shouldPublish) return;

    const attemptedLevel = compressionAttemptLevel(compressed);
    const reason = compressionReason(compressed);
    await this.publishTransitionV2(frame, 'CONTEXT_COMPRESSION_STARTED', {
      level: attemptedLevel,
      reason,
      beforeSize: before,
    });

    if (validation?.valid === false) {
      await this.publishTransitionV2(frame, 'CONTEXT_COMPRESSION_FAILED', {
        level: attemptedLevel,
        error: compressionErrorPayload(validation.reasonCode),
        fallbackPolicy: 'retain_previous',
      });
      return;
    }

    frame.context = compressed.context;
    if (validation?.status === 'summary_fallback') {
      await this.publishTransitionV2(frame, 'CONTEXT_COMPRESSION_FAILED', {
        level: 'L2',
        error: compressionErrorPayload(validation.reasonCode),
        fallbackPolicy: 'defer',
      });
    }
    if (validation?.status === 'repaired' && validation.repairType !== undefined) {
      await this.publishTransitionV2(frame, 'CONTEXT_INTEGRITY_REPAIRED', {
        repairType: validation.repairType,
        affectedIds: validation.affectedIds ?? [],
        validationResult: 'valid',
      });
    }

    const after = Buffer.byteLength(JSON.stringify(frame.context.messages), 'utf8');
    const compressionPayload = {
      level: compressed.decision.level === 'none' ? 'L1' as const : compressed.decision.level,
      before,
      after,
      offloadedEvidenceIds: compressed.trace?.offloadedEvidenceIds ?? [],
      savedTokens: Math.max(0, Math.floor((before - after) / 4)),
    };
    await this.publishTransitionV2(frame, 'CONTEXT_COMPRESSED', compressionPayload);
    yield* this.publishStream('CONTEXT_COMPRESSED', frame.context, compressionPayload);
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

  private async *reasonStream(context: AgentContext, stepId: string, signal: AbortSignal, loopHint?: string): AsyncGenerator<AgentEvent, ModelResponse> {
    const span = this.dependencies.observability.startSpan({
      name: 'model.reasoning', kind: 'llm', runId: context.runId, stepId,
      attributes: { stage: context.stage, iteration: context.budget.iteration },
    });
    const deadline = Date.parse(context.budget.startedAt) + context.budget.maxDurationMs;
    const messages = loopHint === undefined ? context.messages : [
      ...context.messages,
      {
        id: `loop-hint:${stepId}`,
        role: 'system' as const,
        createdAt: this.dependencies.clock.now().toISOString(),
        blocks: [{ type: 'text' as const, text: loopHint }],
      },
    ];
    const stream = this.dependencies.model.stream(messages, this.dependencies.toolkit.list(), {
      signal,
      runId: context.runId,
      stepId,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.replyId === undefined ? {} : { replyId: context.replyId }),
      ...(context.streamId === undefined ? {} : { streamId: context.streamId }),
      deadline,
      ...(context.governance?.loop.level === 'hard' ? { toolChoice: 'none' as const } : {}),
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
    governanceEffects?: readonly GovernanceEffect[],
    additionalEvents: readonly PendingAgentEventV2[] = [],
  ): Promise<void> {
    const durable = this.dependencies.durableState;
    const v2 = this.dependencies.v2Events;
    if (durable === undefined) {
      if (v2 !== undefined) {
        await v2.publisher.publish(this.createPendingV2(type, frame.context, payload, stepId, toolCallId));
        for (const event of additionalEvents) await v2.publisher.publish(event);
      }
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
      ...(governanceEffects === undefined ? {} : { governanceEffects }),
      outboxEvents: pending === undefined ? [] : [pending, ...additionalEvents],
    });
    frame.context = saved.context;
    frame.checkpointRevision = saved.revision;
    if (pending !== undefined && dispatcher !== undefined) await dispatcher.drainRun(frame.context.runId);
  }

  private lifecycleEffectsFor(frame: RunExecutionFrame, toolCallId: string): readonly GovernanceEffect[] {
    return frame.lifecycleEffects.get(toolCallId) ?? [];
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
      visibility: type.startsWith('RUN_') || type.startsWith('STEP_') || type === 'REASONING_STARTED' || type === 'LOOP_DETECTED' ? 'public' : 'audit',
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

function eventError(error: ToolExecutionResult['error']): { code: NonNullable<ToolExecutionResult['error']>['code']; message: string; retryable: boolean; details?: { category: string; reason?: string } } {
  return error === undefined ? { code: 'TOOL_ERROR', message: 'Tool call rejected.', retryable: false } : {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(typeof error.details?.category === 'string'
      ? {
        details: {
          category: error.details.category,
          ...(typeof error.details.reason === 'string' ? { reason: error.details.reason } : {}),
        },
      }
      : {}),
  };
}

function compressionAttemptLevel(result: CompressionResult): 'L0' | 'L1' | 'L2' {
  if (result.validation?.status === 'summary_fallback') return 'L2';
  if (result.decision.level === 'none') return 'L1';
  return result.decision.level;
}

function compressionReason(result: CompressionResult): string {
  const reason = result.validation?.reasonCode ?? result.decision.reason;
  return reason.length > 0 ? reason.slice(0, 256) : 'compression';
}

function compressionFailureReason(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code.toLowerCase();
  }
  return 'compression_failed';
}

function compressionErrorPayload(reasonCode: string | undefined): AgentEventPayloadMap['CONTEXT_COMPRESSION_FAILED']['error'] {
  const isModelFailure = reasonCode?.startsWith('compression_summary') === true;
  return {
    code: isModelFailure ? 'MODEL_ERROR' : 'STORAGE_ERROR',
    message: isModelFailure ? 'Context summary model failed.' : 'Context compression candidate was rejected.',
    retryable: false,
    details: {
      category: isModelFailure ? 'compression_summary' : 'compression_validation',
      ...(reasonCode === undefined ? {} : { reason: reasonCode.slice(0, 128) }),
    },
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

function governanceVersionSnapshot(context: AgentContext): Record<string, string> {
  const profile = context.governance?.profile;
  if (profile === undefined) return {};
  return {
    profileRevision: profile.revision,
    profileDigest: profile.digest,
    policyVersion: profile.policyVersion,
  };
}

function hasTerminalToolResult(context: AgentContext, toolCallId: string): boolean {
  return context.messages.some((message) => message.blocks.some((block) => (
    block.type === 'tool_result'
      && block.result.toolCallId === toolCallId
      && block.result.status !== 'interrupted'
      && block.result.status !== 'awaiting_external'
  )));
}

class LoopDetectionError extends Error {
  public readonly code = 'LOOP_DETECTED' as const;
  public readonly retryable = false;
  public readonly details: Record<string, unknown>;

  public constructor(intervention: LoopIntervention) {
    super('Repeated tool execution detected; the diagnosis stopped safely.');
    this.name = 'LoopDetectionError';
    this.details = {
      category: 'loop_detection',
      repeatCount: intervention.repeatCount,
      toolName: intervention.toolName,
    };
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: () => resolvePromise?.() };
}

function loopEventPayload(intervention: LoopIntervention): AgentEventPayloadMap['LOOP_DETECTED'] {
  return {
    level: intervention.level,
    repeatCount: intervention.repeatCount,
    toolName: intervention.toolName,
    signatureDigest: intervention.signatureDigest,
    action: intervention.action,
    stage: intervention.stage,
  };
}

function loopHint(intervention: LoopIntervention): string {
  return intervention.level === 'warn'
    ? `检测到 ${intervention.toolName} 的重复调用，请切换证据路径或停止重复查询。`
    : `重复调用 ${intervention.toolName} 已被治理拦截，请改用未尝试的证据路径。`;
}
