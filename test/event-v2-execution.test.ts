import { describe, expect, it } from 'vitest';
import {
  executionEventPayloadSchemaMap,
  type ExecutionEventPayloadMap,
} from '../src/contracts/event-v2/execution.js';

const timestamp = '2026-09-07T10:00:00.000Z';

const payloads: ExecutionEventPayloadMap = {
  TOOL_CALL_ADMISSION_UPDATED: { gate: 'tool_existence', outcome: 'passed', attempt: 1 },
  TOOL_CALL_REPAIR_STARTED: { repairStrategy: 'json_close', correctionChainId: 'chain-1' },
  TOOL_CALL_REPAIR_COMPLETED: { strategy: 'json_close', changedPaths: ['input.window'], attempt: 1 },
  TOOL_CALL_REPAIR_FAILED: { strategy: 'json_close', error: { code: 'INVALID_INPUT', message: 'bad', retryable: false }, nextAction: 'retry_model' },
  TOOL_CALL_REJECTED: { toolName: 'metrics.query', gate: 'schema_validation', error: { code: 'TOOL_ARGUMENTS_SCHEMA_INVALID', message: 'bad', retryable: false } },
  TOOL_CALL_CREATED: { call: { id: 'call-1', name: 'metrics.query', input: { window: '5m' } } },
  TOOL_STARTED: { toolName: 'metrics.query', source: 'builtin', attempt: 1 },
  TOOL_PROGRESS: { progress: 0.5, displaySummary: '读取中' },
  TOOL_OUTPUT_DELTA: { blockId: 'block-1', textDelta: '部分结果' },
  TOOL_RETRY_SCHEDULED: { attempt: 2, reasonCode: 'MCP_TIMEOUT', delayMs: 100 },
  TOOL_RESULT: {
    result: { toolCallId: 'call-1', toolName: 'metrics.query', status: 'success', startedAt: timestamp },
    durationMs: 20,
    evidenceIds: ['evidence-1'],
  },
  TOOL_FAILED: { error: { code: 'TOOL_ERROR', message: 'failed', retryable: true }, attempt: 1, retryable: true },
  TOOL_CANCELLED: { actor: 'operator-1', reason: 'abort', partialArtifactIds: [] },
  RISK_EVALUATED: { findings: [], mergedRisk: 'SAFE', policyVersion: 'policy-1' },
  CONFIRMATION_REQUESTED: { confirmationId: 'confirmation-1', toolCallIds: ['call-1'], riskSummary: '确认', expiresAt: timestamp },
  CONFIRMATION_RESOLVED: { decision: 'approved', actor: 'operator-1', toolCallIds: ['call-1'], decidedAt: timestamp },
  CONFIRMATION_EXPIRED: { confirmationId: 'confirmation-1', toolCallIds: ['call-1'], expiredAt: timestamp },
  EXTERNAL_EXECUTION_REQUESTED: { requestId: 'request-1', toolCallId: 'call-1', interactionPayload: { prompt: '输入' }, expiresAt: timestamp },
  EXTERNAL_EXECUTION_RESOLVED: { requestId: 'request-1', resultBlock: { type: 'text', text: '完成' }, externalExecutionType: 'browser' },
  EXTERNAL_EXECUTION_UNCERTAIN: { requestId: 'request-1', reason: 'commit lost', requiredVerification: 'query status' },
  EVIDENCE_COLLECTION_STARTED: { source: 'prometheus', queryWindow: '5m', planItemId: 'plan-1' },
  EVIDENCE_COLLECTED: { evidenceIds: ['evidence-1'], coverage: 1, source: 'prometheus', summary: '失败率' },
  EVIDENCE_COLLECTION_FAILED: { source: 'prometheus', error: { code: 'MCP_TIMEOUT', message: 'timeout', retryable: true }, missingEvidence: ['rate'] },
  HYPOTHESIS_UPDATED: { candidates: [{ summary: '过载', confidence: 'medium' }], evidenceIds: ['evidence-1'], missingEvidence: [] },
  DIAGNOSIS_COMPLETED: { outcome: 'partial', reportId: 'report-1', evidenceIds: ['evidence-1'], limitations: ['缺少 trace'] },
  ACTION_PROPOSED: { actionId: 'action-1', toolCallId: 'call-1', risk: 'HIGH', expectedEffect: '降低失败率' },
  ACTION_EXECUTED: { actionId: 'action-1', result: { status: 'success' }, idempotencyKey: 'idem-1', uncertainty: false },
  ACTION_VERIFICATION_STARTED: { actionId: 'action-1', verificationPlan: '比较失败率' },
  ACTION_VERIFICATION_COMPLETED: { actionId: 'action-1', observedEffect: '失败率下降', evidenceIds: ['evidence-2'] },
  ACTION_VERIFICATION_FAILED: { actionId: 'action-1', error: { code: 'TOOL_ERROR', message: 'not observed', retryable: true }, requiredFollowup: '人工检查' },
};

describe('Event V2 execution payload contracts', () => {
  it.each(['passed', 'repaired', 'degraded', 'rejected'])('accepts the stable admission outcome %s', (outcome) => {
    expect(executionEventPayloadSchemaMap.TOOL_CALL_ADMISSION_UPDATED.safeParse({
      gate: 'json_parse', outcome, attempt: 1,
    }).success).toBe(true);
  });

  it('validates every 5.4-5.6 payload through the matching strict schema', () => {
    for (const [eventType, payload] of Object.entries(payloads)) {
      const result = executionEventPayloadSchemaMap[eventType as keyof ExecutionEventPayloadMap].safeParse(payload);
      expect(result.success, eventType).toBe(true);
    }
  });

  it('rejects unknown fields and unstable union values', () => {
    const schema = executionEventPayloadSchemaMap.TOOL_CALL_ADMISSION_UPDATED;
    expect(schema.safeParse({ ...payloads.TOOL_CALL_ADMISSION_UPDATED, extra: true }).success).toBe(false);
    expect(schema.safeParse({ ...payloads.TOOL_CALL_ADMISSION_UPDATED, gate: 'arbitrary' }).success).toBe(false);
    expect(executionEventPayloadSchemaMap.CONFIRMATION_RESOLVED.safeParse({
      ...payloads.CONFIRMATION_RESOLVED,
      decision: 'yes',
    }).success).toBe(false);
  });

  it('keeps tool and evidence identifiers required and JSON values safe', () => {
    expect(executionEventPayloadSchemaMap.TOOL_CALL_CREATED.safeParse({
      call: { id: '', name: 'metrics.query', input: {} },
    }).success).toBe(false);
    expect(executionEventPayloadSchemaMap.ACTION_EXECUTED.safeParse({
      ...payloads.ACTION_EXECUTED,
      result: { callback: () => undefined },
    }).success).toBe(false);
    expect(executionEventPayloadSchemaMap.EVIDENCE_COLLECTED.safeParse({
      ...payloads.EVIDENCE_COLLECTED,
      evidenceIds: [],
    }).success).toBe(false);
  });
});
