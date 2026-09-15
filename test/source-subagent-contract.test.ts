import { describe, expect, it } from 'vitest';
import {
  canonicalSourceToolName,
  type SourceSubagentResult,
  type ToolCallOptions,
} from '../src/contracts/index.js';

describe('source subagent contracts', () => {
  it('maps each source to its immutable canonical Tool name', () => {
    expect(canonicalSourceToolName('logs')).toBe('logs_subagent');
    expect(canonicalSourceToolName('metrics')).toBe('metrics_subagent');
    expect(canonicalSourceToolName('traces')).toBe('traces_subagent');
  });

  it('keeps source results structured and accepts host-injected profile scope', () => {
    const result = {
      source: 'logs',
      status: 'partial',
      summary: '结算服务存在部分异常日志证据。',
      findings: [{ kind: 'observation', statement: '发现超时异常', evidenceIds: ['evidence-1'] }],
      evidenceIds: ['evidence-1'],
      businessTraceIds: ['trace-1'],
      missingEvidence: ['完整时间窗口仍有缺口'],
      coverage: 0.5,
      toolCallsUsed: 2,
      durationMs: 120,
    } satisfies SourceSubagentResult;
    const options: ToolCallOptions = {
      toolCallId: 'tool-1',
      runId: 'run-1',
      stepId: 'step-1',
      profileId: 'group-buy-market',
      profileRevision: 'profile-v1',
      signal: new AbortController().signal,
      mode: 'execute',
    };

    expect(result.source).toBe('logs');
    expect(options.profileId).toBe('group-buy-market');
    expect(options.profileRevision).toBe('profile-v1');
  });
});
