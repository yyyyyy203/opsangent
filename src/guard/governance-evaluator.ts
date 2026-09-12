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
import { normalizeToolCall, toolInputDigest } from '../tool/schema.js';

export interface BatchGovernanceEvaluatorOptions {
  resolveTool: (name: string) => Tool | undefined;
  impactSurfaceProvider: ImpactSurfaceProvider;
  guardianCoordinator: GuardianCoordinatorPort;
  riskPolicy: RiskPolicy;
  clock?: Clock;
  impactTimeoutMs?: number;
}

/** Evaluates one admitted batch without retaining mutable Run-level state. */
export class BatchGovernanceEvaluator implements GovernanceEvaluator {
  private readonly clock: Clock;
  private readonly impactTimeoutMs: number;

  public constructor(private readonly options: BatchGovernanceEvaluatorOptions) {
    this.clock = options.clock ?? systemClock;
    this.impactTimeoutMs = options.impactTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.impactTimeoutMs) || this.impactTimeoutMs <= 0) {
      throw new RangeError('impactTimeoutMs must be a positive safe integer.');
    }
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
      const normalizedCall = normalizeToolCall(tool, call);
      const inspection = await this.options.guardianCoordinator.inspect({
        runId: input.runId,
        stepId: input.stepId,
        tool,
        toolCall: normalizedCall,
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
        inputDigest: toolInputDigest(tool, call),
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
    const remaining = Math.min(this.impactTimeoutMs, input.deadline - this.clock.now().getTime());
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return { status: 'unavailable', reasonCode: 'impact_deadline_exceeded', evidenceIds: [] };
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let operationSettled = false;
    let removeAbortListener = () => {};
    try {
      const operation = this.options.impactSurfaceProvider.capture({ ...input, signal });
      operation.then(() => { operationSettled = true; }, () => { operationSettled = true; });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('Impact surface capture timed out.'));
        }, remaining);
      });
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(new Error('Governance evaluation aborted.'));
        removeAbortListener = () => input.signal.removeEventListener('abort', onAbort);
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener('abort', onAbort, { once: true });
      });
      const impact = await Promise.race([operation, timeout, aborted]);
      if (input.signal.aborted) throw new Error('Governance evaluation aborted.');
      return normalizeImpact(impact, this.clock.now().getTime());
    } catch {
      if (input.signal.aborted) throw new Error('Governance evaluation aborted.');
      return {
        status: 'unavailable',
        reasonCode: timedOut ? 'impact_deadline_exceeded' : 'impact_provider_failed',
        evidenceIds: [],
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbortListener();
      if (!operationSettled) controller.abort();
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
