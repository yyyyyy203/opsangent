import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  ChatModel,
  CheckpointStore,
  Clock,
  EventSink,
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
} from '../contracts/index.js';
import { toAgentError } from '../contracts/index.js';
import type { ContextCompressor } from '../context-compressor/types.js';
import { AsyncEventQueue } from '../event/async-event-queue.js';
import type { EventBus } from '../event/event-bus.js';
import type { EventFactory } from '../event/event-factory.js';
import type { ToolBatchExecutor } from '../tool/batch-executor.js';
import type { Toolkit } from '../tool/toolkit.js';
import type { ToolAdmission } from '../tool/admission.js';
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
    const context = this.createContext(options);
    return yield* this.streamContext(context, options.signal ?? new AbortController().signal);
  }

  public async *resumeStream(runId: string, signal = new AbortController().signal): AsyncGenerator<AgentEvent, DiagnosisRunResult> {
    const context = await this.dependencies.checkpoints.load(runId);
    if (context === null) throw new Error(`Checkpoint not found: ${runId}`);
    return yield* this.streamContext(context, signal);
  }

  private async *streamContext(context: AgentContext, signal: AbortSignal): AsyncGenerator<AgentEvent, DiagnosisRunResult> {
    const queue = new AsyncEventQueue();
    const unsubscribe = this.dependencies.events.subscribe((event) => {
      if (event.runId === context.runId) queue.push(event);
    });
    let finalResult: DiagnosisRunResult | undefined;
    let failure: unknown;
    const producer = this.run(context, signal)
      .then((result) => { finalResult = result; })
      .catch((error: unknown) => { failure = error; })
      .finally(() => queue.close());

    try {
      for await (const event of queue) yield event;
      await producer;
      if (failure !== undefined) {
        throw failure instanceof Error
          ? failure
          : new Error(typeof failure === 'string' ? failure : 'Agent producer failed with a non-Error value.');
      }
      if (finalResult === undefined) throw new Error('Agent run ended without a result.');
      return finalResult;
    } finally {
      unsubscribe();
    }
  }

  private async run(context: AgentContext, signal: AbortSignal): Promise<DiagnosisRunResult> {
    const rootSpan = this.dependencies.observability.startSpan({
      name: 'inspection.run', kind: 'chain', runId: context.runId,
      attributes: { profileId: context.profileId },
    });
    await this.publish('RUN_STARTED', context, { profileId: context.profileId });
    await this.publishV2('RUN_STARTED', context, {
      profile: context.profileId,
      trigger: 'manual',
      deadline: new Date(Date.parse(context.budget.startedAt) + context.budget.maxDurationMs).toISOString(),
      versionSnapshot: {},
    });
    let finalText = '';

    try {
      delete context.failure;
      const pausedForExternalExecution = await this.resumePendingToolCall(context, signal);
      if (pausedForExternalExecution) {
        const result = { runId: context.runId, status: context.status, finalText, contextVersion: context.contextVersion };
        rootSpan.end(result);
        return result;
      }
      while (context.budget.iteration < context.budget.maxIterations) {
        if (signal.aborted) throw new Error('Agent run aborted.');
        if (this.dependencies.clock.now().getTime() - Date.parse(context.budget.startedAt) >= context.budget.maxDurationMs) {
          throw new Error('Agent run duration budget exhausted.');
        }

        const compressed = await this.dependencies.compressor.compress(context);
        context = compressed.context;
        if (compressed.decision.level !== 'none') {
          await this.publish('CONTEXT_COMPRESSED', context, { ...compressed.decision });
          const before = JSON.stringify(context.messages).length;
          await this.publishV2('CONTEXT_COMPRESSED', context, {
            level: compressed.decision.level,
            before,
            after: JSON.stringify(compressed.context.messages).length,
            offloadedEvidenceIds: [],
            savedTokens: 0,
          });
        }

        context.budget.iteration += 1;
        const stepId = this.dependencies.ids.next('step');
        await this.publish('STEP_STARTED', context, { iteration: context.budget.iteration }, stepId);
        await this.publish('REASONING_STARTED', context, { stage: context.stage }, stepId);
        await this.publishV2('STEP_STARTED', context, { iteration: context.budget.iteration, stage: context.stage, budgetSnapshot: { toolCallsUsed: context.budget.toolCallsUsed } }, stepId);
        await this.publishV2('REASONING_STARTED', context, { stage: context.stage, objective: `inspection:${context.profileId}` }, stepId);

        const response = await this.reason(context, stepId, signal);
        const candidates: Array<ToolCall | RawToolCall> = [...response.toolCalls, ...(response.rawToolCalls ?? [])];
        const seenIds = new Set(context.messages.flatMap((message) => message.blocks.flatMap((block) =>
          block.type === 'tool_call' || block.type === 'raw_tool_call' ? [block.call.id] : [])));
        if (candidates.length > 32) throw new Error('Model tool batch exceeds admission limit.');
        for (const candidate of candidates) {
          if (!candidate.id || seenIds.has(candidate.id)) throw new Error('Model returned a missing or duplicate tool call ID.');
          seenIds.add(candidate.id);
        }
        if (response.text !== undefined) finalText += response.text;
        if (candidates.length === 0) {
          this.appendToolExchange(context, response.text, candidates, []);
          context.status = 'completed';
          await this.dependencies.checkpoints.save(context);
          await this.publish('RUN_FINISHED', context, { finalText });
          await this.publishV2('RUN_FINISHED', context, { outcome: 'complete', durationMs: this.elapsed(context) });
          const result = { runId: context.runId, status: context.status, finalText, contextVersion: context.contextVersion };
          rootSpan.end(result);
          return result;
        }

        for (const call of candidates) {
          await this.publish('TOOL_CALL_CREATED', context, { id: call.id, name: call.name }, stepId);
        }
        const admission = admitToolBatch(candidates, context, this.dependencies.admission, this.dependencies.clock, signal);
        for (const repair of admission.repairs) await this.publish('TOOL_PROGRESS', context, repair, stepId);
        for (const gate of admission.gates) {
          for (const record of gate.records) {
            await this.publishV2('TOOL_CALL_ADMISSION_UPDATED', context, {
              gate: record.gate,
              outcome: record.outcome,
              attempt: 1,
              ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
            }, stepId, gate.toolCallId);
          }
        }
        for (const call of admission.calls) {
          await this.publishV2('TOOL_CALL_CREATED', context, { call }, stepId, call.id);
        }
        for (const result of admission.rejected) await this.publish('TOOL_RESULT', context, result, stepId);
        for (const result of admission.rejected) {
          await this.publishV2('TOOL_CALL_REJECTED', context, {
            toolName: result.toolName,
            gate: gateForError(result.error?.code),
            error: eventError(result.error),
          }, stepId, result.toolCallId);
          await this.publishV2('TOOL_RESULT', context, toolResultPayload(result), stepId, result.toolCallId);
        }
        const batch = await this.dependencies.batchExecutor.execute(admission.calls, context, stepId, signal);
        const results = [...admission.rejected, ...batch.results];
        for (const deferred of batch.deferredActions) {
          results.push(this.deferredResult(deferred));
        }
        const orderedResults = candidates.flatMap((candidate) => results.filter((result) => result.toolCallId === candidate.id));
        for (const result of batch.results) await this.publishV2('TOOL_RESULT', context, toolResultPayload(result), stepId, result.toolCallId);
        this.appendToolExchange(context, response.text, candidates, orderedResults);

        if (batch.interrupt !== undefined) {
          context.status = batch.interrupt.interruptType === 'external_tool_execution'
            ? 'paused'
            : 'awaiting_confirmation';
          context.pendingInterrupt = batch.interrupt;
          context.pendingToolCalls = admission.calls.filter((call) => call.id === batch.interrupt?.toolCallId);
          await this.dependencies.checkpoints.save(context);
          if (context.status === 'awaiting_confirmation') {
            await this.publish('REQUIRE_CONFIRM', context, batch.interrupt, stepId);
          }
          await this.publish('RUN_PAUSED', context, { reason: batch.interrupt.interruptType }, stepId);
          await this.publishV2('RUN_PAUSED', context, {
            interruptId: batch.interrupt.hookId,
            reason: batch.interrupt.interruptType,
            expiresAt: batch.interrupt.expiresAt ?? new Date(this.dependencies.clock.now().getTime() + 300_000).toISOString(),
            checkpointVersion: String(context.contextVersion),
          }, stepId);
          const result = { runId: context.runId, status: context.status, finalText, contextVersion: context.contextVersion };
          rootSpan.end(result);
          return result;
        }

        context.pendingToolCalls = [];
        context.stage = this.nextStage(admission.calls);
        await this.dependencies.checkpoints.save(context);
      }
      throw new Error('Agent iteration budget exhausted.');
    } catch (error) {
      context.status = signal.aborted ? 'cancelled' : 'failed';
      const failure = toAgentError(error);
      context.failure = failure;
      await this.dependencies.checkpoints.save(context);
      await this.publish('RUN_FAILED', context, {
        message: failure.message,
        code: failure.code,
        retryable: failure.retryable,
        category: failure.details?.category,
      });
      await this.publishV2('RUN_FAILED', context, { error: { code: failure.code, message: failure.message, retryable: failure.retryable }, stage: context.stage, recoverable: failure.retryable });
      rootSpan.fail(error);
      return { runId: context.runId, status: context.status, finalText, contextVersion: context.contextVersion };
    } finally {
      await this.dependencies.observability.flush();
    }
  }

  private async resumePendingToolCall(context: AgentContext, signal: AbortSignal): Promise<boolean> {
    if (context.pendingToolCalls.length === 0) return false;
    if (context.pendingInterrupt?.interruptType === 'external_tool_execution') return true;
    const pending = context.pendingToolCalls[0];
    if (pending === undefined || !context.confirmedToolCallIds.includes(pending.id)) return false;

    const stepId = this.dependencies.ids.next('step');
    const batch = await this.dependencies.batchExecutor.execute([pending], context, stepId, signal);
    if (batch.interrupt !== undefined) {
      if (batch.interrupt.interruptType !== 'external_tool_execution') {
        throw new Error(`Confirmed tool call was interrupted again: ${pending.id}`);
      }
      this.replaceToolResult(context, batch.results[0] ?? this.deferredResult(pending));
      context.pendingInterrupt = batch.interrupt;
      context.status = 'paused';
      context.contextVersion += 1;
      await this.dependencies.checkpoints.save(context);
      await this.publish('RUN_PAUSED', context, { reason: 'external_tool_execution' }, stepId);
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

  private async reason(context: AgentContext, stepId: string, signal: AbortSignal): Promise<ModelResponse> {
    const span = this.dependencies.observability.startSpan({
      name: 'model.reasoning', kind: 'llm', runId: context.runId, stepId,
      attributes: { stage: context.stage, iteration: context.budget.iteration },
    });
    const deadline = Date.parse(context.budget.startedAt) + context.budget.maxDurationMs;
    const stream = this.dependencies.model.stream(context.messages, this.dependencies.toolkit.list(), {
      signal, runId: context.runId, stepId, deadline,
    });
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) {
          span.end({ toolCallCount: item.value.toolCalls.length + (item.value.rawToolCalls?.length ?? 0), usage: item.value.usage });
          return item.value;
        }
        if (item.value.type === 'text_delta') {
          await this.publish('TEXT_DELTA', context, { delta: item.value.delta }, stepId);
        }
      }
    } catch (error) {
      span.fail(error);
      throw error;
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

  private publish(
    type: AgentEvent['type'],
    context: AgentContext,
    payload: AgentEvent['payload'],
    stepId?: string,
  ): Promise<void> {
    const event = this.dependencies.eventFactory.create(type, context.runId, payload, stepId);
    const sink: EventSink = this.dependencies.events;
    return Promise.resolve(sink.publish(event));
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
