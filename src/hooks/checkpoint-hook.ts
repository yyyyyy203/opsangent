import type { CheckpointIntent, GovernanceEffect, ToolLifecycleFact, ToolLifecycleObserver } from '../contracts/index.js';

/** Emits a persistence intent only; it never calls a CheckpointStore. */
export class CheckpointHook implements ToolLifecycleObserver {
  public readonly id = 'checkpoint';

  public observe(fact: ToolLifecycleFact): Promise<readonly GovernanceEffect[]> {
    const intent: CheckpointIntent = {
      schemaVersion: 1,
      kind: 'tool_lifecycle_checkpoint',
      reason: reasonFor(fact.outcome),
      runId: fact.runId,
      stepId: fact.stepId,
      toolCallId: fact.toolCallId,
      inputDigest: fact.inputDigest,
      outcome: fact.outcome,
      requestedAt: fact.finishedAt,
    };
    return Promise.resolve([{ type: 'checkpoint', intent }]);
  }
}

function reasonFor(outcome: ToolLifecycleFact['outcome']): CheckpointIntent['reason'] {
  if (outcome === 'interrupted' || outcome === 'awaiting_external') return 'tool_interrupted';
  if (outcome === 'failed' || outcome === 'timeout' || outcome === 'aborted') return 'tool_failed';
  return 'tool_terminal';
}
