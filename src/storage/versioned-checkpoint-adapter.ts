import type { AgentContext } from '../contracts/context.js';
import type { CheckpointStore, VersionedCheckpointStore } from '../contracts/storage.js';
import type { ToolCall, ToolExecutionResult } from '../contracts/tool.js';

/** Compatibility bridge while the Harness migrates from CheckpointStore to versioned state ports. */
export class VersionedCheckpointStoreAdapter implements CheckpointStore {
  private readonly legacyExecutions = new Map<string, ToolExecutionResult>();

  public constructor(private readonly checkpoints: VersionedCheckpointStore) {}

  public async load(runId: string): Promise<AgentContext | null> {
    return (await this.checkpoints.load(runId))?.context ?? null;
  }

  public async save(context: AgentContext): Promise<void> {
    const current = await this.checkpoints.load(context.runId);
    await this.checkpoints.save(context, current?.revision ?? null);
  }

  public hasExecuted(call: ToolCall): Promise<boolean> {
    return Promise.resolve(this.legacyExecutions.has(call.id));
  }

  public recordExecuted(call: ToolCall, result: ToolExecutionResult): Promise<void> {
    this.legacyExecutions.set(call.id, structuredClone(result));
    return Promise.resolve();
  }
}
