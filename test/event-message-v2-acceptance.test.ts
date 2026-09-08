import eventFixture from './fixtures/event-v1.json' with { type: 'json' };
import messageFixture from './fixtures/message-v1.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { PublicEventProjectorV2 } from '../src/event/projectors/public-projector.js';
import { V1CompatibilityProjector } from '../src/event/projectors/v1-projector.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { z } from 'zod';

describe('Event/Message V2一期 acceptance', () => {
  it('reads V1 fixtures and projects an equivalent V2 text event back to V1', () => {
    expect(eventFixture.schemaVersion).toBe(1);
    expect(messageFixture.blocks[0]?.type).toBe('text');
    const event = {
      schemaVersion: 2 as const, eventId: 'event-fixture-1', sequence: 1, type: 'CONTENT_BLOCK_DELTA' as const,
      payload: { messageId: 'message-fixture-1', blockId: 'block-1', delta: 'fixture', index: 0, blockType: 'text' as const },
      runId: 'run-fixture-1', correlationId: 'corr-fixture-1', timestamp: '2026-09-08T00:00:00.000Z',
      visibility: 'public' as const, durability: 'transient' as const,
    };
    expect(new V1CompatibilityProjector().project(event)[0]).toMatchObject({ type: 'TEXT_DELTA', payload: { delta: 'fixture' } });
  });

  it('keeps tool-call/result pairing and parallel safe-tool result order', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [
        { id: 'call-1', name: 'query-a', input: {} }, { id: 'call-2', name: 'query-b', input: {} },
      ] }, { text: 'done', toolCalls: [] }]),
      workspaceRoots: [], includeExternalBash: false,
      tools: [
        { name: 'query-a', description: 'a', kind: 'evidence', inputSchema: z.object({}), call: async () => { await Promise.resolve(); return { blocks: [{ type: 'text', text: 'a' }] }; }, isConcurrencySafe: () => true },
        { name: 'query-b', description: 'b', kind: 'evidence', inputSchema: z.object({}), call: async () => { await Promise.resolve(); return { blocks: [{ type: 'text', text: 'b' }] }; }, isConcurrencySafe: () => true },
      ],
    });
    const result = await runtime.agent.reply({ message: 'inspect', profileId: 'group-buy-market' });
    const events = await runtime.eventStoreV2.readRun(result.runId, 0, 200);
    const results = events.filter((event): event is Extract<typeof event, { type: 'TOOL_RESULT' }> => event.type === 'TOOL_RESULT');
    expect(results.map((event) => event.payload.result.toolCallId)).toEqual(['call-1', 'call-2']);
    expect(events.filter((event) => event.type === 'TOOL_CALL_CREATED')).toHaveLength(2);
    expect(new Set(results.map((event) => event.payload.result.toolCallId))).toEqual(new Set(['call-1', 'call-2']));
  });

  it('drops audit content from the public projection', () => {
    const projector = new PublicEventProjectorV2();
    const event = {
      schemaVersion: 2 as const, eventId: 'event-private', sequence: 1, type: 'MODEL_CALL_STARTED' as const,
      payload: { provider: 'configured', model: 'configured', purpose: 'inspection', attempt: 1, inputSummary: 'secret' },
      runId: 'run-fixture-1', correlationId: 'corr-fixture-1', timestamp: '2026-09-08T00:00:00.000Z',
      visibility: 'audit' as const, durability: 'durable' as const,
    };
    expect(projector.project(event)).toBeNull();
  });
});
