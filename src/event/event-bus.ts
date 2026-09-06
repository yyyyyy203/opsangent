import type { AgentEvent, EventSink } from '../contracts/index.js';

export class EventBus implements EventSink {
  private readonly listeners = new Set<(event: AgentEvent) => Promise<void> | void>();

  public subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async publish(event: AgentEvent): Promise<void> {
    await Promise.all([...this.listeners].map(async (listener) => listener(event)));
  }
}
