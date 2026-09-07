import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelopeV2, AgentEventPayloadMap, AgentEventTypeV2 } from '../src/contracts/index.js';
import { PublicEventProjectorV2 } from '../src/event/projectors/public-projector.js';
import { V1CompatibilityProjector } from '../src/event/projectors/v1-projector.js';

function event<T extends AgentEventTypeV2>(
  type: T,
  payload: AgentEventPayloadMap[T],
  visibility: 'public' | 'audit' | 'internal' = 'public',
): AgentEventEnvelopeV2<T> {
  return {
    schemaVersion: 2, eventId: `event-${type}`, sequence: 1, type, payload, runId: 'run-1', stepId: 'step-1',
    correlationId: 'corr-1', timestamp: '2026-09-07T10:00:00.000Z', visibility, durability: 'durable',
  } as AgentEventEnvelopeV2<T>;
}

describe('V1CompatibilityProjector', () => {
  it.each([
    ['RUN_STARTED', { profile: 'settlement', trigger: 'manual', deadline: '2026-09-07T11:00:00.000Z', versionSnapshot: {} }, 'RUN_STARTED'],
    ['STEP_STARTED', { iteration: 1, stage: 'triage', budgetSnapshot: {} }, 'STEP_STARTED'],
    ['REASONING_STARTED', { stage: 'triage', objective: 'inspect' }, 'REASONING_STARTED'],
    ['EVIDENCE_COLLECTED', { evidenceIds: ['ev-1'], coverage: 1, source: 'prometheus', summary: 'ok' }, 'EVIDENCE_COLLECTED'],
    ['CONTEXT_COMPRESSED', { level: 'L1', before: 10, after: 5, offloadedEvidenceIds: [], savedTokens: 5 }, 'CONTEXT_COMPRESSED'],
    ['RUN_FINISHED', { outcome: 'complete', durationMs: 5 }, 'RUN_FINISHED'],
  ] as const)('maps %s to the legacy %s event', (type, payload, expected) => {
    const projected = new V1CompatibilityProjector().project(event(
      type as AgentEventTypeV2,
      payload as AgentEventPayloadMap[AgentEventTypeV2],
    ));
    expect(projected.map((item) => item.type)).toEqual([expected]);
    expect(projected[0]).toMatchObject({ schemaVersion: 1, runId: 'run-1', stepId: 'step-1' });
  });

  it('maps text deltas and ignores unsupported V2-only events', () => {
    const projector = new V1CompatibilityProjector();
    expect(projector.project(event('CONTENT_BLOCK_DELTA', {
      messageId: 'message-1', blockId: 'block-1', delta: 'hello', index: 0,
    }))[0]).toMatchObject({ type: 'TEXT_DELTA', payload: { delta: 'hello' } });
    expect(projector.project(event('MEMORY_RETRIEVAL_STARTED', { scopes: ['working'], filters: {}, limit: 2 }, 'audit'))).toEqual([]);
  });
});

describe('PublicEventProjectorV2', () => {
  it('drops non-public events and raw tool-call blocks', () => {
    const projector = new PublicEventProjectorV2();
    expect(projector.project(event('MODEL_CALL_STARTED', {
      provider: 'openai', model: 'x', purpose: 'diagnosis', attempt: 1, inputSummary: 'private',
    }, 'audit'))).toBeNull();
    expect(projector.project(event('CONTENT_BLOCK_COMPLETED', {
      messageId: 'message-1', blockId: 'raw-1', index: 0, blockSummary: 'raw arguments',
      block: { blockId: 'raw-1', type: 'raw_tool_call', call: { id: 'call-1', name: 'bash', arguments: '{"token":"secret"}' } },
    }))).toBeNull();
  });

  it('uses safe public views for tool inputs and recursively removes secrets and internal addresses', () => {
    const projector = new PublicEventProjectorV2();
    const projected = projector.project(event('TOOL_CALL_CREATED', {
      call: {
        id: 'call-1', name: 'metrics.query',
        input: { query: 'sum(rate(errors[5m]))', token: 'secret', nested: { authorization: 'Bearer x', safe: 'ok' }, endpoint: 'http://10.0.0.8:9090' },
      },
      displayLabel: '查询指标',
    }));
    expect(projected).toMatchObject({ eventId: 'event-TOOL_CALL_CREATED', sequence: 1, type: 'TOOL_CALL_CREATED' });
    expect(projected?.payload).toEqual({ call: { id: 'call-1', name: 'metrics.query', input: {} }, displayLabel: '查询指标' });
    expect(JSON.stringify(projected)).not.toMatch(/secret|Bearer|10\.0\.0\.8|authorization/i);
  });

  it('refuses unsafe content deltas instead of masking them into malformed content', () => {
    const projector = new PublicEventProjectorV2();
    expect(projector.project(event('CONTENT_BLOCK_DELTA', {
      messageId: 'message-1', blockId: 'block-1', delta: 'open http://127.0.0.1/admin', index: 0,
    }))).toBeNull();
  });
});
