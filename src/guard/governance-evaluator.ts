import { checkpointChecksum } from '../contracts/index.js';
import type {
  Clock,
  GovernanceEvaluator,
  ImpactSurfaceAssessment,
  ImpactSurfaceProvider,
  ResolvedProfileSnapshot,
  RiskPolicy,
  Tool,
  ToolBatchGovernanceSnapshot,
  ToolCall,
  GuardianCoordinator as GuardianCoordinatorPort,
} from '../contracts/index.js';
import { systemClock } from '../contracts/index.js';

export interface BatchGovernanceEvaluatorOptions {
  resolveTool: (name: string) => Tool | undefined;
  impactSurfaceProvider: ImpactSurfaceProvider;
  guardianCoordinator: GuardianCoordinatorPort;
  riskPolicy: RiskPolicy;
  clock?: Clock;
}

/** Evaluates one admitted batch without retaining mutable Run-level state. */
export class BatchGovernanceEvaluator implements GovernanceEvaluator {
  private readonly clock: Clock;

  public constructor(private readonly options: BatchGovernanceEvaluatorOptions) {
    this.clock = options.clock ?? systemClock;
  }

  public async evaluateBatch(input: {
    runId: string;
    stepId: string;
    profile: ResolvedProfileSnapshot;
    calls: readonly ToolCall[];
    signal: AbortSignal;
    deadline: number;
  }): Promise<ToolBatchGovernanceSnapshot> {
    const impact = await this.captureImpact(input);
    const decisions = [] as ToolBatchGovernanceSnapshot['decisions'];
    for (const call of input.calls) {
      if (input.signal.aborted) throw new Error('Governance evaluation aborted.');
      const tool = this.options.resolveTool(call.name);
      if (tool === undefined) throw new Error(`Governance tool is not registered: ${call.name}`);
      const inspection = await this.options.guardianCoordinator.inspect({
        runId: input.runId,
        stepId: input.stepId,
        tool,
        toolCall: call,
        profile: input.profile,
        impact,
        signal: input.signal,
        deadline: input.deadline,
      });
      const decision = this.options.riskPolicy.evaluate({
        tool,
        profile: input.profile,
        impact,
        findings: inspection.findings,
        unavailableGuardians: inspection.unavailableGuardians,
      });
      decisions.push({
        toolCallId: call.id,
        inputDigest: checkpointChecksum(call.input),
        decision: structuredClone(decision),
      });
    }
    return {
      profileRevision: input.profile.revision,
      profileDigest: input.profile.digest,
      impact: structuredClone(impact),
      decisions,
      evaluatedAt: this.clock.now().toISOString(),
    };
  }

  private async captureImpact(input: {
    profile: ResolvedProfileSnapshot;
    calls: readonly ToolCall[];
    signal: AbortSignal;
    deadline: number;
  }): Promise<ImpactSurfaceAssessment> {
    if (input.signal.aborted) throw new Error('Governance evaluation aborted.');
    try {
      const impact = await this.options.impactSurfaceProvider.capture(input);
      if (input.signal.aborted) throw new Error('Governance evaluation aborted.');
      return normalizeImpact(impact, this.clock.now().getTime());
    } catch {
      if (input.signal.aborted) throw new Error('Governance evaluation aborted.');
      return { status: 'unavailable', reasonCode: 'impact_provider_failed', evidenceIds: [] };
    }
  }
}

function normalizeImpact(impact: ImpactSurfaceAssessment, now: number): ImpactSurfaceAssessment {
  if (impact.status !== 'available') return structuredClone(impact);
  const expiresAt = Date.parse(impact.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return {
      status: 'stale',
      reasonCode: 'impact_expired',
      capturedAt: impact.capturedAt,
      evidenceIds: [...impact.evidenceIds],
    };
  }
  return structuredClone(impact);
}
