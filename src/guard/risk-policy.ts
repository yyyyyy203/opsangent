import type { Finding, RiskPolicy, RiskPolicyInput, RiskDecision, RiskSeverity } from '../contracts/index.js';

const severityRank: Record<RiskSeverity, number> = {
  SAFE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const hardDenyRules = new Set([
  'profile.forbidden-action',
  'profile.action-not-allowed',
  'profile.change-freeze',
  'bash.outside-workspace',
  'bash.sensitive-path',
  'bash.destructive-command',
  'mcp.sensitive-input',
]);

/** Pure allow/confirm/deny policy. It has no network, clock, or storage dependency. */
export class DeterministicRiskPolicy implements RiskPolicy {
  public constructor(private readonly version = 'risk/v2') {}

  public evaluate(input: RiskPolicyInput): RiskDecision {
    const findings = [...input.findings];
    const severity = maxSeverity(findings.map((item) => item.severity));
    const impactUnavailable = input.impact.status === 'unavailable' || input.impact.status === 'stale';
    const unavailable = new Set(input.unavailableGuardians);
    const isAction = input.tool.kind === 'action';
    const isEvidence = input.tool.kind === 'evidence';
    const forbiddenAction = isAction && input.profile.forbiddenActions.includes(input.tool.name);
    const unlistedAction = isAction && !input.profile.allowedActions.includes(input.tool.name);
    const isBash = input.tool.name === 'bash' || input.tool.name.endsWith('.bash');
    const evidenceImpactException = isEvidence
      && impactUnavailable
      && findings.every((item) => item.ruleId === 'impact.unavailable' || item.ruleId === 'impact.stale' || severityRank[item.severity] <= severityRank.MEDIUM);

    let disposition: RiskDecision['disposition'];
    if (forbiddenAction
      || unlistedAction
      || findings.some((item) => hardDenyRules.has(item.ruleId))
      || (isAction && unavailable.has('profile-policy'))
      || (isBash && unavailable.has('bash-policy'))
      || (isAction && impactUnavailable && (input.profile.serviceLevel === 'S0' || input.profile.serviceLevel === 'S1'))) {
      disposition = 'deny';
    } else if (evidenceImpactException) {
      disposition = 'allow';
    } else if (isAction
      || input.tool.requireUserConfirm === true
      || severityRank[severity] >= severityRank.HIGH
      || unavailable.size > 0
      || (isAction && impactUnavailable)) {
      disposition = 'confirm';
    } else {
      disposition = 'allow';
    }

    return {
      disposition,
      severity,
      requireConfirmation: disposition === 'confirm',
      findings,
      policyVersion: this.version,
    };
  }
}

export function maxRiskSeverity(severities: readonly RiskSeverity[]): RiskSeverity {
  return severities.reduce<RiskSeverity>((highest, current) => (
    severityRank[current] > severityRank[highest] ? current : highest
  ), 'SAFE');
}

function maxSeverity(severities: readonly RiskSeverity[]): RiskSeverity {
  return maxRiskSeverity(severities);
}
