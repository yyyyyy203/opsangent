import { describe, expect, it } from 'vitest';
import type {
  EvidenceCaptureBudget,
  EvidenceManifestSummary,
  EvidenceSourcePage,
  ToolExecutionResult,
} from '../src/contracts/index.js';
import { assertEvidenceCaptureBudget } from '../src/contracts/index.js';
import type { ToolResultCompactor } from '../src/context-compressor/types.js';

describe('L0 evidence contracts', () => {
  it('represents one bounded source page without a storage path', () => {
    const page: EvidenceSourcePage = {
      records: [{
        timestamp: '2026-09-13T00:00:00.000Z',
        level: 'ERROR',
        message: 'redacted',
      }],
      encodedBytes: 64,
    };

    expect(page.nextCursor).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain('storageKey');
  });

  it('keeps the capture budget explicit and bounded', () => {
    const budget: EvidenceCaptureBudget = {
      maxSourceBytes: 64 * 1024 * 1024,
      maxRecords: 50_000,
      maxDurationMs: 60_000,
      maxModelSummaryBytes: 16 * 1024,
      maxSamples: 20,
    };

    expect(budget.maxSourceBytes).toBe(64 * 1024 * 1024);
    expect(budget.maxSamples).toBe(20);
  });

  it('rejects a non-positive capture budget at the contract boundary', () => {
    expect(typeof assertEvidenceCaptureBudget).toBe('function');
    expect(() => assertEvidenceCaptureBudget({
      maxSourceBytes: 0,
      maxRecords: 1,
      maxDurationMs: 1,
      maxModelSummaryBytes: 1,
      maxSamples: 1,
    })).toThrow();
  });

  it('keeps storage keys out of the model-facing manifest summary', () => {
    const summary: EvidenceManifestSummary = {
      manifestId: 'manifest-1',
      evidenceId: 'evidence-1',
      runId: 'run-1',
      stepId: 'step-1',
      toolCallId: 'call-1',
      captureKey: 'capture-1',
      source: 'log',
      state: 'partial',
      queryDigest: 'query-digest',
      timeRange: {
        start: '2026-09-13T00:00:00.000Z',
        end: '2026-09-13T00:01:00.000Z',
      },
      recordCount: 1,
      sourceBytes: 64,
      storedBytes: 48,
      chunkCount: 1,
      rawSha256: 'a'.repeat(64),
      compression: 'gzip_ndjson',
      coverage: 0.5,
      truncated: true,
      missingEvidence: ['ELK_CAPTURE_BYTE_BUDGET_EXCEEDED'],
      redactionPolicyVersion: 'redaction/v1',
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:01:00.000Z',
    };

    expect(Object.keys(summary)).not.toContain('storageKey');
    expect(JSON.stringify(summary)).not.toContain('storageKey');
  });

  it('exposes compaction separately from the legacy EvidenceStore raw field', () => {
    const result: ToolExecutionResult = {
      toolCallId: 'call-1',
      toolName: 'logs.capture',
      status: 'success',
      startedAt: '2026-09-13T00:00:00.000Z',
    };
    const compactor: ToolResultCompactor = {
      compact: (input) => ({
        result: input,
        decision: { level: 'none', originalBytes: 0, modelBytes: 0 },
      }),
    };

    expect(compactor.compact(result).decision.level).toBe('none');
  });
});
