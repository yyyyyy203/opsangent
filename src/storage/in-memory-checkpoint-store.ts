import type { AgentContext, CheckpointStore, ToolCall, ToolExecutionResult } from '../contracts/index.js';

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly contexts = new Map<string, AgentContext>();
  private readonly executions = new Map<string, ToolExecutionResult>();

  public load(runId: string): Promise<AgentContext | null> {
    const value = this.contexts.get(runId);
    return Promise.resolve(value === undefined ? null : structuredClone(value));
  }

  public save(context: AgentContext): Promise<void> {
    this.contexts.set(context.runId, structuredClone(context));
    return Promise.resolve();
  }

  public hasExecuted(call: ToolCall): Promise<boolean> {
    return Promise.resolve(this.executions.has(call.id));
  }

  public recordExecuted(call: ToolCall, result: ToolExecutionResult): Promise<void> {
    this.executions.set(call.id, structuredClone(result));
    return Promise.resolve();
  }
}
