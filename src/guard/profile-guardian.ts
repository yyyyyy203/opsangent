import type { Clock, Finding, GuardInput, Guardian } from '../contracts/index.js';
import { systemClock } from '../contracts/index.js';
import { finding } from './guard-engine.js';

/** Checks Profile action eligibility and change-freeze constraints. */
export class ProfileGuardian implements Guardian {
  public readonly id = 'profile-policy';

  public constructor(private readonly clock: Clock = systemClock) {}

  public inspect(input: GuardInput): Promise<Finding[]> {
    if (input.tool.kind !== 'action') return Promise.resolve([]);
    const profile = input.profile;
    if (profile === undefined) {
      return Promise.resolve([finding('profile.unavailable', 'CRITICAL', '目标 Profile 不可用。', input.tool.name)]);
    }
    const findings: Finding[] = [];
    if (profile.forbiddenActions.includes(input.tool.name)) {
      findings.push(finding('profile.forbidden-action', 'CRITICAL', '动作在 Profile 禁止列表中。', input.tool.name));
    } else if (!profile.allowedActions.includes(input.tool.name)) {
      findings.push(finding('profile.action-not-allowed', 'HIGH', '动作不在 Profile 允许列表中。', input.tool.name));
    }
    if (profile.source === 'legacy_checkpoint') {
      findings.push(finding('profile.legacy-snapshot', 'HIGH', '该 Run 使用旧 Checkpoint 的保守 Profile 快照。', input.tool.name));
    }
    const now = this.clock.now().getTime();
    const freeze = profile.changeFreezePeriods.find((period) => {
      const start = Date.parse(period.startsAt);
      const end = Date.parse(period.endsAt);
      return Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end;
    });
    if (freeze !== undefined) {
      findings.push(finding('profile.change-freeze', 'HIGH', '当前处于变更冻结期。', input.tool.name, { freezePeriodId: freeze.id }));
    }
    return Promise.resolve(findings);
  }
}
