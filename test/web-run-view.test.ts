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
  PublicEvidenceView,
  PublicEvidencePage,
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
  it('keeps successful initial messages when a newer refresh cannot load them', async () => {
    const detail = runDetail('initial-message-race', 10);
    const client = viewClient(detail);
    const heldPage = deferred<PublicEvidencePage>();
    const initialStarted = deferred<void>();
    let pageRead = 0;
    client.listEvidence = () => {
      if (pageRead++ === 0) { initialStarted.resolve(undefined); return heldPage.promise; }
      return Promise.resolve({ items: [] });
    };
    let messageRead = 0;
    client.getMessages = () => messageRead++ === 0
      ? Promise.resolve(page(message('initial-valid', detail.runId)))
      : Promise.reject(new Error('newer message query unavailable'));
    const controller = new RunViewController(client);
    try {
      const initial = controller.openRun(detail.runId);
      await initialStarted.promise;
      await controller.resumeRun();
      heldPage.resolve({ items: [] });
      await initial;

      expect(controller.getState().messages.map((item) => item.message.id)).toEqual(['initial-valid']);
    } finally { controller.close(); }
  });

  it('keeps the newer Run snapshot when an earlier tree refresh finishes late', async () => {
    const initial = runDetail('race-run', 0);
    const older = runDetail('race-run', 10);
    const newer = runDetail('race-run', 20);
    const oldEvidence = evidence('race-old', initial.runId);
    const newEvidence = evidence('race-new', initial.runId);
    const client = viewClient(initial);
    const controller = new RunViewController(client);
    const heldPage = deferred<PublicEvidencePage>();
    const olderStarted = deferred<void>();
    try {
      await controller.openRun(initial.runId);
      let detailRead = 0;
      client.getRun = () => Promise.resolve(detailRead++ === 0 ? older : newer);
      let pageRead = 0;
      client.listEvidence = () => {
        if (pageRead++ === 0) { olderStarted.resolve(undefined); return heldPage.promise; }
        return Promise.resolve({ items: [newEvidence] });
      };

      const earlier = controller.resumeRun();
      await olderStarted.promise;
      await controller.resumeRun();
      heldPage.resolve({ items: [oldEvidence] });
      await earlier;

      expect(controller.getState().detail?.usage?.inputTokens).toBe(20);
      expect(controller.getState().subtreeUsage?.inputTokens).toBe(20);
      expect(controller.getState().evidence.map((item) => item.evidenceId)).toEqual(['race-new']);
    } finally { controller.close(); }
  });

  it('retains previous evidence and completed pages when a later evidence page fails', async () => {
    const detail = runDetail('page-failure-run', 10);
    const previous = evidence('previous-evidence', detail.runId);
    const pageOne = evidence('new-page-one-evidence', detail.runId);
    const client = viewClient(detail);
    client.listEvidence = () => Promise.resolve({ items: [previous] });
    const controller = new RunViewController(client);
    try {
      await controller.openRun(detail.runId);
      client.listEvidence = (_runId, options) => options?.cursor === undefined
        ? Promise.resolve({ items: [pageOne], nextCursor: 'failing-page' })
        : Promise.reject(new Error('second page temporarily unavailable'));

      await controller.resumeRun();

      expect(controller.getState().evidenceIncomplete).toBe(true);
      expect(controller.getState().evidence.map((item) => item.evidenceId)).toEqual(expect.arrayContaining([
        'previous-evidence', 'new-page-one-evidence',
      ]));
      expect(controller.getState().evidence).toHaveLength(2);
    } finally { controller.close(); }
  });

  it('does not publish an unsafe token sum as a complete tree total', async () => {
    const parent = runDetail('overflow-parent', Number.MAX_SAFE_INTEGER, ['overflow-child']);
    const child = runDetail('overflow-child', 2);
    const client = viewClient(parent);
    client.getRun = (runId) => Promise.resolve(runId === parent.runId ? parent : child);
    const controller = new RunViewController(client);
    try {
      await controller.openRun(parent.runId);

      expect(controller.getState().subtreeUsage?.completeness).toBe('partial');
      expect(controller.getState().subtreeUsage?.inputTokens).toBeUndefined();
      expect(controller.getState().subtreeUsage?.outputTokens).toBe(40);
    } finally { controller.close(); }
  });

  it('includes child-run evidence in the parent view while preserving evidence ownership', async () => {
    const parent: PublicRunDetail = {
      runId: 'parent-run', profileId: 'profile', status: 'completed', stage: 'postmortem', contextVersion: 1,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', evidenceIds: [],
      missingEvidence: [], childRunIds: ['metrics-child'],
      usage: { completeness: 'complete', inputTokens: 100, outputTokens: 20, cachedInputTokens: 8 },
    };
    const child: PublicRunDetail = {
      runId: 'metrics-child', profileId: 'profile', status: 'completed', stage: 'evidence_collection', contextVersion: 1,
      createdAt: '2026-10-01T00:00:01.000Z', updatedAt: '2026-10-01T00:00:02.000Z', evidenceIds: ['evidence-child'],
      missingEvidence: [], childRunIds: ['logs-grandchild'],
      usage: { completeness: 'complete', inputTokens: 30, outputTokens: 10, cachedInputTokens: 2 },
    };
    const grandchild: PublicRunDetail = {
      runId: 'logs-grandchild', profileId: 'profile', status: 'completed', stage: 'evidence_collection', contextVersion: 1,
      createdAt: '2026-10-01T00:00:02.000Z', updatedAt: '2026-10-01T00:00:03.000Z', evidenceIds: ['evidence-grandchild'],
      missingEvidence: [], childRunIds: [],
      usage: { completeness: 'complete', inputTokens: 10, outputTokens: 4, cachedInputTokens: 1 },
    };
    const childEvidence: PublicEvidenceView = {
      evidenceId: 'evidence-child', runId: 'metrics-child', source: 'prometheus', state: 'available',
      capturedAt: '2026-10-01T00:00:02.000Z', summary: { status: 'breached' }, traceIdCount: 0, retrievable: false,
    };
    const secondChildEvidence: PublicEvidenceView = {
      ...childEvidence, evidenceId: 'evidence-child-2', capturedAt: '2026-10-01T00:00:03.000Z', summary: { window: 'previous' },
    };
    const grandchildEvidence: PublicEvidenceView = {
      ...childEvidence, evidenceId: 'evidence-grandchild', runId: grandchild.runId, source: 'elk',
      capturedAt: '2026-10-01T00:00:04.000Z', summary: { exceptions: 2 },
    };
    const evidenceQueries: string[] = [];
    const cursors: Array<string | undefined> = [];
    const client: RunViewClient = {
      listProfiles: () => Promise.resolve([]), listRuns: () => Promise.resolve({ items: [] }),
      getRun: (runId) => Promise.resolve(runId === parent.runId ? parent : runId === child.runId ? child : grandchild),
      getMessages: () => Promise.resolve({ items: [] }),
      listEvidence: (runId, options) => {
        evidenceQueries.push(runId);
        cursors.push(options?.cursor);
        if (runId === child.runId) {
          return Promise.resolve(options?.cursor === undefined
            ? { items: [childEvidence], nextCursor: 'evidence-page-2' }
            : { items: [secondChildEvidence] });
        }
        return Promise.resolve({ items: runId === grandchild.runId ? [grandchildEvidence] : [] });
      },
      getConfirmation: () => Promise.resolve(null),
      startRun: () => Promise.resolve({ runId: parent.runId, status: 'started', eventsUrl: `/runs/${parent.runId}/events` }),
      resumeRun: () => Promise.resolve({ runId: parent.runId, status: 'resuming', eventsUrl: `/runs/${parent.runId}/events` }),
      decideConfirmation: () => Promise.resolve({ outcome: 'rejected', revision: 1 }),
      openRunEvents: () => ({ close: () => undefined }),
    };
    const controller = new RunViewController(client);

    await controller.openRun(parent.runId);

    expect(evidenceQueries).toEqual(expect.arrayContaining([parent.runId, child.runId, grandchild.runId]));
    expect(cursors).toContain('evidence-page-2');
    expect(controller.getState().evidence).toEqual([childEvidence, secondChildEvidence, grandchildEvidence]);
    expect(controller.getState().evidence[0]?.runId).toBe(child.runId);
    expect(controller.getState().evidence[0]?.retrievable).toBe(false);
    expect(controller.getState().descendantUsage).toEqual({ completeness: 'complete', inputTokens: 40, outputTokens: 14, cachedInputTokens: 3 });
    expect(controller.getState().subtreeUsage).toEqual({ completeness: 'complete', inputTokens: 140, outputTokens: 34, cachedInputTokens: 11 });
  });

  it('marks evidence and subtree usage incomplete when a child Run cannot be read', async () => {
    const parent: PublicRunDetail = {
      runId: 'parent-partial', profileId: 'profile', status: 'completed', stage: 'postmortem', contextVersion: 1,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', evidenceIds: [],
      missingEvidence: [], childRunIds: ['missing-child'],
      usage: { completeness: 'complete', inputTokens: 100, outputTokens: 20 },
    };
    const client: RunViewClient = {
      listProfiles: () => Promise.resolve([]), listRuns: () => Promise.resolve({ items: [] }),
      getRun: (runId) => runId === parent.runId ? Promise.resolve(parent) : Promise.reject(new Error('child unavailable')),
      getMessages: () => Promise.resolve({ items: [] }), listEvidence: () => Promise.resolve({ items: [] }),
      getConfirmation: () => Promise.resolve(null),
      startRun: () => Promise.resolve({ runId: parent.runId, status: 'started', eventsUrl: `/runs/${parent.runId}/events` }),
      resumeRun: () => Promise.resolve({ runId: parent.runId, status: 'resuming', eventsUrl: `/runs/${parent.runId}/events` }),
      decideConfirmation: () => Promise.resolve({ outcome: 'rejected', revision: 1 }),
      openRunEvents: () => ({ close: () => undefined }),
    };
    const controller = new RunViewController(client);

    await controller.openRun(parent.runId);

    expect(controller.getState().evidenceIncomplete).toBe(true);
    expect(controller.getState().descendantUsage).toEqual({ completeness: 'partial' });
    expect(controller.getState().subtreeUsage).toEqual({ completeness: 'partial', inputTokens: 100, outputTokens: 20 });
  });

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

