import { describe, expect, it } from 'vitest';
import {
  RunViewController,
  mergeMessagePage,
  type RunViewClient,
} from '../apps/agent-web/src/state/run-view.js';
import type {
  PublicMessageItem,
  PublicMessagePage,
  PublicEventFrame,
  PublicRunDetail,
} from '../apps/agent-web/src/api/types.js';

function message(id: string, runId = 'run-1', version = 1, text = id): PublicMessageItem {
  return {
    version,
    truncated: false,
    message: {
      schemaVersion: 2,
      id,
      runId,
      role: 'assistant',
      status: 'completed',
      visibility: 'user',
      blocks: [{ type: 'text', blockId: `${id}-block`, text }],
      createdAt: `2026-10-01T00:00:0${id === 'm-new' ? '2' : '1'}.000Z`,
    },
  };
}

function page(...items: PublicMessageItem[]): PublicMessagePage {
  return { items };
}

describe('browser run view state', () => {
  it('merges a message page idempotently and never lets an older version roll back newer content', () => {
    const current = [message('m-1', 'run-1', 2, 'new')];
    const merged = mergeMessagePage(current, page(message('m-1', 'run-1', 1, 'old'), message('m-2')), 'run-1');

    expect(merged.map((item) => item.message.id)).toEqual(['m-2', 'm-1']);
    expect(merged.find((item) => item.message.id === 'm-1')?.message.blocks[0]).toMatchObject({ text: 'new' });
    expect(mergeMessagePage(merged, page(...merged), 'run-1')).toHaveLength(2);
    expect(mergeMessagePage(merged, page(message('foreign', 'run-2')), 'run-1')).toEqual(merged);
  });

  it('keeps old messages when a refresh fails and clears all timers and SSE on close', async () => {
    const handles = new Set<unknown>();
    const events = { closeCalls: 0, close: () => { events.closeCalls += 1; } };
    const detail: PublicRunDetail = {
      runId: 'run-1', profileId: 'profile', status: 'running', stage: 'triage', contextVersion: 1,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', evidenceIds: [],
      missingEvidence: [], childRunIds: [],
    };
    const client: RunViewClient = {
      listProfiles: () => Promise.resolve([]),
      listRuns: () => Promise.resolve({ items: [] }),
      getRun: () => Promise.resolve(detail),
      getMessages: () => Promise.reject(new Error('temporary message failure')),
      listEvidence: () => Promise.resolve({ items: [] }),
      getConfirmation: () => Promise.resolve(null),
      startRun: () => Promise.resolve({ runId: 'run-1', status: 'started', eventsUrl: '/runs/run-1/events' }),
      resumeRun: () => Promise.resolve({ runId: 'run-1', status: 'resuming', eventsUrl: '/runs/run-1/events' }),
      decideConfirmation: () => Promise.resolve({ outcome: 'rejected', revision: 1 }),
      openRunEvents: () => events,
    };
    const controller = new RunViewController(client, {
      setTimeout: (callback, delay) => {
        const handle = setTimeout(callback, delay);
        handles.add(handle);
        return handle;
      },
      clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); handles.delete(handle); },
      setInterval: (callback, delay) => setInterval(callback, delay),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });

    await controller.openRun('run-1', [message('existing')]);
    expect(controller.getState().messages).toEqual([message('existing')]);
    expect(controller.getState().notice).toContain('temporary message failure');
    controller.close();
    expect(events.closeCalls).toBe(1);
    expect(handles.size).toBe(0);
  });

  it('keeps an explicit resume affordance after approval because approval does not auto-resume', async () => {
    const detail: PublicRunDetail = {
      runId: 'run-approval', profileId: 'profile', status: 'awaiting_confirmation', stage: 'risk_gate', contextVersion: 1,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', evidenceIds: [],
      missingEvidence: [], childRunIds: [],
    };
    const client: RunViewClient = {
      listProfiles: () => Promise.resolve([]), listRuns: () => Promise.resolve({ items: [] }),
      getRun: () => Promise.resolve(detail), getMessages: () => Promise.resolve({ items: [] }),
      listEvidence: () => Promise.resolve({ items: [] }), getConfirmation: () => Promise.resolve({ runId: 'run-approval', toolCallId: 'call-1', expectedRevision: 2, summary: '确认只读查询' }),
      startRun: () => Promise.resolve({ runId: 'run-approval', status: 'started', eventsUrl: '/runs/run-approval/events' }),
      resumeRun: () => Promise.resolve({ runId: 'run-approval', status: 'resuming', eventsUrl: '/runs/run-approval/events' }),
      decideConfirmation: () => Promise.resolve({ outcome: 'approved', revision: 3 }),
      openRunEvents: () => ({ close: () => undefined }),
    };
    const controller = new RunViewController(client);
    await controller.openRun('run-approval');
    await controller.decideConfirmation({ toolCallId: 'call-1', confirmed: true, expectedRevision: 2 });
    expect(controller.getState().resumeRequired).toBe(true);
    await controller.resumeRun();
    expect(controller.getState().resumeRequired).toBe(false);
  });

  it('keeps an explicit resume affordance after rejection because rejection also needs a separate resume', async () => {
    const detail: PublicRunDetail = {
      runId: 'run-rejection', profileId: 'profile', status: 'awaiting_confirmation', stage: 'risk_gate', contextVersion: 1,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', evidenceIds: [],
      missingEvidence: [], childRunIds: [],
    };
    const client: RunViewClient = {
      listProfiles: () => Promise.resolve([]), listRuns: () => Promise.resolve({ items: [] }),
      getRun: () => Promise.resolve({ ...detail, status: 'running' }), getMessages: () => Promise.resolve({ items: [] }),
      listEvidence: () => Promise.resolve({ items: [] }), getConfirmation: () => Promise.resolve(null),
      startRun: () => Promise.resolve({ runId: 'run-rejection', status: 'started', eventsUrl: '/runs/run-rejection/events' }),
      resumeRun: () => Promise.resolve({ runId: 'run-rejection', status: 'resuming', eventsUrl: '/runs/run-rejection/events' }),
      decideConfirmation: () => Promise.resolve({ outcome: 'rejected', revision: 2 }),
      openRunEvents: () => ({ close: () => undefined }),
    };
    const controller = new RunViewController(client);
    await controller.openRun('run-rejection');
    await controller.decideConfirmation({ toolCallId: 'call-1', confirmed: false, expectedRevision: 1 });
    expect(controller.getState().resumeRequired).toBe(true);
    await controller.resumeRun();
    expect(controller.getState().resumeRequired).toBe(false);
  });

  it('tracks safe tool lifecycle frames without storing raw tool output', async () => {
    const detail: PublicRunDetail = {
      runId: 'run-tool', profileId: 'profile', status: 'running', stage: 'evidence_collection', contextVersion: 1,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', evidenceIds: [],
      missingEvidence: [], childRunIds: [],
    };
    let emit: ((frame: PublicEventFrame) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const client: RunViewClient = {
      listProfiles: () => Promise.resolve([]), listRuns: () => Promise.resolve({ items: [] }),
      getRun: () => Promise.resolve(detail), getMessages: () => Promise.resolve({ items: [] }),
      listEvidence: () => Promise.resolve({ items: [] }), getConfirmation: () => Promise.resolve(null),
      startRun: () => Promise.resolve({ runId: 'run-tool', status: 'started', eventsUrl: '/runs/run-tool/events' }),
      resumeRun: () => Promise.resolve({ runId: 'run-tool', status: 'resuming', eventsUrl: '/runs/run-tool/events' }),
      decideConfirmation: () => Promise.resolve({ outcome: 'rejected', revision: 1 }),
      openRunEvents: (_runId, _lastEventId, onEvent, onError) => { emit = onEvent; fail = onError; return { close: () => undefined }; },
    };
    const controller = new RunViewController(client);
    await controller.openRun('run-tool');
    fail?.(new Error('temporary disconnect'));
    expect(controller.getState().connected).toBe(false);
    emit?.({ event: 'RUN_STARTED', data: {} });
    expect(controller.getState().connected).toBe(true);
    emit?.({ event: 'TOOL_STARTED', data: { type: 'TOOL_STARTED', payload: { toolName: 'fixture.metrics', source: 'mcp', attempt: 1 } } });
    expect(controller.getState().toolActivity).toMatchObject({ toolName: 'fixture.metrics', status: 'running' });
    emit?.({ event: 'TOOL_RESULT', data: { type: 'TOOL_RESULT', payload: { result: { toolName: 'fixture.metrics', status: 'success', response: { secret: 'private' } } } } });
    expect(controller.getState().toolActivity).toMatchObject({ toolName: 'fixture.metrics', status: 'success' });
    expect(JSON.stringify(controller.getState().toolActivity)).not.toContain('private');
    controller.close();
  });
});
