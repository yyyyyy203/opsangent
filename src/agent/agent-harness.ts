import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  ChatModel,
  CheckpointStore,
  Clock,
  IdGenerator,
  MessageBlock,
  ModelResponse,
  Observability,
  AgentEventPayloadMap,
  AgentEventTypeV2,
  AgentErrorCode,
  PendingAgentEventV2,
  EventFactoryV2Like,
  EventPublisherV2Like,
  ToolCall,
  RawToolCall,
  ToolExecutionResult,
  RiskSeverity,
} from '../contracts/index.js';
import { toAgentError } from '../contracts/index.js';
import type { ContextCompressor } from '../context-compressor/types.js';
import type { EventBus } from '../event/event-bus.js';
import type { EventFactory } from '../event/event-factory.js';
import type { ToolBatchExecutor } from '../tool/batch-executor.js';
import type { Toolkit } from '../tool/toolkit.js';
import type { ToolAdmission } from '../tool/admission.js';
import { legacyRunFinishedPayload } from '../event/v1-payloads.js';
import { admitToolBatch } from './admit-tool-batch.js';
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
  v2Events?: { factory: EventFactoryV2Like; publisher: EventPublisherV2Like; correlationId: string | ((runId: string) => string) };
}

type RunTerminalOutcome = 'completed' | 'paused' | 'failed' | 'cancelled';

