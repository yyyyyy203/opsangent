import { describe, expect, it } from 'vitest';
import { SettlementSimulator, type SettlementScenario } from '../src/infrastructure/simulator/settlement-simulator.js';
import { generateScenarioLogs } from '../src/infrastructure/simulator/log-fixtures.js';

const cases: readonly [SettlementScenario, number, number, number][] = [
  ['normal', 100, 0, 100],
  ['settlement_failure', 85, 15, 100],
  ['low_sample', 2, 8, 10],
];

describe('scenario log fixtures', () => {
  it.each(cases)('%s shares exact metric counts and window', async (scenario, success, failure, total) => {
    const simulator = new SettlementSimulator(() => 1_790_985_900_000);
    simulator.select(scenario);
    const snapshot = simulator.currentSnapshot();
    const records = [];
    for await (const record of generateScenarioLogs(snapshot, scenario)) records.push(record);
    expect(snapshot).toMatchObject({ success, failure, end: 1_790_985_900, start: 1_790_985_600 });
    expect(records).toHaveLength(total);
    expect(records.filter((record) => record.exception === 'SQLTimeoutException')).toHaveLength(failure);
    expect(records.every((record) => Date.parse(record.timestamp) >= snapshot.start * 1000
      && Date.parse(record.timestamp) < snapshot.end * 1000)).toBe(true);
    expect(records.filter((record) => record.exception === 'SQLTimeoutException')
      .every((record) => Date.parse(record.timestamp) >= (snapshot.end - 30) * 1000)).toBe(true);
    expect(new Set(records.map((record) => record.traceId)).size).toBe(1);
    expect(simulator.exposition()).toContain(`outcome="success"} ${success}`);
    expect(simulator.exposition()).toContain(`outcome="failure"} ${failure}`);
  });

  it('returns a frozen copy that cannot change the simulator snapshot', () => {
    let now = 1_790_985_900_000;
    const simulator = new SettlementSimulator(() => now);
    const snapshot = simulator.currentSnapshot();
    now += 60_000;
    expect(simulator.currentSnapshot()).toEqual(snapshot);
    expect(simulator.currentSnapshot()).not.toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
