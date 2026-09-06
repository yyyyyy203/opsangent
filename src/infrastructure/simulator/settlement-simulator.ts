export type SettlementScenario = 'normal' | 'settlement_failure' | 'low_sample';

/** Immutable scenario snapshots; repeated scrapes do not move the evidence window. */
export class SettlementSimulator {
  private snapshot: { start: number; end: number; success: number; failure: number };
  private activeScenario: SettlementScenario = 'normal';

  constructor(private readonly now: () => number = Date.now) {
    this.snapshot = this.createSnapshot('normal');
  }

  select(scenario: SettlementScenario): void {
    this.snapshot = this.createSnapshot(scenario);
    this.activeScenario = scenario;
  }

  currentScenario(): SettlementScenario { return this.activeScenario; }

  exposition(): string {
    const { start, end, success, failure } = this.snapshot;
    const labels = 'service="checkout",environment="simulation"';
    return [
      '# HELP settlement_window_requests Settlement count in the explicit snapshot window.',
      '# TYPE settlement_window_requests gauge',
      `settlement_window_requests{${labels},outcome="success"} ${success}`,
      `settlement_window_requests{${labels},outcome="failure"} ${failure}`,
      '# TYPE settlement_window_start_seconds gauge',
      `settlement_window_start_seconds{${labels}} ${start}`,
      '# TYPE settlement_window_end_seconds gauge',
      `settlement_window_end_seconds{${labels}} ${end}`,
      '',
    ].join('\n');
  }

  private createSnapshot(scenario: SettlementScenario) {
    const end = Math.floor(this.now() / 1000);
    if (!Number.isSafeInteger(end) || end < 300) throw new RangeError('INVALID_SIMULATOR_TIME');
    switch (scenario) {
      case 'normal': return { start: end - 300, end, success: 100, failure: 0 };
      case 'settlement_failure': return { start: end - 300, end, success: 85, failure: 15 };
      case 'low_sample': return { start: end - 300, end, success: 2, failure: 8 };
      default: throw new RangeError('INVALID_SIMULATOR_SCENARIO');
    }
  }
}
