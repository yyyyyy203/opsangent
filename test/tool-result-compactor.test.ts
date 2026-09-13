import { describe, expect, it } from 'vitest';
import type { ToolExecutionResult } from '../src/contracts/index.js';
import { canonicalJson } from '../src/contracts/stable-json.js';
import { DefaultToolResultCompactor, ToolResultCompactionError } from '../src/context-compressor/tool-result-compactor.js';

function result(response: ToolExecutionResult['response']): ToolExecutionResult {
  const base: ToolExecutionResult = {
    toolCallId: 'call-1',
    toolName: 'logs_subagent',
    status: 'success',
    startedAt: '2026-09-13T00:00:00.000Z',
    finishedAt: '2026-09-13T00:00:01.000Z',
  };
  return response === undefined ? base : { ...base, response };
}

describe('DefaultToolResultCompactor', () => {
  it('leaves bounded results unchanged', () => {
    const input = result({ blocks: [{ type: 'text', text: 'ok' }] });
    const compaction = new DefaultToolResultCompactor({ maxBytes: 16 * 1024 }).compact(input);

    expect(compaction.decision.level).toBe('none');
    expect(compaction.result).toBe(input);
  });

  it('keeps evidence references while removing oversized model content', () => {
    const input = result({
      blocks: [
        { type: 'text', text: 'raw-log-marker-' + 'x'.repeat(20_000) },
        { type: 'evidence_ref', evidenceId: 'evidence-1' },
      ],
      evidenceIds: ['evidence-1'],
      metadata: { privateRaw: 'raw-log-marker-' + 'x'.repeat(20_000) },
    });
    const compaction = new DefaultToolResultCompactor({ maxBytes: 1024 }).compact(input);
    const response = compaction.result.response;

    expect(compaction.decision.level).toBe('L0');
    expect(compaction.decision.originalBytes).toBeGreaterThan(20_000);
    expect(Buffer.byteLength(canonicalJson(response), 'utf8')).toBeLessThanOrEqual(1024);
    expect(response?.evidenceIds).toEqual(['evidence-1']);
    expect(response?.blocks).toContainEqual({ type: 'evidence_ref', evidenceId: 'evidence-1' });
    expect(JSON.stringify(response)).not.toContain('raw-log-marker');
    expect(response?.metadata).toBeUndefined();
  });

  it('fails closed when an oversized result has no committed evidence reference', () => {
    const input = result({ blocks: [{ type: 'text', text: 'unbounded-' + 'x'.repeat(20_000) }] });

    expect(() => new DefaultToolResultCompactor({ maxBytes: 1024 }).compact(input)).toThrow(ToolResultCompactionError);
    try {
      new DefaultToolResultCompactor({ maxBytes: 1024 }).compact(input);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'BUDGET_EXCEEDED',
        details: { category: 'tool_result_too_large' },
      });
    }
  });
});
