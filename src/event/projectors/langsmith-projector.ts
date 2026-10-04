import type { AgentEventEnvelopeV2, Observability, SpanStart, ToolResultPayload } from '../../contracts/index.js';
import { parseAgentEventV2 } from '../../contracts/event-v2/schema.js';
import type { EventProjectorV2 } from '../v2/event-publisher.js';
import {
  TraceSpanRegistry,
  type TraceSpanRegistryOptions,
  type TraceSpanRegistrySnapshot,
  type TraceTerminalStatus,
} from './trace-span-registry.js';

interface ExecutionSegment {
  readonly spanKey: string;
  readonly streamId?: string;
}

interface SourceInvocation {
  readonly spanKey: string;
  readonly parentRunId: string;
  readonly childRunId: string;
}

export class LangSmithEventProjectorV2 implements EventProjectorV2 {
  public readonly name = 'langsmith';
  private readonly registry: TraceSpanRegistry;
  private readonly segments = new Map<string, ExecutionSegment>();
  private readonly toolKeys = new Map<string, string>();
  private readonly modelKeys = new Map<string, string>();
  private readonly invocationsByChildRun = new Map<string, SourceInvocation>();

  public constructor(private readonly observability: Observability, registryOptions: TraceSpanRegistryOptions = {}) {
    this.registry = new TraceSpanRegistry(observability, registryOptions);
  }

  public project(input: AgentEventEnvelopeV2): Promise<void> {
    const event = parseAgentEventV2(input);
    if (!this.registry.rememberEvent(event.runId, event.eventId)) return Promise.resolve();
    try {
      switch (event.type) {
        case 'RUN_STARTED':
          this.startExecutionSegment(event, event.streamId, { profile: event.payload.profile });
          break;
        case 'RUN_RESUMED':
          // newStreamId is authoritative; the envelope may still identify the old stream.
          this.startExecutionSegment(event, event.payload.newStreamId);
          break;
        case 'RUN_FINISHED':
          this.finishRun(event, 'completed', {
            status: 'completed',
            outcome: event.payload.outcome,
            durationMs: event.payload.durationMs,
            ...(event.payload.usage === undefined ? {} : { usage: event.payload.usage }),
            ...(event.payload.usageCompleteness === undefined ? {} : { usageCompleteness: event.payload.usageCompleteness }),
            ...(event.payload.reportId === undefined ? {} : { reportId: event.payload.reportId }),
          });
          break;
        case 'RUN_FAILED':
          this.finishRun(event, 'failed', errorSummary(event.payload.error), true);
          break;
        case 'RUN_CANCELLED':
          this.finishRun(event, 'cancelled', { status: 'cancelled', stage: event.payload.stage });
          break;
        case 'RUN_TIMED_OUT':
          this.finishRun(event, 'timed_out', { status: 'timed_out', stage: event.payload.stage });
          break;
        case 'RUN_PAUSED':
          this.finishRun(event, 'paused', { status: 'paused' });
          break;
        case 'MODEL_CALL_STARTED': {
          const segment = this.ensureExecutionSegment(event.runId, event.streamId);
          if (segment === undefined) break;
          const attempt = event.attemptId ?? String(event.payload.attempt);
          const key = modelKey(event.runId, segment.streamId, attempt);
          const started = this.startSpan({
            name: `model.${event.payload.model}`,
            kind: 'llm',
            runId: event.runId,
            ...identityFields(event),
            ...(segment.streamId === undefined ? {} : { streamId: segment.streamId }),
            spanKey: key,
            parentSpanKey: segment.spanKey,
            event,
            attributes: {
              provider: event.payload.provider,
              model: event.payload.model,
              attempt: event.payload.attempt,
            },
          });
          if (started) this.modelKeys.set(attemptLookupKey(event.runId, segment.streamId, attempt), key);
          break;
        }
        case 'MODEL_CALL_COMPLETED': {
          const attempt = event.attemptId ?? String(event.payload.attempt);
          const lookupKey = attemptLookupKey(event.runId, event.streamId, attempt);
          this.registry.end(this.modelKeys.get(lookupKey)
            ?? modelKey(event.runId, event.streamId, attempt), modelOutput(event.payload));
          this.modelKeys.delete(lookupKey);
          break;
        }
        case 'MODEL_CALL_FAILED': {
          const attempt = event.attemptId ?? String(event.payload.attempt);
          const lookupKey = attemptLookupKey(event.runId, event.streamId, attempt);
          this.registry.fail(this.modelKeys.get(lookupKey)
            ?? modelKey(event.runId, event.streamId, attempt), errorSummary(event.payload.error));
          this.modelKeys.delete(lookupKey);
          break;
        }
        case 'TOOL_STARTED': {
          const segment = this.ensureExecutionSegment(event.runId, event.streamId);
          if (segment === undefined) break;
          const toolCallId = event.toolCallId ?? event.payload.toolName;
          const key = toolKey(event.runId, segment.streamId, toolCallId, event.attemptId ?? String(event.payload.attempt));
          const started = this.startSpan({
            name: `tool.${event.payload.toolName}`,
            kind: 'tool',
            runId: event.runId,
            ...identityFields(event),
            ...(segment.streamId === undefined ? {} : { streamId: segment.streamId }),
            spanKey: key,
            parentSpanKey: segment.spanKey,
            event,
            attributes: { source: event.payload.source, attempt: event.payload.attempt },
          });
          if (started) this.toolKeys.set(toolLookupKey(event.runId, segment.streamId, toolCallId), key);
          break;
        }
        case 'TOOL_RESULT': {
          const toolCallId = event.toolCallId ?? event.payload.result.toolCallId;
          const lookupKey = toolLookupKey(event.runId, event.streamId, toolCallId);
          const key = this.toolKeys.get(lookupKey)
            ?? toolKey(event.runId, event.streamId, toolCallId, event.attemptId ?? '1');
          this.registry.end(key, toolResultOutput(event.payload));
          this.toolKeys.delete(lookupKey);
          break;
        }
        case 'TOOL_FAILED': {
          const toolCallId = event.toolCallId;
          if (toolCallId !== undefined) {
            const lookupKey = toolLookupKey(event.runId, event.streamId, toolCallId);
            const key = this.toolKeys.get(lookupKey);
            if (key !== undefined) this.registry.fail(key, errorSummary(event.payload.error));
            this.toolKeys.delete(lookupKey);
          }
          break;
        }
        case 'SUBAGENT_STARTED':
          this.startSourceInvocation(event);
          break;
        case 'SUBAGENT_COMPLETED':
          this.finishSourceInvocation(event, {
            status: event.payload.status,
            evidenceIds: event.payload.evidenceIds,
            coverage: event.payload.coverage,
          });
          break;
        case 'SUBAGENT_FAILED':
          this.failSourceInvocation(event, errorSummary(event.payload.error));
          break;
        default:
          break;
      }
    } catch { /* observability is best effort */ }
    return Promise.resolve();
  }

