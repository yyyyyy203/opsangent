export interface SettlementCounts {
  total: number;
  failed: number;
}

export interface SettlementRule {
  threshold: number;
  minSamples: number;
}

export const settlementLabRule: Readonly<SettlementRule> = Object.freeze({
  threshold: 0.05,
  minSamples: 20,
});

/** Snapshot counts only: counter estimates from increase() need a different profile. */
export function assessSettlementMetrics(counts: SettlementCounts, rule: SettlementRule) {
  if (!Number.isSafeInteger(counts.total) || !Number.isSafeInteger(counts.failed)
    || counts.total < 0 || counts.failed < 0 || counts.failed > counts.total) {
    throw new RangeError('INVALID_SETTLEMENT_COUNTS');
  }
  if (!Number.isFinite(rule.threshold) || rule.threshold < 0 || rule.threshold > 1
    || !Number.isSafeInteger(rule.minSamples) || rule.minSamples < 1) {
    throw new RangeError('INVALID_SETTLEMENT_RULE');
  }
  const failureRate = counts.total === 0 ? null : counts.failed / counts.total;
  const status: 'insufficient_data' | 'breached' | 'healthy' =
    counts.total < rule.minSamples || failureRate === null ? 'insufficient_data'
      : failureRate > rule.threshold ? 'breached' : 'healthy';
  return { status, ...counts, failureRate, ...rule };
}
