import type { Clock, Guardian, GuardianCoordinator as GuardianCoordinatorPort, GuardianInspection, GovernanceGuardInput, Finding } from '../contracts/index.js';
import { systemClock } from '../contracts/index.js';
import { finding } from './guard-engine.js';

export interface GuardianCoordinatorOptions {
  clock?: Clock;
  guardianTimeoutMs?: number;
}

/** Runs independent Guardians in a deterministic registration order. */
export class GuardianCoordinator implements GuardianCoordinatorPort {
  private readonly clock: Clock;
  private readonly guardianTimeoutMs: number;

  public constructor(
    private readonly guardians: readonly Guardian[],
    options: GuardianCoordinatorOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.guardianTimeoutMs = options.guardianTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.guardianTimeoutMs) || this.guardianTimeoutMs <= 0) {
      throw new RangeError('guardianTimeoutMs must be a positive safe integer.');
    }
  }

  public async inspect(input: GovernanceGuardInput): Promise<GuardianInspection> {
    const settled = await Promise.allSettled(this.guardians.map((guardian) => this.inspectOne(guardian, input)));
    const findings: Finding[] = [];
    const unavailableGuardians: string[] = [];
    for (let index = 0; index < settled.length; index += 1) {
      const guardian = this.guardians[index];
      const settledResult = settled[index];
      if (guardian === undefined || settledResult === undefined) continue;
      const result = settledResult.status === 'fulfilled'
        ? settledResult.value
        : {
          id: guardian.id,
          unavailable: true,
          findings: [finding('guard.unavailable', 'HIGH', '风险检查器当前不可用。', input.tool.name, { guardianId: guardian.id })],
        };
      if (result.unavailable) unavailableGuardians.push(result.id);
      findings.push(...result.findings);
    }
    return { findings, unavailableGuardians };
  }

  private async inspectOne(
    guardian: Guardian,
    input: GovernanceGuardInput,
  ): Promise<{ id: string; unavailable: boolean; findings: Finding[] }> {
    try {
      if (guardian.matches !== undefined && !guardian.matches(input)) {
        return { id: guardian.id, unavailable: false, findings: [] };
      }
      const findings = await this.withDeadline(guardian.inspect(input), input);
      return { id: guardian.id, unavailable: false, findings: [...findings] };
    } catch {
      return {
        id: guardian.id,
        unavailable: true,
        findings: [finding('guard.unavailable', 'HIGH', '风险检查器当前不可用。', input.tool.name, { guardianId: guardian.id })],
      };
    }
  }

  private async withDeadline(
    operation: Promise<readonly Finding[]>,
    input: GovernanceGuardInput,
  ): Promise<readonly Finding[]> {
    if (input.signal.aborted) throw new Error('Guardian inspection aborted.');
    const remaining = Math.min(
      this.guardianTimeoutMs,
      input.deadline - this.clock.now().getTime(),
    );
    if (remaining <= 0) throw new Error('Guardian inspection deadline exceeded.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Guardian inspection timed out.')), remaining);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
