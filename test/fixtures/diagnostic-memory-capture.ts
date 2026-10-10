import type { Clock, IdGenerator } from '../../src/contracts/common.js';
import type { MemoryCaptureRequest, MemoryEventFactory } from '../../src/contracts/diagnostic-memory.js';
import { EventFactoryV2 } from '../../src/event/v2/event-factory.js';
import { checkpointChecksum, parseAgentContext } from '../../src/storage/durable-codec.js';
import { memoryNow, simulationMemoryScope } from './diagnostic-memory.js';

export function captureContext(status: 'completed' | 'failed' | 'cancelled' | 'running' = 'completed', runId = 'capture-run') {
  return parseAgentContext({
    runId, profileId: 'simulation', status, stage: status === 'completed' ? 'postmortem' : 'triage',
    messages: [{ id: 'final-message', role: 'assistant', createdAt: memoryNow,
      blocks: [{ type: 'text', text: '结算失败率升高，连接池等待时间增加。\n症状码：SETTLEMENT_FAILURE_HIGH' }] }],
    pendingToolCalls: [], confirmedToolCallIds: [], rejectedToolCallIds: [], executedActions: [],
    evidenceIds: ['capture-evidence'], missingEvidence: [], contextVersion: 1,
    budget: { startedAt: memoryNow, maxIterations: 8, iteration: 2, maxToolCalls: 16, toolCallsUsed: 2, maxDurationMs: 60_000 },
    memoryControl: { schemaVersion: 1, scope: simulationMemoryScope(), profilePolicyRevision: 'policy-v1',
      capture: 'manual', recall: false },
  });
}

export function captureRequest(context = captureContext(), origin: 'automatic' | 'manual' = 'manual'): MemoryCaptureRequest {
  return { candidateId: 'candidate-1', sourceRunId: context.runId, scope: simulationMemoryScope(),
    extractorVersion: 'episodic-v1', origin, requestId: `${origin}-request-1`,
    sourceRunStatus: context.status === 'running' || context.status === 'awaiting_confirmation' || context.status === 'paused'
      ? 'completed' : context.status,
    sourceContextVersion: context.contextVersion, sourceCheckpointChecksum: checkpointChecksum(context),
    requiredSources: ['metric'], requestedAt: memoryNow };
}

export function memoryEventFactory(): MemoryEventFactory {
  const clock: Clock = { now: () => new Date(memoryNow) };
  let nextId = 0;
  const ids: IdGenerator = { next: (prefix) => `${prefix}-${++nextId}` };
  const factory = new EventFactoryV2(clock, ids);
  return { create: (type, runId, payload) => factory.create(type, {
    runId, correlationId: `run:${runId}`, visibility: 'audit', durability: 'durable',
  }, payload) };
}
