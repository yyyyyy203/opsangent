import type { AuditFact, GovernanceEffect, ToolLifecycleFact, ToolLifecycleObserver } from '../contracts/index.js';

/** Produces a redacted audit effect; it does not own audit persistence. */
export class AuditHook implements ToolLifecycleObserver {
  public readonly id = 'audit';

  public observe(fact: ToolLifecycleFact): Promise<readonly GovernanceEffect[]> {
    const audit: AuditFact = {
      schemaVersion: 1,
      kind: 'tool_lifecycle',
      runId: fact.runId,
      stepId: fact.stepId,
      toolCallId: fact.toolCallId,
      toolName: fact.toolName,
      phase: fact.phase,
      outcome: fact.outcome,
      inputDigest: fact.inputDigest,
      riskSeverity: fact.risk.severity,
      ...(fact.result.errorCode === undefined ? {} : { errorCode: fact.result.errorCode }),
      evidenceIds: [...fact.result.evidenceIds],
      observedAt: fact.finishedAt,
    };
    return Promise.resolve([{ type: 'audit', fact: audit }]);
  }
}
