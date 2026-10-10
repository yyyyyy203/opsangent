import type { MemoryErrorCode } from '../contracts/diagnostic-memory.js';

const messages: Readonly<Record<MemoryErrorCode, string>> = {
  MEMORY_SCOPE_INVALID: 'Memory scope is invalid.',
  MEMORY_DATA_INVALID: 'Memory data is invalid.',
  MEMORY_REVISION_CONFLICT: 'Memory revision conflicts with the request.',
  MEMORY_REQUEST_CONFLICT: 'Memory request conflicts with an earlier request.',
  MEMORY_APPROVAL_DENIED: 'Memory approval is denied.',
  MEMORY_EVIDENCE_UNAVAILABLE: 'Memory evidence is unavailable.',
  MEMORY_SOURCE_CONFLICT: 'Memory source conflicts with the saved version.',
  MEMORY_RUN_NOT_TERMINAL: 'Memory source run has not finished.',
  MEMORY_POLICY_DENIED: 'Memory policy denies this operation.',
  MEMORY_CAPACITY_EXCEEDED: 'Memory capacity is exceeded.',
  MEMORY_LOOKUP_FAILED: 'Memory lookup failed.',
  MEMORY_CAPTURE_FAILED: 'Memory capture failed.',
  MEMORY_DISABLED: 'Memory is disabled.',
};

/** Carries only a stable code and fixed safe text, never an underlying error or payload. */
export class MemoryError extends Error {
  public constructor(public readonly code: MemoryErrorCode) {
    super(messages[code]);
    this.name = 'MemoryError';
  }
}
