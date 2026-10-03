import type { NormalizedLogRecord } from '../../contracts/storage.js';
import type { SettlementScenario } from './settlement-simulator.js';

export interface SettlementFixtureSnapshot {
  readonly start: number;
  readonly end: number;
  readonly success: number;
  readonly failure: number;
}

/** One record per simulated request, emitted without retaining the fixture in memory. */
// AsyncIterable is the fixture boundary; generation itself has no I/O.
// eslint-disable-next-line @typescript-eslint/require-await
export async function* generateScenarioLogs(
  snapshot: SettlementFixtureSnapshot,
  scenario: SettlementScenario,
): AsyncIterable<NormalizedLogRecord> {
  const expected = scenario === 'normal' ? [100, 0] : scenario === 'settlement_failure' ? [85, 15] : [2, 8];
  if (snapshot.end - snapshot.start !== 300 || snapshot.success !== expected[0] || snapshot.failure !== expected[1]) {
    throw new RangeError('FIXTURE_SNAPSHOT_MISMATCH');
  }
  const traceId = `lab-checkout-${snapshot.end}`;
  for (let i = 0; i < snapshot.success; i++) {
    const second = snapshot.start + Math.floor((i * 270) / Math.max(1, snapshot.success));
    yield {
      timestamp: new Date(second * 1000).toISOString(), service: 'checkout', level: 'INFO',
      message: 'Checkout settled', traceId,
    };
  }
  for (let i = 0; i < snapshot.failure; i++) {
    const second = snapshot.end - 30 + Math.floor((i * 30) / snapshot.failure);
    yield {
      timestamp: new Date(second * 1000).toISOString(), service: 'checkout', level: 'ERROR',
      message: 'Checkout settlement timed out', exception: 'SQLTimeoutException', traceId,
    };
  }
}
