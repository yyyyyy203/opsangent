import type { ToolCall, ToolResponseChunk } from '../contracts/index.js';
import type { RunFinishedPayloadV2 } from '../contracts/event-v2/lifecycle.js';

export function legacyToolCallCreatedPayload(call: ToolCall): { id: string; name: string } {
  return { id: call.id, name: call.name };
}

export function legacyToolStartedPayload(input: {
  toolCallId: string;
  toolName: string;
  source: string;
  attempt: number;
  deadline?: string;
}): Record<string, unknown> {
  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    source: input.source,
    attempt: input.attempt,
    ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
  };
}

export function legacyProgressPayload(input: {
  toolCallId: string;
  progress: number;
  displaySummary: string;
}): Record<string, unknown> {
  return {
    toolCallId: input.toolCallId,
    chunk: {
      type: 'progress',
      message: input.displaySummary,
      percent: input.progress * 100,
    },
  };
}

export function legacyTextDeltaPayload(input: { toolCallId: string; delta: string }): Record<string, unknown> {
  return { toolCallId: input.toolCallId, chunk: { type: 'text_delta', delta: input.delta } };
}

export function legacyToolProgressFromChunk(toolCallId: string, chunk: ToolResponseChunk): Record<string, unknown> | null {
  if (chunk.type === 'progress') {
    const percent = chunk.percent === undefined ? 0 : Math.max(0, Math.min(100, chunk.percent));
    return { toolCallId, chunk: { type: 'progress', message: chunk.message, percent } };
  }
  if (chunk.type === 'text_delta') return legacyTextDeltaPayload({ toolCallId, delta: chunk.delta });
  return null;
}

export function legacyRunFinishedPayload(payload: RunFinishedPayloadV2): Record<string, unknown> {
  return {
    outcome: payload.outcome,
    ...(payload.finalText === undefined ? {} : { finalText: payload.finalText }),
    ...(payload.reportId === undefined ? {} : { reportId: payload.reportId }),
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
    durationMs: payload.durationMs,
  };
}