interface RunExecutionFrame {
  context: AgentContext;
  finalText: string;
  activeStepId?: string;
  activeStepStartedAt?: number;
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
    return yield* this.run(frame, options.signal ?? new AbortController().signal);
  }

  public async *resumeStream(runId: string, signal = new AbortController().signal): AsyncGenerator<AgentEvent, DiagnosisRunResult> {
    const context = await this.dependencies.checkpoints.load(runId);
    if (context === null) throw new Error(`Checkpoint not found: ${runId}`);
    context.sessionId ??= this.dependencies.ids.next('session');
    context.replyId ??= this.dependencies.ids.next('reply');
    const newStreamId = this.dependencies.ids.next('stream');
    context.streamId = newStreamId;
    await this.publishV2('RUN_RESUMED', context, { checkpointVersion: String(context.contextVersion), resumeReason: 'explicit_resume', newStreamId });
    const frame: RunExecutionFrame = { context, finalText: '', naturalExit: false };
    return yield* this.run(frame, signal, true);
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
        await this.publishV2('RUN_STARTED', frame.context, {
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
      return yield* this.mainLoop(frame, signal, rootSpan);
    } catch (error) {
      const context = frame.context;
      context.status = signal.aborted ? 'cancelled' : 'failed';
      const failure = signal.aborted
        ? { code: 'ABORTED' as const, message: 'Agent run aborted.', retryable: false }
        : toAgentError(error);
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
      await this.publishV2('RUN_FAILED', context, {
        error: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          ...(failureCategory === undefined ? {} : { details: { category: failureCategory } }),
        },
        stage: context.stage,
        recoverable: failure.retryable,
      });
      rootSpan.fail(error);
      yield* this.publishStream('RUN_FAILED', context, {
        message: failure.message,
        code: failure.code,
        retryable: failure.retryable,
        ...(failureCategory === undefined ? {} : { category: failureCategory }),
      });
      frame.naturalExit = true;
      return this.result(context, frame.finalText);
    } finally {
      if (!frame.naturalExit && frame.terminalOutcome === undefined) {
        const context = frame.context;
        const cancellation = { code: 'ABORTED' as const, message: 'Agent stream consumer closed.', retryable: false };
        context.status = 'cancelled';
        context.failure = cancellation;
        frame.terminalOutcome = 'cancelled';
        rootSpan.fail(cancellation);
        await this.publishV2('RUN_CANCELLED', context, {
          actor: 'stream_consumer',
          reason: 'stream_consumer_closed',
          stage: context.stage,
        });
      }
      try {
        await this.dependencies.checkpoints.save(frame.context);
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
        await this.publishV2('RUN_FINISHED', frame.context, finishPayload);
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
      for (const result of admission.rejected) {
        if (this.dependencies.v2Events === undefined) yield* this.publishStream('TOOL_RESULT', frame.context, result, stepId);
        await this.publishV2('TOOL_CALL_REJECTED', frame.context, {
          toolName: result.toolName,
          gate: gateForError(result.error?.code),
          error: eventError(result.error),
        }, stepId, result.toolCallId);
        await this.publishV2('TOOL_RESULT', frame.context, toolResultPayload(result), stepId, result.toolCallId);
        if (this.dependencies.v2Events !== undefined) yield* this.publishStream('TOOL_RESULT', frame.context, result, stepId);
      }
      const batch = yield* this.dependencies.batchExecutor.executeStream(admission.calls, frame.context, stepId, signal);
      const results = [...admission.rejected, ...batch.results];
      for (const deferred of batch.deferredActions) results.push(this.deferredResult(deferred));
      const orderedResults = candidates.flatMap((candidate) => results.filter((result) => result.toolCallId === candidate.id));
      this.appendToolExchange(frame.context, response.text, candidates, orderedResults);

      if (batch.interrupt !== undefined) {
        frame.context.status = batch.interrupt.interruptType === 'external_tool_execution' ? 'paused' : 'awaiting_confirmation';
        frame.context.pendingInterrupt = batch.interrupt;
        frame.context.pendingToolCalls = admission.calls.filter((call) => call.id === batch.interrupt?.toolCallId);
        await this.dependencies.checkpoints.save(frame.context);
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
        await this.publishV2('RUN_PAUSED', frame.context, {
          interruptId: batch.interrupt.hookId,
          reason: batch.interrupt.interruptType,
          expiresAt,
          checkpointVersion: String(frame.context.contextVersion),
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
      const nextStage = this.nextStage(admission.calls);
      if (nextStage !== frame.context.stage) {
        const previousStage = frame.context.stage;
        frame.context.stage = nextStage;
        await this.publishV2('STAGE_CHANGED', frame.context, { from: previousStage, to: nextStage, reason: 'tool_batch_completed' }, stepId);
      }
      await this.dependencies.checkpoints.save(frame.context);
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
    const context = frame.context;
    if (context.pendingToolCalls.length === 0) return false;
    if (context.pendingInterrupt?.interruptType === 'external_tool_execution') return true;
    const pending = context.pendingToolCalls[0];
    if (pending === undefined || !context.confirmedToolCallIds.includes(pending.id)) return false;

    const stepId = this.dependencies.ids.next('step');
    const batch = yield* this.dependencies.batchExecutor.executeStream([pending], context, stepId, signal);
    if (batch.interrupt !== undefined) {
      if (batch.interrupt.interruptType !== 'external_tool_execution') {
        throw new Error(`Confirmed tool call was interrupted again: ${pending.id}`);
      }
      this.replaceToolResult(context, batch.results[0] ?? this.deferredResult(pending));
      context.pendingInterrupt = batch.interrupt;
      context.status = 'paused';
      context.contextVersion += 1;
      await this.dependencies.checkpoints.save(context);
      const expiresAt = batch.interrupt.expiresAt ?? new Date(this.dependencies.clock.now().getTime() + 300_000).toISOString();
      const external = {
        requestId: `external:${context.runId}:${batch.interrupt.toolCallId}`,
        toolCallId: batch.interrupt.toolCallId,
        interactionPayload: { type: 'external_tool_execution', toolCallId: batch.interrupt.toolCallId },
        expiresAt,
      };
      await this.publishV2('EXTERNAL_EXECUTION_REQUESTED', context, external, stepId, batch.interrupt.toolCallId);
      if (this.dependencies.v2Events !== undefined) yield* this.publishStream('EXTERNAL_TOOL_REQUESTED', context, external, stepId);
      await this.publishV2('RUN_PAUSED', context, {
        interruptId: batch.interrupt.hookId,
        reason: 'external_tool_execution',
        expiresAt,
        checkpointVersion: String(context.contextVersion),
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
    await this.dependencies.checkpoints.save(context);
    return false;
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
    const pending: PendingAgentEventV2<T> = v2.factory.create(type, {
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
    return v2.publisher.publish(pending).then(() => undefined);
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
