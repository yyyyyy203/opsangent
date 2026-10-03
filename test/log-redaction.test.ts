import { describe, expect, it } from 'vitest';
import { redactLogRecord } from '../src/contracts/log-redaction.js';
import type { NormalizedLogRecord } from '../src/contracts/index.js';

describe('redactLogRecord', () => {
  it('redacts nested sensitive fields and credential text while preserving ordinary values', () => {
    const record: NormalizedLogRecord = {
      timestamp: '2026-10-03T00:00:00Z',
      service: 'checkout',
      message: 'authorization failed: Bearer abc.def',
      fields: {
        request: {
          password: 'private',
          note: 'sk-abcdefghijklmnop',
          route: '/checkout/submit',
        },
      },
    };

    expect(redactLogRecord(record)).toEqual({
      timestamp: '2026-10-03T00:00:00Z',
      service: 'checkout',
      message: '[REDACTED]',
      fields: {
        request: {
          password: '[REDACTED]',
          note: '[REDACTED]',
          route: '/checkout/submit',
        },
      },
    });
  });

  it('keeps redaction idempotent', () => {
    const record: NormalizedLogRecord = {
      timestamp: '2026-10-03T00:00:00Z',
      exception: 'Bearer secret-value',
      fields: { nested: [{ token: 'secret', message: 'sk-abcdefghijklmnop' }] },
    };

    const once = redactLogRecord(record);
    expect(redactLogRecord(once)).toEqual(once);
  });
});
