import { describe, expect, it } from 'vitest';
import type { LogEvidenceQuery } from '../src/contracts/index.js';
import type { ElkEvidenceQuery } from '../src/infrastructure/elk/paged-evidence-source.js';

const query: LogEvidenceQuery = {
  service: 'checkout',
  start: '2026-10-03T00:00:00Z',
  end: '2026-10-03T00:05:00Z',
  level: 'ERROR',
};

const legacyQuery: ElkEvidenceQuery = query;

describe('shared log evidence query contract', () => {
  it('keeps the existing ELK query import structurally compatible', () => {
    expect(legacyQuery).toEqual(query);
  });
});
