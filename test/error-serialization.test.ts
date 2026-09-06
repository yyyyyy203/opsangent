import { expect, it } from 'vitest';
import { toAgentError } from '../src/contracts/errors.js';
import { SourceFailure } from '../src/mcp/resilience.js';

it('preserves error codes across checkpoint structured cloning', () => {
  const result = structuredClone(toAgentError(new SourceFailure('STORAGE_ERROR')));
  expect(result).toEqual({ code: 'STORAGE_ERROR', message: 'Source operation failed: STORAGE_ERROR', retryable: false });
});
