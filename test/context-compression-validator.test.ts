import { describe, expect, it } from 'vitest';
import type {
  AgentContext,
  AgentMessage,
  EvidenceManifestStore,
  EvidenceManifestSummary,
  ToolCall,
  ToolExecutionResult,
} from '../src/contracts/index.js';
import { createInitialRunGovernanceState } from '../src/contracts/index.js';
import { DefaultCompressionValidator } from '../src/context-compressor/compression-validator.js';

const timestamp = '2026-09-14T00:00:00.000Z';

function baseContext(messages: AgentMessage[], overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    runId: 'run-1',
    status: 'running',
    stage: 'evidence_collection',
    profileId: 'group-buy-market',
    messages,
    pendingToolCalls: [],
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: [],
    missingEvidence: [],
    budget: {
      startedAt: timestamp,
      maxIterations: 8,
      iteration: 1,
      maxToolCalls: 16,
      toolCallsUsed: 0,
      maxDurationMs: 60_000,
    },
    contextVersion: 1,
    governance: createInitialRunGovernanceState({ profileId: 'group-buy-market', capturedAt: timestamp }),
    ...overrides,
  };
}

function callMessage(callId: string): AgentMessage {
  const call: ToolCall = { id: callId, name: 'metrics.query', input: { query: 'failure_rate' } };
  return { id: 'message-call-' + callId, role: 'assistant', createdAt: timestamp, blocks: [{ type: 'tool_call', call }] };
}

function resultMessage(callId: string): AgentMessage {
  const result: ToolExecutionResult = {
    toolCallId: callId,
    toolName: 'metrics.query',
    status: 'success',
    response: { blocks: [{ type: 'json', value: { failureRate: 0.2 } }], evidenceIds: ['evidence-1'] },
    startedAt: timestamp,
    finishedAt: timestamp,
  };
  return { id: 'message-result-' + callId, role: 'tool', createdAt: timestamp, blocks: [{ type: 'tool_result', result }] };
}

function summaryMessage(keyToolCalls: string[], evidenceIds: string[] = []): AgentMessage {
  return {
    id: 'summary-1',
    role: 'assistant',
    createdAt: timestamp,
    blocks: [{
      type: 'context_summary',
      summary: {
        confirmedFacts: [],
        hypotheses: [],
        missingEvidence: [],
        pendingActionIds: [],
        executedActionIds: [],
        unresolvedRisks: [],
        sourceMessageIds: ['message-call-call-old', 'message-result-call-old'],
        keyToolCalls,
        evidenceIds,
        summaryVersion: 1,
      },
    }],
  };
}

function visibleManifest(runId: string, evidenceId: string): EvidenceManifestSummary {
  return {
    evidenceId,
    manifestId: 'manifest-' + evidenceId,
    runId,
    stepId: 'step-1',
    toolCallId: 'call-old',
    captureKey: 'capture-' + evidenceId,
    source: 'log',
    queryDigest: 'digest-1',
    timeRange: { start: timestamp, end: timestamp },
    state: 'committed',
    recordCount: 1,
    sourceBytes: 12,
    storedBytes: 12,
    chunkCount: 1,
    rawSha256: 'sha256-1',
    compression: 'gzip_ndjson',
    coverage: 1,
    truncated: false,
    missingEvidence: [],
    redactionPolicyVersion: 'redaction-v1',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function validator(store?: EvidenceManifestStore): DefaultCompressionValidator {
  return store === undefined
    ? new DefaultCompressionValidator()
    : new DefaultCompressionValidator({ evidenceManifests: store });
}

describe('DefaultCompressionValidator', () => {
  it('accepts paired historical calls represented by a context summary', async () => {
    const before = baseContext([callMessage('call-old'), resultMessage('call-old')], { evidenceIds: ['evidence-1'] });
    const candidate = baseContext([summaryMessage(['call-old'], ['evidence-1'])], { evidenceIds: ['evidence-1'], contextVersion: 2 });
    const store: EvidenceManifestStore = {
      getVisible: () => Promise.resolve(visibleManifest('run-1', 'evidence-1')),
    } as unknown as EvidenceManifestStore;

    const result = await validator(store).validate({
      before,
      candidate,
      sourceMessageIds: before.messages.map((message) => message.id),
      maxMessages: 40,
      maxBytes: 256_000,
    });

    expect(result).toMatchObject({ valid: true, status: 'valid' });
  });

  it('rejects evidence that belongs to another run', async () => {
    const before = baseContext([callMessage('call-old'), resultMessage('call-old')], { evidenceIds: ['evidence-1'] });
    const candidate = baseContext([summaryMessage(['call-old'], ['evidence-1'])], { evidenceIds: ['evidence-1'], contextVersion: 2 });
    const store: EvidenceManifestStore = {
      getVisible: () => Promise.resolve(visibleManifest('run-2', 'evidence-1')),
    } as unknown as EvidenceManifestStore;

    const result = await validator(store).validate({
      before,
      candidate,
      sourceMessageIds: before.messages.map((message) => message.id),
      maxMessages: 40,
      maxBytes: 256_000,
    });

    expect(result).toMatchObject({ valid: false, status: 'failed', reasonCode: 'evidence_not_visible_for_run' });
  });

  it('repairs a candidate that retained a call but dropped its exact result', async () => {
    const before = baseContext([callMessage('call-old'), resultMessage('call-old')]);
    const candidate = baseContext([callMessage('call-old')], { contextVersion: 2 });

    const result = await validator().validate({
      before,
      candidate,
      sourceMessageIds: ['message-result-call-old'],
      maxMessages: 40,
      maxBytes: 256_000,
    });

    expect(result).toMatchObject({
      valid: true,
      status: 'repaired',
      repairType: 'restore_tool_result',
      affectedIds: ['call-old'],
    });
    expect(result.repairedContext?.messages).toContainEqual(before.messages[1]);
  });

  it('rejects a removed call that is not represented by summary keyToolCalls', async () => {
    const before = baseContext([callMessage('call-old'), resultMessage('call-old')]);
    const candidate = baseContext([summaryMessage([])], { contextVersion: 2 });

    const result = await validator().validate({
      before,
      candidate,
      sourceMessageIds: before.messages.map((message) => message.id),
      maxMessages: 40,
      maxBytes: 256_000,
    });

    expect(result).toMatchObject({ valid: false, reasonCode: 'missing_summary_tool_call' });
  });
});
