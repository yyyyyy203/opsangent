import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../src/contracts/index.js';
import {
  parseStructuredHistorySummary,
  type CompressionTrace,
} from '../src/contracts/index.js';

const context: AgentContext = {
  runId: 'run-1',
  status: 'running',
  stage: 'evidence_collection',
  profileId: 'group-buy-market',
  messages: [],
  pendingToolCalls: [],
  confirmedToolCallIds: [],
  rejectedToolCallIds: [],
  executedActions: [],
  evidenceIds: [],
  missingEvidence: [],
  budget: {
    startedAt: '2026-09-14T00:00:00.000Z',
    maxIterations: 8,
    iteration: 1,
    maxToolCalls: 16,
    toolCallsUsed: 0,
    maxDurationMs: 60_000,
  },
  contextVersion: 1,
};

describe('context compression contracts', () => {
  it('parses a strict structured history summary', () => {
    expect(parseStructuredHistorySummary({
      confirmedFacts: ['failure rate exceeded threshold'],
      hypotheses: ['settlement dependency is degraded'],
      missingEvidence: ['trace'],
      pendingActionIds: [],
      executedActionIds: ['call-1'],
      unresolvedRisks: ['impact surface unavailable'],
      sourceMessageIds: ['message-1'],
      keyToolCalls: ['call-1'],
      evidenceIds: ['evidence-1'],
      confirmationIds: [],
      riskRuleIds: ['impact.unavailable'],
      summaryVersion: 1,
    })).toMatchObject({
      sourceMessageIds: ['message-1'],
      summaryVersion: 1,
    });
  });

  it('rejects unknown fields and invalid summary versions', () => {
    expect(() => parseStructuredHistorySummary({
      confirmedFacts: [],
      hypotheses: [],
      missingEvidence: [],
      pendingActionIds: [],
      executedActionIds: [],
      unresolvedRisks: [],
      sourceMessageIds: [],
      keyToolCalls: [],
      evidenceIds: [],
      confirmationIds: [],
      riskRuleIds: [],
      summaryVersion: -1,
      unexpected: true,
    })).toThrow();
  });

  it('keeps compression trace additive and context immutable', () => {
    const trace: CompressionTrace = {
      sourceMessageIds: ['message-1'],
      protectedMessageIds: ['message-2'],
      keyToolCalls: ['call-1'],
      evidenceIds: ['evidence-1'],
      summaryVersion: 1,
    };
    const result = {
      context,
      decision: { level: 'L1' as const, reason: 'message_count' },
      trace,
      validation: { status: 'valid' as const },
    };

    expect(result.context).toBe(context);
    expect(result.trace.summaryVersion).toBe(1);
  });
});
