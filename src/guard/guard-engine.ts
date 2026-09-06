import type { Finding, Guardian, GuardInput, ResolvedRisk, RiskSeverity } from '../contracts/index.js';

const severityRank: Record<RiskSeverity, number> = {
  SAFE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export class GuardEngine {
  public constructor(private readonly guardians: readonly Guardian[]) {}

  public async inspect(input: GuardInput): Promise<ResolvedRisk> {
    const groups = await Promise.all(this.guardians.map(async (guardian) => guardian.inspect(input)));
    const findings = groups.flat();
    const severity = maxSeverity(findings.map((finding) => finding.severity));
    return {
      severity,
      requireConfirmation: input.tool.requireUserConfirm === true
        || severity === 'HIGH'
        || severity === 'CRITICAL',
      findings,
    };
  }
}

export function maxSeverity(severities: readonly RiskSeverity[]): RiskSeverity {
  return severities.reduce<RiskSeverity>((highest, current) => (
    severityRank[current] > severityRank[highest] ? current : highest
  ), 'SAFE');
}

export function finding(
  ruleId: string,
  severity: RiskSeverity,
  description: string,
  toolName: string,
  metadata?: Record<string, unknown>,
): Finding {
  return metadata === undefined
    ? { ruleId, severity, description, toolName }
    : { ruleId, severity, description, toolName, metadata };
}
