import { describe, expect, it } from 'vitest';
import { agentMessageV2Schema, parseAgentMessageV2 } from '../src/contracts/message-v2/index.js';

const baseMessage = {
  schemaVersion: 2,
  id: 'message-1',
  runId: 'run-1',
  role: 'assistant',
  status: 'completed',
  visibility: 'user',
  createdAt: '2026-09-07T10:00:00.000Z',
};

const blockFor = (type: string, blockId: string | undefined = 'block-1'): Record<string, unknown> => ({
  type,
  ...(blockId === undefined ? {} : { blockId }),
  ...(type === 'text' ? { text: '检查已完成。' } : {}),
  ...(type === 'reasoning_summary' ? { summary: '已检查结算失败率。' } : {}),
  ...(type === 'tool_call' ? { call: { id: 'call-1', name: 'metrics.query', input: { window: '5m' } } } : {}),
  ...(type === 'raw_tool_call' ? { call: { id: 'call-1', name: 'metrics.query', arguments: '{"window":"5m"}' } } : {}),
  ...(type === 'tool_result' ? {
    result: {
      toolCallId: 'call-1', toolName: 'metrics.query', status: 'success', startedAt: '2026-09-07T10:00:00.000Z',
    },
    attempt: { attemptId: 'attempt-1', number: 1 },
    evidenceIds: ['evidence-1'],
  } : {}),
  ...(type === 'evidence_ref' ? { evidenceId: 'evidence-1', summary: '失败率升高', source: 'prometheus', retrievable: true } : {}),
  ...(type === 'artifact_ref' ? {
    artifactId: 'artifact-1', uri: 'artifact://report-1', mediaType: 'text/markdown', sizeBytes: 128, sha256: 'abc123', accessPolicy: 'audit',
  } : {}),
  ...(type === 'image_ref' ? {
    imageId: 'image-1', uri: 'artifact://chart-1', mediaType: 'image/png', sizeBytes: 256, sha256: 'def456', accessPolicy: 'user',
  } : {}),
  ...(type === 'context_summary' ? {
    summary: {
      confirmedFacts: [], hypotheses: [], missingEvidence: [], pendingActionIds: [], executedActionIds: [], unresolvedRisks: [],
    },
  } : {}),
  ...(type === 'confirmation_request' ? {
    confirmationId: 'confirmation-1', toolCallIds: ['call-1'], riskSummary: '需要人工确认', expiresAt: '2026-09-07T11:00:00.000Z',
  } : {}),
  ...(type === 'confirmation_result' ? {
    confirmationId: 'confirmation-1', decision: 'approved', actor: 'operator-1', toolCallIds: ['call-1'], decidedAt: '2026-09-07T10:10:00.000Z',
  } : {}),
  ...(type === 'diagnosis' ? {
    outcome: 'partial', rootCauseCandidates: [{ summary: '结算服务过载', confidence: 'medium' }], evidenceIds: ['evidence-1'], missingEvidence: [], limitations: [],
  } : {}),
  ...(type === 'action_proposal' ? {
    actionId: 'action-1', toolCallId: 'call-1', risk: 'HIGH', expectedEffect: '降低结算失败率', verificationPlan: '比较五分钟失败率。',
  } : {}),
  ...(type === 'action_result' ? {
    actionId: 'action-1', toolCallId: 'call-1', result: { status: 'success' }, idempotencyKey: 'idempotency-1', verificationEvidenceIds: ['evidence-1'], uncertainty: false,
  } : {}),
  ...(type === 'error' ? { error: { code: 'TOOL_ERROR', message: '查询失败', retryable: true } } : {}),
});

describe('Message V2 contracts', () => {
  it('round-trips a completed V2 message with evidence and diagnosis blocks', () => {
    const parsed = parseAgentMessageV2({
      ...baseMessage,
      blocks: [blockFor('text'), blockFor('evidence_ref', 'block-2'), blockFor('diagnosis', 'block-3')],
      metadata: { source: 'test', nested: { valid: true } },
      completedAt: '2026-09-07T10:01:00.000Z',
    });

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.blocks.map((block) => block.type)).toEqual(['text', 'evidence_ref', 'diagnosis']);
  });

  it.each([
    'text', 'reasoning_summary', 'tool_call', 'raw_tool_call', 'tool_result', 'evidence_ref', 'artifact_ref', 'image_ref',
    'context_summary', 'confirmation_request', 'confirmation_result', 'diagnosis', 'action_proposal', 'action_result', 'error',
  ])('%s has a stable blockId', (type) => {
    const block = blockFor(type);
    delete block.blockId;
    expect(() => parseAgentMessageV2({ ...baseMessage, blocks: [block] })).toThrow();
  });

  it('permits raw tool calls only in audit-visible messages', () => {
    expect(() => parseAgentMessageV2({ ...baseMessage, visibility: 'user', blocks: [blockFor('raw_tool_call')] })).toThrow();
    expect(parseAgentMessageV2({ ...baseMessage, visibility: 'audit', blocks: [blockFor('raw_tool_call')] }).blocks[0]?.type).toBe('raw_tool_call');
  });

  it.each([
    [{ callback: () => undefined }],
    [{ error: new Error('not JSON') }],
    [{ missing: undefined }],
    [{ value: Number.POSITIVE_INFINITY }],
    [{ value: new Date() }],
  ])('rejects non-JSON metadata', (metadata) => {
    expect(() => parseAgentMessageV2({ ...baseMessage, blocks: [blockFor('text')], metadata })).toThrow();
  });

  it('rejects cyclic metadata, unknown blocks, and invalid timestamps', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => parseAgentMessageV2({ ...baseMessage, blocks: [blockFor('text')], metadata: cyclic })).toThrow();
    expect(() => parseAgentMessageV2({ ...baseMessage, blocks: [{ type: 'unsupported', blockId: 'block-1' }] })).toThrow();
    expect(() => parseAgentMessageV2({ ...baseMessage, createdAt: 'not-a-date', blocks: [blockFor('text')] })).toThrow();
  });

  it('rejects non-object metadata through the schema without throwing a predicate error', () => {
    expect(() => agentMessageV2Schema.safeParse({ ...baseMessage, blocks: [blockFor('text')], metadata: null })).not.toThrow();
    expect(agentMessageV2Schema.safeParse({ ...baseMessage, blocks: [blockFor('text')], metadata: null }).success).toBe(false);
  });
});