  public async flush(): Promise<void> {
    try { await this.observability.flush(); } catch { /* best effort */ }
  }

  public getTraceDiagnostics(): TraceSpanRegistrySnapshot {
    return this.registry.getSnapshot();
  }

  private startExecutionSegment(
    event: AgentEventEnvelopeV2,
    streamId: string | undefined,
    safeInput?: Record<string, unknown>,
  ): void {
    if (this.registry.isRunTerminal(event.runId)) return;
    const orphanKey = orphanSegmentKey(event.runId, streamId);
    if (this.registry.isActive(orphanKey)) {
      this.registry.closeDescendants(orphanKey, 'incomplete');
      this.registry.end(orphanKey, { status: 'incomplete', reasonCode: 'run_start_arrived_after_child_event' });
    }

    const key = segmentKey(event.runId, streamId);
    const previous = this.segments.get(event.runId);
    if (previous !== undefined && previous.spanKey !== key && this.registry.isActive(previous.spanKey)) {
      this.registry.closeDescendants(previous.spanKey, 'incomplete');
      this.registry.end(previous.spanKey, { status: 'incomplete', reasonCode: 'execution_stream_replaced' });
    }

    const invocation = this.invocationsByChildRun.get(event.runId);
    const parentSpanKey = invocation?.spanKey;
    const missingInvocationParent = event.parentRunId !== undefined && parentSpanKey === undefined;
    if (missingInvocationParent) this.registry.recordParentMissing();
    const started = this.startSpan({
      name: 'agent.run',
      kind: 'chain',
      runId: event.runId,
      ...identityFields(event),
      ...(streamId === undefined ? {} : { streamId }),
      spanKey: key,
      ...(parentSpanKey === undefined ? {} : { parentSpanKey }),
      ...(safeInput === undefined ? {} : { input: safeInput }),
      event,
      attributes: {
        ...(safeInput ?? {}),
        ...(missingInvocationParent ? { orphan: true } : {}),
      },
    });
    if (started) this.segments.set(event.runId, { spanKey: key, ...(streamId === undefined ? {} : { streamId }) });
    else this.segments.delete(event.runId);
  }

