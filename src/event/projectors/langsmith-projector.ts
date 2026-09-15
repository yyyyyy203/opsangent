import type { AgentEventEnvelopeV2, Observability, SpanHandle, SpanStart, ToolResultPayload } from '../../contracts/index.js';
import { parseAgentEventV2 } from '../../contracts/event-v2/schema.js';
import type { EventProjectorV2 } from '../v2/event-publisher.js';

export class LangSmithEventProjectorV2 implements EventProjectorV2 {
  public readonly name = 'langsmith';
  private readonly spans = new Map<string, SpanHandle>();
  private readonly toolKeys = new Map<string, string>();
  public constructor(private readonly observability: Observability) {}

  public project(input: AgentEventEnvelopeV2): Promise<void> {
    const event = parseAgentEventV2(input);
    try {
      switch (event.type) {
        case 'RUN_STARTED': this.start({ name: 'agent.run', kind: 'chain', runId: event.runId, ...identityFields(event), spanKey: runKey(event.runId), input: event.payload, event }); break;
        case 'RUN_FINISHED': this.end(runKey(event.runId), event.payload); break;
        case 'RUN_FAILED': this.fail(runKey(event.runId), event.payload.error); break;
        case 'MODEL_CALL_STARTED': {
          const attempt = event.attemptId ?? String(event.payload.attempt);
          this.start({ name: `model.${event.payload.model}`, kind: 'llm', runId: event.runId, ...identityFields(event), spanKey: modelKey(event.runId, attempt), parentSpanKey: runKey(event.runId), input: { purpose: event.payload.purpose }, event, attributes: { provider: event.payload.provider, model: event.payload.model, attempt: event.payload.attempt } });
          break;
        }
        case 'MODEL_CALL_COMPLETED': this.end(modelKey(event.runId, event.attemptId ?? String(event.payload.attempt)), modelOutput(event.payload)); break;
        case 'MODEL_CALL_FAILED': this.fail(modelKey(event.runId, event.attemptId ?? String(event.payload.attempt)), event.payload.error); break;
        case 'TOOL_STARTED': {
          const id = event.toolCallId ?? event.payload.toolName;
          const key = toolKey(event.runId, id, event.attemptId ?? String(event.payload.attempt));
          this.toolKeys.set(`${event.runId}:${id}`, key);
          this.start({ name: `tool.${event.payload.toolName}`, kind: 'tool', runId: event.runId, ...identityFields(event), spanKey: key, parentSpanKey: runKey(event.runId), event, attributes: { source: event.payload.source, attempt: event.payload.attempt } });
          break;
        }
        case 'TOOL_RESULT': this.end(this.toolKeys.get(`${event.runId}:${event.toolCallId ?? event.payload.result.toolCallId}`) ?? '', toolResultOutput(event.payload)); break;
        case 'TOOL_FAILED': this.fail(event.toolCallId === undefined ? '' : this.toolKeys.get(`${event.runId}:${event.toolCallId}`) ?? '', event.payload.error); break;
        case 'SUBAGENT_STARTED': {
          const parentSpanKey = event.toolCallId === undefined
            ? runKey(event.payload.parentRunId)
            : this.toolKeys.get(`${event.payload.parentRunId}:${event.toolCallId}`) ?? runKey(event.payload.parentRunId);
          this.start({ name: `subagent.${event.payload.subagentType}`, kind: 'chain', runId: event.payload.childRunId, ...identityFields(event), spanKey: runKey(event.payload.childRunId), parentSpanKey, event, attributes: { budget: event.payload.budget, toolCallId: event.toolCallId } });
          break;
        }
        case 'SUBAGENT_COMPLETED': this.end(runKey(event.payload.childRunId), event.payload); break;
        case 'SUBAGENT_FAILED': this.fail(runKey(event.payload.childRunId), event.payload.error); break;
        default: break;
      }
    } catch { /* observability is best effort */ }
    return Promise.resolve();
  }

  public async flush(): Promise<void> { try { await this.observability.flush(); } catch { /* best effort */ } }

  private start(input: SpanStart & { event: AgentEventEnvelopeV2 }): void {
    if (input.spanKey === undefined) return;
    try {
      const handle = this.observability.startSpan({
        name: input.name, kind: input.kind, runId: input.runId, spanKey: input.spanKey,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.replyId === undefined ? {} : { replyId: input.replyId }),
        ...(input.streamId === undefined ? {} : { streamId: input.streamId }),
        ...(input.parentSpanKey === undefined ? {} : { parentSpanKey: input.parentSpanKey }),
        ...(input.input === undefined ? {} : { input: input.input }),
        correlationId: input.event.correlationId,
        ...(input.event.causationId === undefined ? {} : { causationId: input.event.causationId }),
        ...(input.event.attemptId === undefined ? {} : { attemptId: input.event.attemptId }),
        ...(input.event.toolCallId === undefined ? {} : { toolCallId: input.event.toolCallId }),
        ...(input.event.stepId === undefined ? {} : { stepId: input.event.stepId }),
        attributes: { ...input.attributes, eventType: input.event.type },
      });
      this.spans.set(input.spanKey, handle);
    } catch { /* best effort */ }
  }
  private end(key: string, output: unknown): void { const span = this.spans.get(key); if (span === undefined) return; try { span.end(output); } catch { /* best effort */ } this.spans.delete(key); }
  private fail(key: string, error: unknown): void { const span = this.spans.get(key); if (span === undefined) return; try { span.fail(error); } catch { /* best effort */ } this.spans.delete(key); }
}

function identityFields(event: AgentEventEnvelopeV2): { sessionId?: string; replyId?: string; streamId?: string } {
  return {
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.replyId === undefined ? {} : { replyId: event.replyId }),
    ...(event.streamId === undefined ? {} : { streamId: event.streamId }),
  };
}

function runKey(runId: string): string { return `run:${runId}`; }
function modelKey(runId: string, attemptId: string): string { return `model:${runId}:${attemptId}`; }
function toolKey(runId: string, toolCallId: string, attemptId: string): string { return `tool:${runId}:${toolCallId}:${attemptId}`; }

function modelOutput(payload: Extract<AgentEventEnvelopeV2, { type: 'MODEL_CALL_COMPLETED' }>['payload']): Record<string, unknown> {
  return {
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
    ...(payload.cacheHit === undefined ? {} : { cacheHit: payload.cacheHit }),
    ...(payload.ttftMs === undefined ? {} : { ttftMs: payload.ttftMs }),
    durationMs: payload.durationMs,
    ...(payload.finishReason === undefined ? {} : { finishReason: payload.finishReason }),
  };
}

/**
 * LangSmith receives operational metadata only. The complete ToolResult remains
 * in the durable control plane and must never be copied into an observability
 * exporter, because its response may contain raw logs, traces, or credentials.
 */
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
    ...(result.error === undefined ? {} : {
      error: { code: result.error.code, retryable: result.error.retryable },
    }),
  };
}
