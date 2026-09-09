import type { AgentEvent, AgentEventEnvelopeV2, AgentEventPayload } from '../../contracts/index.js';
import {
  legacyProgressPayload,
  legacyRunFinishedPayload,
  legacyTextDeltaPayload,
  legacyToolCallCreatedPayload,
  legacyToolStartedPayload,
} from '../v1-payloads.js';

export class V1CompatibilityProjector {
  public project(event: AgentEventEnvelopeV2): AgentEvent[] {
    const mapped = this.map(event);
    if (mapped === null) return [];
    return [{
      schemaVersion: 1,
      type: mapped.type,
      runId: event.runId,
      timestamp: event.timestamp,
      payload: mapped.payload,
      ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    }];
  }

  private map(event: AgentEventEnvelopeV2): Pick<AgentEvent, 'type' | 'payload'> | null {
    switch (event.type) {
      case 'RUN_STARTED': return { type: 'RUN_STARTED', payload: { profileId: event.payload.profile } };
      case 'STEP_STARTED': return { type: 'STEP_STARTED', payload: { iteration: event.payload.iteration } };
      case 'REASONING_STARTED': return { type: 'REASONING_STARTED', payload: { stage: event.payload.stage } };
      case 'EVIDENCE_COLLECTED': return { type: 'EVIDENCE_COLLECTED', payload: event.payload as unknown as AgentEventPayload };
      case 'CONTEXT_COMPRESSED': return { type: 'CONTEXT_COMPRESSED', payload: event.payload as AgentEventPayload };
      case 'RUN_PAUSED': return { type: 'RUN_PAUSED', payload: { reason: event.payload.reason } };
      case 'RUN_FINISHED': return { type: 'RUN_FINISHED', payload: legacyRunFinishedPayload(event.payload) };
      case 'RUN_FAILED':
        return { type: 'RUN_FAILED', payload: {
          ...event.payload.error,
          ...(event.payload.error.details?.category === undefined ? {} : { category: event.payload.error.details.category }),
        } };
      case 'CONTENT_BLOCK_DELTA':
        if (event.payload.blockType !== undefined && event.payload.blockType !== 'text') return null;
        return { type: 'TEXT_DELTA', payload: { delta: event.payload.delta } };
      case 'TOOL_PROGRESS':
        return { type: 'TOOL_PROGRESS', payload: legacyProgressPayload({
          toolCallId: event.toolCallId ?? '', progress: event.payload.progress, displaySummary: event.payload.displaySummary,
        }) };
      case 'TOOL_OUTPUT_DELTA':
        return event.payload.textDelta === undefined ? null : { type: 'TOOL_PROGRESS', payload: legacyTextDeltaPayload({
          toolCallId: event.toolCallId ?? '', delta: event.payload.textDelta,
        }) };
      case 'TOOL_CALL_REPAIR_COMPLETED':
        return { type: 'TOOL_PROGRESS', payload: {
          toolCallId: event.toolCallId ?? '', stage: 'admission', repairs: event.payload.changedPaths,
        } };
      case 'TOOL_CALL_CREATED':
        return { type: 'TOOL_CALL_CREATED', payload: legacyToolCallCreatedPayload(event.payload.call) };
      case 'TOOL_STARTED':
        return { type: 'TOOL_STARTED', payload: legacyToolStartedPayload({
          toolCallId: event.toolCallId ?? '', toolName: event.payload.toolName,
          source: event.payload.source, attempt: event.payload.attempt, deadline: event.payload.deadline,
        }) };
      case 'TOOL_RESULT':
        return { type: 'TOOL_RESULT', payload: event.payload.result };
      case 'CONFIRMATION_REQUESTED':
        return { type: 'REQUIRE_CONFIRM', payload: event.payload as unknown as AgentEventPayload };
      case 'EXTERNAL_EXECUTION_REQUESTED':
        return { type: 'EXTERNAL_TOOL_REQUESTED', payload: event.payload as unknown as AgentEventPayload };
      default:
        return null;
    }
  }
}
