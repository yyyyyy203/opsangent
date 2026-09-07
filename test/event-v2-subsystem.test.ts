import { describe, expect, it } from 'vitest';
import {
  subsystemEventPayloadSchemaMap,
  type SubsystemEventPayloadMap,
} from '../src/contracts/event-v2/subsystem.js';

const eventTypes: Array<keyof SubsystemEventPayloadMap> = [
  'SUBAGENT_STARTED', 'SUBAGENT_PROGRESS', 'SUBAGENT_RETRY_SCHEDULED', 'SUBAGENT_FALLBACK_ACTIVATED',
  'SUBAGENT_COMPLETED', 'SUBAGENT_FAILED',
  'MCP_CONNECTION_STARTED', 'MCP_CONNECTION_COMPLETED', 'MCP_CONNECTION_FAILED', 'MCP_CONNECTION_DEGRADED',
  'DATASOURCE_RETRY_SCHEDULED', 'DATASOURCE_CIRCUIT_OPENED', 'DATASOURCE_CIRCUIT_HALF_OPENED',
  'DATASOURCE_CIRCUIT_CLOSED', 'DATASOURCE_FALLBACK_ACTIVATED',
  'CONTEXT_COMPRESSION_STARTED', 'CONTEXT_COMPRESSED', 'CONTEXT_COMPRESSION_FAILED', 'CONTEXT_INTEGRITY_REPAIRED',
  'MEMORY_RETRIEVAL_STARTED', 'MEMORY_RETRIEVAL_COMPLETED', 'MEMORY_RETRIEVAL_FAILED',
  'MEMORY_UPDATE_SCHEDULED', 'MEMORY_UPDATE_COMPLETED', 'MEMORY_UPDATE_FAILED',
  'EXPERIENCE_CANDIDATE_CREATED', 'EXPERIENCE_REVIEWED',
];

