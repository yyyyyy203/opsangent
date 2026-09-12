import type {
  AgentContext,
  CheckpointStore,
  Clock,
  DurableRunState,
  EventSink,
  ResolvedRisk,
  ToolExecutionResult,
  ToolResponse,
  ToolExecutionRecord,
  ToolCall,
  EventPublisherV2Dependencies,
  PendingAgentEventV2,
  HookRegistryLike,
} from '../contracts/index.js';
import { CheckpointConflictError, checkpointChecksum } from '../contracts/index.js';
import type { EventFactory } from '../event/event-factory.js';
import type { GuardEngine } from '../guard/guard-engine.js';
import type { HookExecutor } from '../hooks/hook-executor.js';
import type { Toolkit } from '../tool/toolkit.js';
import { toolInputDigest } from '../tool/schema.js';

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
    private readonly v2Events?: EventPublisherV2Dependencies,
    private readonly durableState?: DurableRunState,
    private readonly hookRegistry?: HookRegistryLike,
  ) {}

  public async submit(submission: ExternalToolResultSubmission): Promise<void> {
    const stored = await this.loadCheckpoint(submission.runId);
    if (stored === null) throw new Error(`Checkpoint not found: ${submission.runId}`);
    const { context } = stored;
    const interrupt = context.pendingInterrupt;
    if (context.status !== 'paused' || interrupt?.interruptType !== 'external_tool_execution') {
      throw new Error(`Run is not awaiting external tool execution: ${submission.runId}`);
    }
    if (interrupt.toolCallId !== submission.toolCallId) {
      throw new Error(`External result does not match pending tool call: ${submission.toolCallId}`);
    }
    if (this.hookRegistry !== undefined) {
      const validation = this.hookRegistry.validate(interrupt, this.clock.now());
      if (!validation.valid) throw new Error(`Invalid pending interrupt: ${validation.reason}`);
    }
    const pending = this.pendingCall(context, submission.toolCallId);

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
    const expectedInputDigest = typeof interrupt.payload.inputDigest === 'string' ? interrupt.payload.inputDigest : undefined;
    if (expectedInputDigest !== undefined && expectedInputDigest !== toolInputDigest(tool, pending)) {
      throw new Error(`External result input digest does not match pending tool call: ${pending.id}`);
    }
    const governanceDecision = context.pendingToolBatch?.governance?.decisions.find((decision) => decision.toolCallId === pending.id);
    if (governanceDecision !== undefined && governanceDecision.inputDigest !== toolInputDigest(tool, pending)) {
      throw new Error(`External result governance digest does not match pending tool call: ${pending.id}`);
    }
    let execution: ToolExecutionRecord | undefined;
    try {
      execution = await this.externalExecution(context, pending, tool.kind, stored.revision);
    } catch (error) {
      throw durableStorageError(error);
    }
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
    if (context.pendingToolBatch !== undefined) context.pendingToolBatch.state = 'executing';
    context.status = 'running';
    context.stage = pending.name === 'bash' ? 'verification' : context.stage;
    context.contextVersion += 1;
    this.storeTerminalPendingResult(context, replacement);
    const pendingEvents: PendingAgentEventV2[] = this.v2Events === undefined ? [] : [
      this.v2Events.factory.create('EXTERNAL_EXECUTION_RESOLVED', {
        runId: context.runId,
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        ...(context.replyId === undefined ? {} : { replyId: context.replyId }),
        ...(context.streamId === undefined ? {} : { streamId: context.streamId }),
        correlationId: this.v2Events.correlationId(context.runId),
        visibility: 'audit',
        durability: 'durable',
        toolCallId: pending.id,
      }, {
        requestId: `external:${context.runId}:${pending.id}`,
        resultBlock: submission.response.blocks[0] ?? { type: 'text', text: '' },
        externalExecutionType: 'host_submission',
      }),
      this.v2Events.factory.create('TOOL_RESULT', {
        runId: context.runId,
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        ...(context.replyId === undefined ? {} : { replyId: context.replyId }),
        ...(context.streamId === undefined ? {} : { streamId: context.streamId }),
        correlationId: this.v2Events.correlationId(context.runId),
        visibility: 'audit',
        durability: 'durable',
        toolCallId: pending.id,
      }, { result: replacement, durationMs: 0, evidenceIds: replacement.response?.evidenceIds ?? [] }),
    ];
    if (this.durableState === undefined || execution === undefined) {
      if (tool.kind === 'action'
        && interrupt.payload.mode === 'execute'
        && replacement.status === 'success') {
        await this.checkpoints.recordExecuted(pending, replacement);
      }
      await this.checkpoints.save(context);
    } else {
      if (pendingEvents.length > 0 && this.v2Events?.dispatcher === undefined) {
        throw new Error(`Durable V2 event dispatcher is not configured: ${context.runId}`);
      }
      try {
        await this.durableState.transitions.commit({
          expectedRevision: this.requireRevision(stored.revision, context.runId),
          context,
          execution: { kind: 'completed', record: execution, result: replacement },
          outboxEvents: pendingEvents,
        });
        if (pendingEvents.length > 0) await this.v2Events!.dispatcher!.drainRun(context.runId);
      } catch (error) {
        throw durableStorageError(error);
      }
    }
    if (this.v2Events === undefined) {
      await this.events.publish(this.eventFactory.create(
        'TOOL_RESULT',
        context.runId,
        replacement,
        `external-${pending.id}`,
      ));
    }
    if (this.v2Events !== undefined && this.durableState === undefined) {
      for (const event of pendingEvents) await this.v2Events.publisher.publish(event);
    }
  }

  private async loadCheckpoint(runId: string): Promise<{ context: AgentContext; revision?: number } | null> {
    if (this.durableState === undefined) {
      const context = await this.checkpoints.load(runId);
      return context === null ? null : { context };
    }
    const checkpoint = await this.durableState.checkpoints.load(runId);
    return checkpoint === null ? null : { context: checkpoint.context, revision: checkpoint.revision };
  }

  private pendingCall(context: AgentContext, toolCallId: string): ToolCall {
    const batch = context.pendingToolBatch;
    if (this.durableState !== undefined) {
      if (batch === undefined) throw new Error(`Durable external execution is missing its pending batch: ${context.runId}`);
      if (batch.state !== 'awaiting_external') {
        throw new Error(`Durable external execution batch is not awaiting external execution: ${context.runId}`);
      }
      const durableCall = batch.calls.find((candidate) => candidate.id === toolCallId);
      if (durableCall === undefined) throw new Error(`Pending tool call not found in durable batch: ${toolCallId}`);
      return durableCall;
    }
    const call = batch?.calls.find((candidate) => candidate.id === toolCallId)
      ?? context.pendingToolCalls.find((candidate) => candidate.id === toolCallId);
    if (call === undefined) throw new Error(`Pending tool call not found: ${toolCallId}`);
    return call;
  }

  private async externalExecution(
    context: AgentContext,
    call: ToolCall,
    toolKind: ToolExecutionRecord['toolKind'],
    expectedRevision: number | undefined,
  ): Promise<ToolExecutionRecord | undefined> {
    if (this.durableState === undefined) return undefined;
    const batch = context.pendingToolBatch;
    if (batch === undefined) throw new Error(`Durable external execution is missing its pending batch: ${context.runId}`);
    const execution = await this.durableState.executions.get(call.id);
    if (execution === null) throw missingExecutionJournalError(context.runId, call.id);
    if (execution.runId !== context.runId
      || execution.stepId !== batch.stepId
      || execution.toolName !== call.name
      || execution.toolKind !== toolKind
      || execution.inputDigest !== checkpointChecksum(call.input)) {
      throw new Error(`External execution journal identity does not match pending call: ${call.id}`);
    }
    if (execution.state !== 'prepared') {
      const latest = await this.durableState.checkpoints.load(context.runId);
      throw new CheckpointConflictError(context.runId, expectedRevision ?? null, latest?.revision ?? null);
    }
    return execution;
  }

  private storeTerminalPendingResult(context: AgentContext, result: ToolExecutionResult): void {
    const batch = context.pendingToolBatch;
    if (batch === undefined) return;
    if (isProvisionalResult(result)) throw new Error(`External result is not terminal: ${result.toolCallId}`);
    const call = batch.calls.find((candidate) => candidate.id === result.toolCallId);
    if (call === undefined || call.name !== result.toolName) {
      throw new Error(`External result does not belong to pending batch: ${result.toolCallId}`);
    }
    const index = batch.completedResults.findIndex((candidate) => candidate.toolCallId === result.toolCallId);
    if (index < 0) {
      batch.completedResults.push(structuredClone(result));
      return;
    }
    const existing = batch.completedResults[index];
    if (existing !== undefined && isProvisionalResult(existing)) {
      batch.completedResults[index] = structuredClone(result);
      return;
    }
    if (existing !== undefined && checkpointChecksum(existing) !== checkpointChecksum(result)) {
      throw new Error(`External result conflicts with pending batch: ${result.toolCallId}`);
    }
  }

  private requireRevision(revision: number | undefined, runId: string): number {
    if (revision === undefined) throw new Error(`Missing durable checkpoint revision: ${runId}`);
    return revision;
  }
}

function isResolvedRisk(value: unknown): value is ResolvedRisk {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ResolvedRisk>;
  return typeof candidate.severity === 'string'
    && typeof candidate.requireConfirmation === 'boolean'
    && Array.isArray(candidate.findings);
}

function isProvisionalResult(result: ToolExecutionResult): boolean {
  return result.status === 'interrupted' || result.status === 'awaiting_external';
}

function durableStorageError(error: unknown): Error {
  if (error instanceof CheckpointConflictError) {
    return Object.assign(new Error(error.message), {
      code: 'STORAGE_ERROR' as const,
      retryable: false,
      details: { category: error.category },
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function missingExecutionJournalError(runId: string, toolCallId: string): Error {
  return Object.assign(new Error(`Prepared tool execution is missing: ${toolCallId}`), {
    code: 'STORAGE_ERROR' as const,
    retryable: false,
    details: { category: 'execution_journal_missing', runId },
  });
}
