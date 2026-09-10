import type { AgentContext, CheckpointStore, ToolCall, ToolExecutionResult } from '../contracts/index.js';
import { InMemoryDurableState } from './in-memory-durable-state.js';

/** Legacy adapter retained for existing Harness callers during durable-store migration. */
export class InMemoryCheckpointStore implements CheckpointStore {
  public readonly durable: InMemoryDurableState;
  private readonly executions = new Map<string, ToolExecutionResult>();

  public constructor(durable: InMemoryDurableState = new InMemoryDurableState()) {
    this.durable = durable;
  }

  public async load(runId: string): Promise<AgentContext | null> {
    return (await this.durable.load(runId))?.context ?? null;
  }

  public async save(context: AgentContext): Promise<void> {
    const current = await this.durable.load(context.runId);
    await this.durable.save(context, current?.revision ?? null);
  }

  public hasExecuted(call: ToolCall): Promise<boolean> {
    return Promise.resolve(this.executions.has(call.id));
  }

  public recordExecuted(call: ToolCall, result: ToolExecutionResult): Promise<void> {
    this.executions.set(call.id, structuredClone(result));
    return Promise.resolve();
  }
}

export function asLegacyCheckpointStore(durable: InMemoryDurableState): CheckpointStore {
  return new InMemoryCheckpointStore(durable);
}