  private ensureExecutionSegment(runId: string, streamId: string | undefined): ExecutionSegment | undefined {
    if (this.registry.isRunTerminal(runId)) return undefined;
    const current = this.segments.get(runId);
    if (current !== undefined && this.registry.isActive(current.spanKey)) {
      if (streamId === undefined || current.streamId === streamId) return current;
      // A late event from a previously paused stream must not attach to the resumed segment.
      if (current.streamId !== undefined) return undefined;
    }

    const orphanKey = orphanSegmentKey(runId, streamId);
    this.registry.recordParentMissing();
    this.startSpan({
      name: 'agent.run',
      kind: 'chain',
      runId,
      ...(streamId === undefined ? {} : { streamId }),
      spanKey: orphanKey,
      attributes: { orphan: true },
    });
    const orphan = { spanKey: orphanKey, ...(streamId === undefined ? {} : { streamId }) };
    if (this.registry.isActive(orphanKey)) {
      this.segments.set(runId, orphan);
      return orphan;
    }
    return undefined;
  }

  private finishRun(
    event: AgentEventEnvelopeV2,
    status: TraceTerminalStatus,
    output: Record<string, unknown>,
    failed = false,
  ): void {
    const current = this.segments.get(event.runId);
    if (current !== undefined && event.streamId !== undefined && current.streamId !== event.streamId) return;
    const segment = current ?? this.ensureExecutionSegment(event.runId, event.streamId);
    if (segment !== undefined) {
      this.registry.closeDescendants(segment.spanKey, status);
      if (failed) this.registry.fail(segment.spanKey, output);
      else this.registry.end(segment.spanKey, output);
      if (this.segments.get(event.runId)?.spanKey === segment.spanKey) this.segments.delete(event.runId);
    }
    this.clearAttemptKeys(event.runId);
    if (status === 'paused') return;

    this.registry.markRunTerminal(event.runId);
    for (const [childRunId, invocation] of this.invocationsByChildRun) {
      if (invocation.parentRunId !== event.runId) continue;
      this.registry.end(invocation.spanKey, { status: 'incomplete', terminalStatus: status });
      this.registry.markRunTerminal(childRunId);
      this.segments.delete(childRunId);
      this.clearAttemptKeys(childRunId);
      this.invocationsByChildRun.delete(childRunId);
    }
  }

  private startSourceInvocation(event: Extract<AgentEventEnvelopeV2, { type: 'SUBAGENT_STARTED' }>): void {
    const { childRunId, parentRunId, subagentType, budget } = event.payload;
    const toolCallId = event.toolCallId;
    const parentSegment = this.segments.get(parentRunId);
    const parentSpanKey = toolCallId === undefined || parentSegment === undefined
      ? undefined
      : this.toolKeys.get(toolLookupKey(parentRunId, parentSegment.streamId, toolCallId));
    const missingParent = parentSpanKey === undefined || !this.registry.isActive(parentSpanKey);
    if (missingParent) this.registry.recordParentMissing();
    const spanKey = invocationKey(parentRunId, toolCallId ?? 'unknown-tool', childRunId);
    const invocationStreamId = event.streamId ?? parentSegment?.streamId;
    const started = this.startSpan({
      name: `subagent.${subagentType}`,
      kind: 'chain',
      runId: parentRunId,
      ...identityFields(event),
      ...(invocationStreamId === undefined ? {} : { streamId: invocationStreamId }),
      spanKey,
      ...(missingParent ? {} : { parentSpanKey }),
      event,
      attributes: {
        subagentType,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        budget: { type: budget.type, limit: budget.limit, used: budget.used },
        ...(missingParent ? { orphan: true } : {}),
      },
    });
    if (started) this.invocationsByChildRun.set(childRunId, { spanKey, parentRunId, childRunId });
  }

  private finishSourceInvocation(
    event: Extract<AgentEventEnvelopeV2, { type: 'SUBAGENT_COMPLETED' }>,
    output: Record<string, unknown>,
  ): void {
    const invocation = this.invocationsByChildRun.get(event.payload.childRunId);
    if (invocation === undefined) return;
    this.finishChildSegment(invocation.childRunId, 'completed');
    this.registry.end(invocation.spanKey, output);
    this.invocationsByChildRun.delete(invocation.childRunId);
  }

