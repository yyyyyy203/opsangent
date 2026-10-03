import { describe, expect, it } from 'vitest';
import { logsLabQueryPolicy, validateLogsScope } from '../src/profiles/logs.js';

const freshScope = {
  service: 'checkout',
  start: '2026-10-03T00:00:00Z',
  end: '2026-10-03T00:05:00Z',
};

describe('logs lab query policy', () => {
  it('accepts a fresh checkout window of exactly five minutes', () => {
    expect(() => validateLogsScope(
      freshScope, logsLabQueryPolicy, Date.parse('2026-10-03T00:06:00Z'),
    )).not.toThrow();
  });

  it('rejects stale scopes instead of accepting fake healthy data', () => {
    expect(() => validateLogsScope({
      service: 'checkout', start: '2026-10-03T00:00:00Z',
      end: '2026-10-03T00:05:00Z',
    }, logsLabQueryPolicy, Date.parse('2026-10-03T00:07:01Z'))).toThrow();
  });

  it('rejects a scope for any service other than checkout', () => {
    expect(() => validateLogsScope(
      { ...freshScope, service: 'payments' }, logsLabQueryPolicy, Date.parse('2026-10-03T00:06:00Z'),
    )).toThrow();
  });

  it('rejects reversed or empty windows', () => {
    expect(() => validateLogsScope({
      service: 'checkout', start: '2026-10-03T00:05:00Z', end: '2026-10-03T00:05:00Z',
    }, logsLabQueryPolicy, Date.parse('2026-10-03T00:06:00Z'))).toThrow();
    expect(() => validateLogsScope({
      service: 'checkout', start: '2026-10-03T00:05:01Z', end: '2026-10-03T00:05:00Z',
    }, logsLabQueryPolicy, Date.parse('2026-10-03T00:06:00Z'))).toThrow();
  });

  it('rejects a window whose duration is not exactly five minutes', () => {
    expect(() => validateLogsScope({
      service: 'checkout', start: '2026-10-03T00:00:01Z', end: '2026-10-03T00:05:00Z',
    }, logsLabQueryPolicy, Date.parse('2026-10-03T00:06:00Z'))).toThrow();
  });

  it('rejects windows ending more than thirty seconds in the future', () => {
    expect(() => validateLogsScope({
      service: 'checkout', start: '2026-10-03T00:00:31Z', end: '2026-10-03T00:05:31Z',
    }, logsLabQueryPolicy, Date.parse('2026-10-03T00:05:00Z'))).toThrow();
  });

  it('rejects timestamps without a timezone or with an impossible date', () => {
    expect(() => validateLogsScope({ ...freshScope, start: '2026-10-03T00:00:00' }, logsLabQueryPolicy, Date.parse('2026-10-03T00:06:00Z'))).toThrow();
    expect(() => validateLogsScope({ ...freshScope, start: '2026-02-30T00:00:00Z' }, logsLabQueryPolicy, Date.parse('2026-10-03T00:06:00Z'))).toThrow();
  });
});
