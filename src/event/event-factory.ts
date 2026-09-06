import type { AgentEvent, AgentEventPayload, AgentEventType, Clock } from '../contracts/index.js';

export class EventFactory {
  public constructor(private readonly clock: Clock) {}

  public create(
    type: AgentEventType,
    runId: string,
    payload: AgentEventPayload,
    stepId?: string,
  ): AgentEvent {
    const base = {
      schemaVersion: 1 as const,
      type,
      runId,
      timestamp: this.clock.now().toISOString(),
      payload,
    };
    return stepId === undefined ? base : { ...base, stepId };
  }
}
