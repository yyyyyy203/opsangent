import type { DiagnosisSignal, GovernanceEffect, ToolLifecycleFact, ToolLifecycleObserver } from '../contracts/index.js';

/** Emits observation-only memory signals; promotion and persistence belong to MemoryFacade. */
export class DiagnosisMemoryHook implements ToolLifecycleObserver {
  public readonly id = 'diagnosis-memory';

  public observe(fact: ToolLifecycleFact): Promise<readonly GovernanceEffect[]> {
    const signal: DiagnosisSignal = {
      schemaVersion: 1,
      kind: 'tool_outcome',
      candidateStatus: 'observation',
      runId: fact.runId,
      stepId: fact.stepId,
      toolCallId: fact.toolCallId,
      toolName: fact.toolName,
      phase: fact.phase,
      outcome: fact.outcome,
      riskSeverity: fact.risk.severity,
      evidenceIds: [...fact.result.evidenceIds],
      observedAt: fact.finishedAt,
    };
    return Promise.resolve([{ type: 'memory_signal', signal }]);
  }
}
