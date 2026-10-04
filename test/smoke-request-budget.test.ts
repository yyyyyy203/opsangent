import { describe, expect, it } from 'vitest';
import { SmokeRequestBudget } from '../src/model/smoke-request-budget.js';

describe('SmokeRequestBudget', () => {
  it('reserves a shared limit atomically before concurrent requests are sent', () => {
    const budget = new SmokeRequestBudget(10);
    const reservations = Array.from({ length: 11 }, () => budget.reserve());

    for (const reserved of reservations.slice(0, 10)) {
      expect(reserved).toBe(true);
      budget.markSent();
    }

    expect(reservations[10]).toBe(false);
    expect(budget.snapshot()).toEqual({ limit: 10, attempted: 11, sent: 10, rejected: 1 });
  });

  it('records local rejection without returning the reserved request slot', () => {
    const budget = new SmokeRequestBudget(2);
    expect(budget.reserve()).toBe(true);
    budget.rejectReserved();
    expect(budget.reserve()).toBe(true);
    budget.markSent();
    expect(budget.reserve()).toBe(false);
    expect(budget.snapshot()).toEqual({ limit: 2, attempted: 3, sent: 1, rejected: 2 });
  });

  it('rejects invalid limits and ledger transitions', () => {
    expect(() => new SmokeRequestBudget(0)).toThrow(RangeError);
    expect(() => new SmokeRequestBudget(11)).toThrow(RangeError);
    const budget = new SmokeRequestBudget(1);
    expect(() => budget.markSent()).toThrow(RangeError);
    expect(() => budget.rejectReserved()).toThrow(RangeError);
  });
});