const payloadFor = (type: keyof SubsystemEventPayloadMap): Record<string, unknown> => {
  switch (type) {
    case 'SUBAGENT_STARTED': return {
      subagentType: 'prometheus', childRunId: 'child-1', parentRunId: 'run-1',
      budget: { type: 'tokens', limit: 1000, used: 0 },
    };
    case 'SUBAGENT_PROGRESS': return { childRunId: 'child-1', stage: 'evidence_collection', displaySummary: 'collecting' };
    case 'SUBAGENT_RETRY_SCHEDULED': return { childRunId: 'child-1', attempt: 2, reasonCode: 'timeout' };
    case 'SUBAGENT_FALLBACK_ACTIVATED': return { childRunId: 'child-1', fallbackMode: 'reduced_scope', reasonCode: 'unavailable' };
    case 'SUBAGENT_COMPLETED': return { childRunId: 'child-1', status: 'completed', evidenceIds: ['evidence-1'], coverage: 0.8 };
    case 'SUBAGENT_FAILED': return { childRunId: 'child-1', error: { code: 'MODEL_ERROR', message: 'failed', retryable: false }, partialEvidenceIds: [] };
    case 'MCP_CONNECTION_STARTED': return { serverId: 'server-1', transport: 'stdio', attempt: 1 };
    case 'MCP_CONNECTION_COMPLETED': return { serverId: 'server-1', capabilitySnapshotVersion: 'v1', durationMs: 10 };
    case 'MCP_CONNECTION_FAILED': return { serverId: 'server-1', error: { code: 'MCP_NETWORK_ERROR', message: 'failed', retryable: true }, retryable: true };
    case 'MCP_CONNECTION_DEGRADED': return { serverId: 'server-1', unavailableCapabilities: ['write'], fallback: 'readonly' };
    case 'DATASOURCE_RETRY_SCHEDULED': return { sourceId: 'prometheus', attempt: 2, reasonCode: 'timeout', delayMs: 100 };
    case 'DATASOURCE_CIRCUIT_OPENED': return { sourceId: 'prometheus', failureWindow: { failures: 3, windowMs: 60000 }, openUntil: '2026-09-07T10:01:00.000Z' };
    case 'DATASOURCE_CIRCUIT_HALF_OPENED': return { sourceId: 'prometheus', probePolicy: 'single_probe' };
    case 'DATASOURCE_CIRCUIT_CLOSED': return { sourceId: 'prometheus', recoveryEvidence: ['evidence-1'] };
    case 'DATASOURCE_FALLBACK_ACTIVATED': return { sourceId: 'prometheus', fallbackSource: 'snapshot', fallbackMode: 'cached', limitations: ['stale'] };
    case 'CONTEXT_COMPRESSION_STARTED': return { level: 'L1', reason: 'token_budget', beforeSize: 12000 };
    case 'CONTEXT_COMPRESSED': return { level: 'L1', before: 12000, after: 6000, offloadedEvidenceIds: ['evidence-1'], savedTokens: 3000 };
    case 'CONTEXT_COMPRESSION_FAILED': return { level: 'L2', error: { code: 'MODEL_ERROR', message: 'failed', retryable: false }, fallbackPolicy: 'retain_previous' };
    case 'CONTEXT_INTEGRITY_REPAIRED': return { repairType: 'restore_tool_result', affectedIds: ['tool-1'], validationResult: 'valid' };
    case 'MEMORY_RETRIEVAL_STARTED': return { scopes: ['episodic', 'semantic'], filters: { service: 'settlement' }, limit: 5 };
    case 'MEMORY_RETRIEVAL_COMPLETED': return { hitCount: 1, memoryIds: ['memory-1'], durationMs: 10 };
    case 'MEMORY_RETRIEVAL_FAILED': return { error: { code: 'STORAGE_ERROR', message: 'failed', retryable: true }, fallbackPolicy: 'empty' };
    case 'MEMORY_UPDATE_SCHEDULED': return { candidateType: 'experience', sourceRunId: 'run-1' };
    case 'MEMORY_UPDATE_COMPLETED': return { memoryId: 'memory-1', status: 'observation', eligibility: 'not_eligible' };
    case 'MEMORY_UPDATE_FAILED': return { error: { code: 'STORAGE_ERROR', message: 'failed', retryable: true }, candidateId: 'candidate-1' };
    case 'EXPERIENCE_CANDIDATE_CREATED': return { candidateId: 'candidate-1', evidenceIds: ['evidence-1'], qualityStatus: 'insufficient' };
    case 'EXPERIENCE_REVIEWED': return { candidateId: 'candidate-1', decision: 'approved', reviewer: 'operator-1' };
  }
};

describe('Event V2 subsystem payload contracts', () => {
  it('has a matching runtime schema for every approved subsystem event', () => {
    expect(Object.keys(subsystemEventPayloadSchemaMap).sort()).toEqual([...eventTypes].sort());
    for (const type of eventTypes) {
      expect(subsystemEventPayloadSchemaMap[type].safeParse(payloadFor(type)).success).toBe(true);
    }
  });

  it('uses strict schemas and stable discriminated unions', () => {
    const started = subsystemEventPayloadSchemaMap.SUBAGENT_STARTED;
    expect(started.safeParse({ ...payloadFor('SUBAGENT_STARTED'), extra: true }).success).toBe(false);
    expect(subsystemEventPayloadSchemaMap.SUBAGENT_STARTED.safeParse({
      ...payloadFor('SUBAGENT_STARTED'), budget: { type: 'unbounded', limit: 1000, used: 0 },
    }).success).toBe(false);
    expect(subsystemEventPayloadSchemaMap.EXPERIENCE_REVIEWED.safeParse({
      ...payloadFor('EXPERIENCE_REVIEWED'), decision: 'maybe',
    }).success).toBe(false);
  });

  it('rejects non-JSON-safe payload values', () => {
    expect(subsystemEventPayloadSchemaMap.MEMORY_RETRIEVAL_STARTED.safeParse({
      ...payloadFor('MEMORY_RETRIEVAL_STARTED'), filters: { callback: () => undefined },
    }).success).toBe(false);
    expect(subsystemEventPayloadSchemaMap.CONTEXT_COMPRESSED.safeParse({
      ...payloadFor('CONTEXT_COMPRESSED'), savedTokens: Number.POSITIVE_INFINITY,
    }).success).toBe(false);
  });
});
