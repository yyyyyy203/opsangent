import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  canonicalSourceToolName,
  type SourceEvidenceObservation,
  type SourceSubagentDescriptor,
  type SourceSubagentExecution,
  type SourceSubagentResult,
  type SourceSubagentRunner,
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

  it('keeps the source evidence observation contract structured and versioned', () => {
    const observation = {
      schemaVersion: 1,
      source: 'metrics',
      evidenceId: 'metric-evidence-1',
      state: 'committed',
      coverage: 1,
      timeRange: {
        start: '2026-09-15T00:00:00.000Z',
        end: '2026-09-15T00:05:00.000Z',
      },
      missingEvidence: [],
    } satisfies SourceEvidenceObservation;

    expect(observation.source).toBe('metrics');
  });

  it('supports an optional host request validator without changing legacy descriptors', () => {
    const runner = {} as SourceSubagentRunner;
    const descriptor = {
      publicToolName: 'metrics_subagent',
      subagentType: 'metrics',
      description: 'metrics evidence collection',
      inputSchema: z.object({}).strict(),
      runner,
      childRunId: () => 'child-1',
      validateRequest: (request, execution) => {
        expect(request.profileId).toBe(execution.profileId);
      },
    } satisfies SourceSubagentDescriptor;
    const legacyDescriptor = {
      publicToolName: 'logs_subagent',
      subagentType: 'logs',
      description: 'logs evidence collection',
      inputSchema: z.object({}).strict(),
      runner,
      childRunId: () => 'child-2',
    } satisfies SourceSubagentDescriptor;
    const execution: Omit<SourceSubagentExecution, 'childRunId'> = {
      parentRunId: 'parent-1',
      parentToolCallId: 'tool-1',
      parentStepId: 'step-1',
      profileId: 'group-buy-market',
      signal: new AbortController().signal,
    };

    expect(descriptor.validateRequest?.({
      profileId: 'group-buy-market', service: 'checkout', start: '2026-09-15T00:00:00.000Z',
      end: '2026-09-15T00:05:00.000Z', question: '检查失败率', evidenceIds: [],
    }, execution)).toBeUndefined();
    expect('validateRequest' in legacyDescriptor).toBe(false);
  });
});
