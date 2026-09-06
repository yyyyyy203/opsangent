import { describe, expect, it } from 'vitest';
import { SettlementSimulator } from '../src/infrastructure/simulator/settlement-simulator.js';
import { assessSettlementMetrics } from '../src/profiles/settlement.js';

describe('settlement telemetry and deterministic assessment', () => {
  it('exposes a fixed five-minute evidence window without an answer label', () => {
    const simulator = new SettlementSimulator(() => 1_000_000);
    simulator.select('settlement_failure');
    const text = simulator.exposition();
    expect(text).toContain('settlement_window_requests{service="checkout",environment="simulation",outcome="success"} 85');
    expect(text).toContain('settlement_window_requests{service="checkout",environment="simulation",outcome="failure"} 15');
    expect(text).toContain('settlement_window_start_seconds{service="checkout",environment="simulation"} 700');
    expect(text).toContain('settlement_window_end_seconds{service="checkout",environment="simulation"} 1000');
    expect(text).not.toContain('settlement_failure');
    expect(text).not.toContain('mysql');
  });
  it('calculates 15 percent and compares it to the Profile threshold', () => {
    expect(assessSettlementMetrics({ total: 100, failed: 15 }, { threshold: 0.05, minSamples: 20 })).toEqual({ status: 'breached', total: 100, failed: 15, failureRate: 0.15, threshold: 0.05, minSamples: 20 });
  });
  it('does not claim healthy with missing or insufficient samples', () => {
    expect(assessSettlementMetrics({ total: 0, failed: 0 }, { threshold: 0.05, minSamples: 20 }).status).toBe('insufficient_data');
    expect(assessSettlementMetrics({ total: 10, failed: 8 }, { threshold: 0.05, minSamples: 20 }).status).toBe('insufficient_data');
  });
  it.each([{ total: 10, failed: 11 }, { total: -1, failed: 0 }, { total: 10.5, failed: 1 }, { total: 10, failed: NaN }])('rejects impossible snapshot counts: %j', (counts) => {
    expect(() => assessSettlementMetrics(counts, { threshold: 0.05, minSamples: 20 })).toThrow();
  });
  it('normal snapshots clear the previous fault counts', () => {
    const simulator = new SettlementSimulator(() => 1_000_000);
    simulator.select('settlement_failure');
    simulator.select('normal');
    expect(simulator.exposition()).toContain('outcome="failure"} 0');
  });
  it('keeps the window fixed across scrapes until a new scenario is selected', () => {
    let now = 1_000_000;
    const simulator = new SettlementSimulator(() => now);
    const first = simulator.exposition();
    now += 60_000;
    expect(simulator.exposition()).toBe(first);
    simulator.select('low_sample');
    expect(simulator.exposition()).toContain('outcome="success"} 2');
    expect(simulator.exposition()).toContain('outcome="failure"} 8');
    expect(simulator.exposition()).toContain('environment="simulation"} 1060');
  });
  it('treats threshold equality as not breached and keeps zero rate explicit', () => {
    expect(assessSettlementMetrics({ total: 100, failed: 5 }, { threshold: 0.05, minSamples: 20 }).status).toBe('healthy');
    expect(assessSettlementMetrics({ total: 100, failed: 0 }, { threshold: 0.05, minSamples: 20 }).failureRate).toBe(0);
    expect(assessSettlementMetrics({ total: 0, failed: 0 }, { threshold: 0.05, minSamples: 20 }).failureRate).toBeNull();
  });
  it.each([{ threshold: NaN, minSamples: 20 }, { threshold: -1, minSamples: 20 }, { threshold: 1.1, minSamples: 20 }, { threshold: 0.05, minSamples: 0 }, { threshold: 0.05, minSamples: 1.5 }])('rejects invalid Profile rules: %j', (rule) => {
    expect(() => assessSettlementMetrics({ total: 100, failed: 15 }, rule)).toThrow('INVALID_SETTLEMENT_RULE');
  });
});