  private failSourceInvocation(
    event: Extract<AgentEventEnvelopeV2, { type: 'SUBAGENT_FAILED' }>,
    error: Record<string, unknown>,
  ): void {
    const invocation = this.invocationsByChildRun.get(event.payload.childRunId);
    if (invocation === undefined) return;
    this.finishChildSegment(invocation.childRunId, 'failed');
    this.registry.fail(invocation.spanKey, error);
    this.invocationsByChildRun.delete(invocation.childRunId);
  }

  private finishChildSegment(childRunId: string, status: TraceTerminalStatus): void {
    const segment = this.segments.get(childRunId);
    if (segment !== undefined && this.registry.isActive(segment.spanKey)) {
      this.registry.closeDescendants(segment.spanKey, status);
      this.registry.end(segment.spanKey, { status });
      this.segments.delete(childRunId);
    }
    this.clearAttemptKeys(childRunId);
    this.registry.markRunTerminal(childRunId);
  }

  private clearAttemptKeys(runId: string): void {
    const prefix = `${runId}\u0000`;
    for (const key of this.toolKeys.keys()) if (key.startsWith(prefix)) this.toolKeys.delete(key);
    for (const key of this.modelKeys.keys()) if (key.startsWith(prefix)) this.modelKeys.delete(key);
  }

  private startSpan(input: SpanStart & { event?: AgentEventEnvelopeV2 }): boolean {
    this.registry.start({
      name: input.name,
      kind: input.kind,
      runId: input.runId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.replyId === undefined ? {} : { replyId: input.replyId }),
      ...(input.streamId === undefined ? {} : { streamId: input.streamId }),
      ...(input.spanKey === undefined ? {} : { spanKey: input.spanKey }),
      ...(input.parentSpanKey === undefined ? {} : { parentSpanKey: input.parentSpanKey }),
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
      attributes: { ...input.attributes, ...(input.event === undefined ? {} : { eventType: input.event.type }) },
    });
    return input.spanKey !== undefined && this.registry.isActive(input.spanKey);
  }
}

function identityFields(event: AgentEventEnvelopeV2): Pick<SpanStart, 'sessionId' | 'replyId'> {
  return {
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.replyId === undefined ? {} : { replyId: event.replyId }),
  };
}

function segmentKey(runId: string, streamId: string | undefined): string {
  return `run:${runId}:${streamId ?? 'initial'}`;
}

function orphanSegmentKey(runId: string, streamId: string | undefined): string {
  return `orphan:${segmentKey(runId, streamId)}`;
}

function modelKey(runId: string, streamId: string | undefined, attemptId: string): string {
  return `model:${runId}:${streamId ?? 'initial'}:${attemptId}`;
}

function toolKey(runId: string, streamId: string | undefined, toolCallId: string, attemptId: string): string {
  return `tool:${runId}:${streamId ?? 'initial'}:${toolCallId}:${attemptId}`;
}

function invocationKey(parentRunId: string, toolCallId: string, childRunId: string): string {
  return `source:${parentRunId}:${toolCallId}:${childRunId}`;
}

function attemptLookupKey(runId: string, streamId: string | undefined, attemptId: string): string {
  return `${runId}\u0000${streamId ?? ''}\u0000${attemptId}`;
}

function toolLookupKey(runId: string, streamId: string | undefined, toolCallId: string): string {
  return `${runId}\u0000${streamId ?? ''}\u0000${toolCallId}`;
}

function errorSummary(error: { code: string; retryable: boolean }): Record<string, unknown> {
  return { code: error.code, retryable: error.retryable };
}

function modelOutput(payload: Extract<AgentEventEnvelopeV2, { type: 'MODEL_CALL_COMPLETED' }>['payload']): Record<string, unknown> {
  return {
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
    ...(payload.cacheHit === undefined ? {} : { cacheHit: payload.cacheHit }),
    ...(payload.ttftMs === undefined ? {} : { ttftMs: payload.ttftMs }),
    durationMs: payload.durationMs,
    ...(payload.finishReason === undefined ? {} : { finishReason: payload.finishReason }),
  };
}

/** Only operational result metadata crosses the observability boundary. */
function toolResultOutput(payload: ToolResultPayload): Record<string, unknown> {
  const result = payload.result;
  return {
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    status: result.status,
    durationMs: payload.durationMs,
    evidenceIds: payload.evidenceIds,
    ...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
    ...(result.finishedAt === undefined ? {} : { finishedAt: result.finishedAt }),
    ...(result.error === undefined ? {} : { error: errorSummary(result.error) }),
  };
}