function runDetail(runId: string, inputTokens: number, childRunIds: string[] = []): PublicRunDetail {
  return {
    runId, profileId: 'profile', status: 'completed', stage: 'postmortem', contextVersion: 1,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    evidenceIds: [], missingEvidence: [], childRunIds,
    usage: { completeness: 'complete', inputTokens, outputTokens: 20 },
  };
}

function evidence(evidenceId: string, runId: string): PublicEvidenceView {
  return {
    evidenceId, runId, source: 'prometheus', state: 'available',
    capturedAt: '2026-10-01T00:00:02.000Z', summary: { status: 'breached' }, traceIdCount: 0, retrievable: false,
  };
}

function viewClient(detail: PublicRunDetail): RunViewClient {
  return {
    listProfiles: () => Promise.resolve([]), listRuns: () => Promise.resolve({ items: [] }),
    getRun: () => Promise.resolve(detail), getMessages: () => Promise.resolve({ items: [] }),
    listEvidence: () => Promise.resolve({ items: [] }), getConfirmation: () => Promise.resolve(null),
    startRun: () => Promise.resolve({ runId: detail.runId, status: 'started', eventsUrl: `/runs/${detail.runId}/events` }),
    resumeRun: () => Promise.resolve({ runId: detail.runId, status: 'resuming', eventsUrl: `/runs/${detail.runId}/events` }),
    decideConfirmation: () => Promise.resolve({ outcome: 'rejected', revision: 1 }),
    openRunEvents: () => ({ close: () => undefined }),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
