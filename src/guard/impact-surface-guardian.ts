import type { Finding, GuardInput, Guardian } from '../contracts/index.js';
import { finding } from './guard-engine.js';

/** Converts impact data quality and health facts into deterministic Findings. */
export class ImpactSurfaceGuardian implements Guardian {
  public readonly id = 'impact-surface';

  public inspect(input: GuardInput): Promise<Finding[]> {
    const impact = input.impact;
    if (impact === undefined) {
      return Promise.resolve([finding(
        'impact.unavailable',
        input.tool.kind === 'evidence' ? 'MEDIUM' : 'HIGH',
        '影响面证据当前不可用。',
        input.tool.name,
        { status: 'unavailable' },
      )]);
    }
    if (impact.status !== 'available') {
      const status = impact.status;
      return Promise.resolve([finding(
        status === 'stale' ? 'impact.stale' : 'impact.unavailable',
        input.tool.kind === 'evidence' ? 'MEDIUM' : 'HIGH',
        status === 'stale' ? '影响面证据已过期。' : '影响面证据当前不可用。',
        input.tool.name,
        { status, reasonCode: impact.reasonCode },
      )]);
    }

    const findings: Finding[] = [];
    if (!validNumber(impact.affectedUsers) || !validNumber(impact.errorRate, 0, 1)
      || !validNumber(impact.baselineErrorRate, 0, 1) || !validNumber(impact.currentQps)
      || !validNumber(impact.peakQps)) {
      findings.push(finding('impact.invalid', 'HIGH', '影响面快照包含无效数值。', input.tool.name));
      return Promise.resolve(findings);
    }
    if (!impact.downstreamHealthy) {
      findings.push(finding(
        'impact.downstream-unhealthy', input.tool.kind === 'evidence' ? 'MEDIUM' : 'HIGH',
        '下游健康检查未通过。', input.tool.name,
      ));
    }
    if (impact.errorRate > impact.baselineErrorRate) {
      findings.push(finding('impact.error-rate-elevated', 'MEDIUM', '当前错误率高于基线。', input.tool.name));
    }
    return Promise.resolve(findings);
  }
}

function validNumber(value: number, min = 0, max = Number.POSITIVE_INFINITY): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}
