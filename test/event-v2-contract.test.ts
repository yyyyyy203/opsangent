import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_TYPES_V2,
  agentEventPayloadSchemas,
  parseAgentEventV2,
  parseAgentEventV2Payload,
  type AgentEventEnvelopeV2,
} from '../src/contracts/event-v2/index.js';

const timestamp = '2026-09-07T10:00:00.000Z';

describe('Event V2 complete catalog', () => {
  it('has one runtime payload schema for every catalog event', () => {
    expect(Object.keys(agentEventPayloadSchemas).sort()).toEqual([...AGENT_EVENT_TYPES_V2].sort());
    expect(new Set(AGENT_EVENT_TYPES_V2).size).toBe(AGENT_EVENT_TYPES_V2.length);
    expect(AGENT_EVENT_TYPES_V2).toContain('RUN_RESUMED');
    expect(AGENT_EVENT_TYPES_V2).toContain('TOOL_CALL_ADMISSION_UPDATED');
    expect(AGENT_EVENT_TYPES_V2).toContain('EXPERIENCE_REVIEWED');
  });

  it('preserves payload type pairing at compile time and runtime', () => {
    const event: AgentEventEnvelopeV2<'MODEL_CALL_COMPLETED'> = {
      schemaVersion: 2,
      eventId: 'event-1',
      sequence: 1,
      type: 'MODEL_CALL_COMPLETED',
      payload: { provider: 'openai-compatible', model: 'test', attempt: 1, durationMs: 10 },
      runId: 'run-1',
      correlationId: 'correlation-1',
      timestamp,
      visibility: 'audit',
      durability: 'durable',
    };

    expect(parseAgentEventV2(event)).toEqual(event);
    expect(() => parseAgentEventV2({ ...event, payload: { decision: 'approved' } })).toThrow();
  });

  it('rejects an unknown event and an invalid payload through generic parsing', () => {
    expect(() => parseAgentEventV2Payload('RUN_RESUMED', { checkpointVersion: '' })).toThrow();
    expect(() => parseAgentEventV2({
      schemaVersion: 2,
      eventId: 'event-2',
      sequence: 2,
      type: 'NOT_REGISTERED',
      payload: {},
      runId: 'run-1',
      correlationId: 'correlation-1',
      timestamp,
      visibility: 'internal',
      durability: 'transient',
    })).toThrow();
  });

  it('registers and validates LOOP_DETECTED as a V2-only event fact', () => {
    const event = {
      schemaVersion: 2,
      eventId: 'event-loop-1',
      sequence: 3,
      type: 'LOOP_DETECTED' as const,
      payload: {
        level: 'hard' as const,
        repeatCount: 5,
        toolName: 'metrics.query',
        signatureDigest: 'loop-signature-v1',
        action: 'signature_blocked' as const,
        stage: 'evidence_collection' as const,
      },
      runId: 'run-1',
      correlationId: 'correlation-1',
      timestamp,
      visibility: 'audit' as const,
      durability: 'durable' as const,
    };

    expect(AGENT_EVENT_TYPES_V2).toContain('LOOP_DETECTED');
    expect(parseAgentEventV2(event)).toMatchObject({
      type: 'LOOP_DETECTED',
      payload: { level: 'hard', repeatCount: 5, action: 'signature_blocked' },
    });
    expect(() => parseAgentEventV2({ ...event, payload: { ...event.payload, repeatCount: 0 } })).toThrow();
  });
});
