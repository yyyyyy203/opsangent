import { describe, expect, it } from 'vitest';
import { SmokeOutputBudget } from '../src/model/smoke-output-budget.js';

describe('SmokeOutputBudget', () => {
  it('atomically reserves at most 5120 tokens across concurrent callers', async () => {
    const budget = new SmokeOutputBudget();
    const reservations = await Promise.all(Array.from({ length: 6 }, () => Promise.resolve(budget.reserve(1024))));
    expect(reservations.filter((value) => value !== undefined)).toHaveLength(5);
    expect(budget.snapshot()).toEqual({ limit: 5120, reserved: 5120, settled: 0, available: 0, reservations: 5, settlements: 0, rejected: 1 });
  });

  it('settles one reservation once and refunds only its unused capacity', () => {
    const budget = new SmokeOutputBudget();
    const query = budget.reserve(512)!;
    const report = budget.reserve(1024)!;
    expect(budget.settle(query, 120)).toBe(true);
    expect(budget.settle(query, 0)).toBe(false);
    expect(budget.snapshot()).toEqual({ limit: 5120, reserved: 1024, settled: 120, available: 3976, reservations: 2, settlements: 1, rejected: 0 });
    expect(budget.settle(report, 900)).toBe(true);
    expect(budget.snapshot()).toMatchObject({ reserved: 0, settled: 1020, available: 4100, settlements: 2 });
  });

  it('does not refund unknown or foreign reservation handles', () => {
    const budget = new SmokeOutputBudget();
    const other = new SmokeOutputBudget();
    const reserved = budget.reserve(512)!;
    expect(budget.settle(other.reserve(512)!, 0)).toBe(false);
    expect(budget.settle({ maxOutputTokens: 512 }, 0)).toBe(false);
    expect(budget.snapshot()).toMatchObject({ reserved: 512, settled: 0, available: 4608 });
    expect(Object.isFrozen(reserved)).toBe(true);
  });

  it.each([-1, 513, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('retains a reservation for invalid settlement %s', (outputTokens) => {
    const budget = new SmokeOutputBudget();
    const reservation = budget.reserve(512)!;
    expect(budget.settle(reservation, outputTokens)).toBe(false);
    expect(budget.snapshot()).toMatchObject({ reserved: 512, settled: 0, available: 4608, settlements: 0 });
  });

  it('permits trusted zero usage and usage exactly equal to the cap', () => {
    const budget = new SmokeOutputBudget(1024);
    const first = budget.reserve(512)!;
    const second = budget.reserve(512)!;
    expect(budget.settle(first, 0)).toBe(true);
    expect(budget.settle(second, 512)).toBe(true);
    expect(budget.snapshot()).toMatchObject({ limit: 1024, reserved: 0, settled: 512, available: 512 });
    expect(budget.reserve(512)).toBeDefined();
    expect(budget.reserve(1)).toBeUndefined();
  });

  it.each([0, -1, 5121, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid shared limits %s', (limit) => {
    expect(() => new SmokeOutputBudget(limit)).toThrow(RangeError);
  });

  it.each([0, -1, 1025, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid reservation caps %s without changing state', (cap) => {
    const budget = new SmokeOutputBudget();
    expect(() => budget.reserve(cap)).toThrow(RangeError);
    expect(budget.snapshot()).toMatchObject({ reserved: 0, settled: 0, available: 5120, reservations: 0, rejected: 0 });
  });

  it('returns detached numeric snapshots without handles or caller data', () => {
    const budget = new SmokeOutputBudget();
    const before = budget.snapshot();
    budget.reserve(512);
    expect(before).toMatchObject({ reserved: 0, available: 5120 });
    expect(Object.values(budget.snapshot()).every((value) => typeof value === 'number')).toBe(true);
  });
});
