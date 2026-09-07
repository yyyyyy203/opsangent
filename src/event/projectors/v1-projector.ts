import type { AgentEvent, AgentEventEnvelopeV2, AgentEventPayload } from '../../contracts/index.js';

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
      case 'RUN_STARTED':
      case 'STEP_STARTED':
      case 'REASONING_STARTED':
      case 'EVIDENCE_COLLECTED':
      case 'TOOL_PROGRESS':
      case 'CONTEXT_COMPRESSED':
      case 'RUN_PAUSED':
      case 'RUN_FINISHED':
        return { type: event.type, payload: event.payload as AgentEventPayload };
      case 'RUN_FAILED':
        return { type: 'RUN_FAILED', payload: event.payload.error };
      case 'CONTENT_BLOCK_DELTA':
        return { type: 'TEXT_DELTA', payload: { delta: event.payload.delta } };
      case 'TOOL_CALL_CREATED':
        return { type: 'TOOL_CALL_CREATED', payload: event.payload.call };
      case 'TOOL_STARTED':
        return { type: 'TOOL_STARTED', payload: event.payload as unknown as AgentEventPayload };
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
