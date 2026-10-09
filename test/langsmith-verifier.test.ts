import { Client } from 'langsmith';
import type { AgentEventEnvelopeV2, AgentEventPayloadMap, AgentEventTypeV2, PublicRunDetail } from '../src/contracts/index.js';
import type { TraceLink } from '../src/bootstrap/langsmith.js';
import type { AcceptanceSnapshot } from '../src/acceptance/types.js';
import { describe, expect, it } from 'vitest';
import {
  inspectLangSmithRunPayloadDetails,
  isSafeLangSmithRunPayload,
  verifyLangSmithTrace,
} from '../src/acceptance/langsmith-verifier.js';

const PARENT_RUN_ID = 'acceptance-parent';
const CHILD_RUN_ID = 'acceptance-metrics-child';
const TRACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARENT_REMOTE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOOL_REMOTE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INVOCATION_REMOTE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CHILD_REMOTE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MODEL_REMOTE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const EXPECTED_USAGE = { inputTokens: 12, outputTokens: 5 };
const EVENT_TIME = '2026-10-04T12:00:00.000Z';

describe('LangSmith remote payload privacy', () => {
  it('distinguishes non-object responses from unselected top-level fields without returning field names', () => {
    expect(inspectLangSmithRunPayloadDetails(null)).toEqual({
      issue: 'remote_run_top_level_shape_invalid',
      topLevelShape: 'not_object',
    });
    expect(inspectLangSmithRunPayloadDetails({ id: 'remote-run', privateField: 'REMOTE_CANARY' })).toEqual({
      issue: 'remote_run_top_level_shape_invalid',
      topLevelShape: 'unselected_fields',
      unexpectedTopLevelFieldCount: 1,
    });
  });

  it('rejects credential-shaped strings even inside allowlisted metadata fields', () => {
    expect(isSafeLangSmithRunPayload({
      id: 'remote-run',
      name: 'agent.run',
      run_type: 'chain',
      inputs: { profile: 'simulation' },
      outputs: { status: 'completed' },
      extra: { metadata: { provider: 'sk-SYNTHETIC_ACCESS_KEY_CANARY_LONG' } },
    })).toBe(false);
  });

  it.each([
    [0, true],
    [4, true],
    [-1, false],
    [1.5, false],
    ['0', false],
  ] as const)('validates readback LangSmith run depth %j as a nonnegative safe integer', (depth, expected) => {
    expect(isSafeLangSmithRunPayload({
      id: 'remote-run',
      name: 'agent.run',
      run_type: 'chain',
      inputs: { profile: 'simulation' },
      outputs: { status: 'completed' },
      extra: { metadata: { ls_run_depth: depth } },
    })).toBe(expected);
  });
});

interface RemoteRun {
  readonly id: string;
  readonly trace_id: string;
  readonly parent_run_id?: string | null;
  readonly name: string;
  readonly run_type: string;
  readonly end_time?: string | number;
  readonly status?: string;
  readonly error?: string | null;
  readonly inputs?: Record<string, unknown>;
  readonly outputs?: Record<string, unknown>;
  readonly extra?: Record<string, unknown>;
}

interface QueryParams { readonly id?: readonly string[]; readonly limit?: number; readonly select?: readonly string[] }

function createFixture(): { snapshot: AcceptanceSnapshot; links: TraceLink[]; remoteRuns: RemoteRun[] } {
  let sequence = 0;
  const event = <T extends AgentEventTypeV2>(
    type: T,
    payload: AgentEventPayloadMap[T],
    overrides: Partial<AgentEventEnvelopeV2<T>> = {},
  ): AgentEventEnvelopeV2<T> => {
    sequence += 1;
    return {
      schemaVersion: 2,
      eventId: `acceptance-event-${sequence}`,
      sequence,
      type,
      payload,
      runId: PARENT_RUN_ID,
      correlationId: 'acceptance-correlation',
      timestamp: EVENT_TIME,
      visibility: 'audit',
      durability: 'durable',
      ...overrides,
    } as AgentEventEnvelopeV2<T>;
  };

  const events: AgentEventEnvelopeV2[] = [
    event('RUN_STARTED', {
      profile: 'simulation', trigger: 'manual', deadline: '2026-10-04T12:01:00.000Z', versionSnapshot: {},
    }, { streamId: 'parent-stream' }),
    event('TOOL_STARTED', { toolName: 'metrics_subagent', source: 'subagent', attempt: 1 }, {
      streamId: 'parent-stream', toolCallId: 'metrics-call', attemptId: 'tool-attempt-1',
    }),
    event('SUBAGENT_STARTED', {
      subagentType: 'metrics', childRunId: CHILD_RUN_ID, parentRunId: PARENT_RUN_ID,
      budget: { type: 'tool_calls', limit: 4, used: 1 },
    }, { streamId: 'parent-stream', toolCallId: 'metrics-call' }),
    event('RUN_STARTED', {
      profile: 'simulation', trigger: 'source-child', deadline: '2026-10-04T12:01:00.000Z', versionSnapshot: {},
    }, { runId: CHILD_RUN_ID, parentRunId: PARENT_RUN_ID, streamId: 'child-stream' }),
    event('MODEL_CALL_STARTED', {
      provider: 'test-provider', model: 'test-model', purpose: 'diagnosis', attempt: 1, inputSummary: 'safe',
    }, { runId: CHILD_RUN_ID, parentRunId: PARENT_RUN_ID, streamId: 'child-stream', attemptId: 'model-attempt-1' }),
    event('MODEL_CALL_COMPLETED', {
      provider: 'test-provider', model: 'test-model', attempt: 1, usage: EXPECTED_USAGE, durationMs: 25,
    }, { runId: CHILD_RUN_ID, parentRunId: PARENT_RUN_ID, streamId: 'child-stream', attemptId: 'model-attempt-1' }),
    event('RUN_FINISHED', { outcome: 'complete', durationMs: 50, usage: EXPECTED_USAGE, usageCompleteness: 'complete' }, {
      runId: CHILD_RUN_ID, parentRunId: PARENT_RUN_ID, streamId: 'child-stream',
    }),
    event('SUBAGENT_COMPLETED', {
      childRunId: CHILD_RUN_ID, status: 'completed', evidenceIds: [], coverage: 1,
    }, { streamId: 'parent-stream', toolCallId: 'metrics-call' }),
    event('TOOL_RESULT', {
      result: {
        toolCallId: 'metrics-call', toolName: 'metrics_subagent', status: 'success',
        response: { blocks: [] }, startedAt: EVENT_TIME, finishedAt: EVENT_TIME,
      },
      durationMs: 25,
      evidenceIds: [],
    }, { streamId: 'parent-stream', toolCallId: 'metrics-call', attemptId: 'tool-attempt-1' }),
    event('RUN_FINISHED', { outcome: 'complete', durationMs: 75, usageCompleteness: 'unavailable' }, {
      runId: PARENT_RUN_ID, streamId: 'parent-stream',
    }),
  ];

  const parent: PublicRunDetail = {
    runId: PARENT_RUN_ID, profileId: 'simulation', status: 'completed', stage: 'postmortem',
    contextVersion: 1, createdAt: EVENT_TIME, updatedAt: EVENT_TIME,
    evidenceIds: [], missingEvidence: [], childRunIds: [CHILD_RUN_ID],
  };
  const child: PublicRunDetail = {
    runId: CHILD_RUN_ID, profileId: 'simulation', status: 'completed', stage: 'postmortem',
    contextVersion: 1, createdAt: EVENT_TIME, updatedAt: EVENT_TIME,
    parentRunId: PARENT_RUN_ID, evidenceIds: [], missingEvidence: [], childRunIds: [],
  };
  const links: TraceLink[] = [
    { spanKey: `run:${PARENT_RUN_ID}:parent-stream`, agentRunId: PARENT_RUN_ID, remoteRunId: PARENT_REMOTE_ID, traceId: TRACE_ID },
    {
      spanKey: `tool:${PARENT_RUN_ID}:parent-stream:metrics-call:tool-attempt-1`, agentRunId: PARENT_RUN_ID,
      remoteRunId: TOOL_REMOTE_ID, traceId: TRACE_ID, parentRemoteRunId: PARENT_REMOTE_ID,
    },
    {
      spanKey: `source:${PARENT_RUN_ID}:metrics-call:${CHILD_RUN_ID}`, agentRunId: PARENT_RUN_ID,
      remoteRunId: INVOCATION_REMOTE_ID, traceId: TRACE_ID, parentRemoteRunId: TOOL_REMOTE_ID,
    },
    {
      spanKey: `run:${CHILD_RUN_ID}:child-stream`, agentRunId: CHILD_RUN_ID,
      remoteRunId: CHILD_REMOTE_ID, traceId: TRACE_ID, parentRemoteRunId: INVOCATION_REMOTE_ID,
    },
    {
      spanKey: `model:${CHILD_RUN_ID}:child-stream:model-attempt-1`, agentRunId: CHILD_RUN_ID,
      remoteRunId: MODEL_REMOTE_ID, traceId: TRACE_ID, parentRemoteRunId: CHILD_REMOTE_ID,
    },
  ];
  const remoteRuns: RemoteRun[] = [
    createRemoteRun(links[0]!, 'chain', 'agent.run', null, { status: 'completed' }),
    createRemoteRun(links[1]!, 'tool', 'tool.metrics_subagent', PARENT_REMOTE_ID, { status: 'success' }),
    createRemoteRun(links[2]!, 'chain', 'subagent.metrics', TOOL_REMOTE_ID, { status: 'completed' }),
    createRemoteRun(links[3]!, 'chain', 'agent.run', INVOCATION_REMOTE_ID, { status: 'completed' }),
    createRemoteRun(links[4]!, 'llm', 'model.test-model', CHILD_REMOTE_ID, {
      usage_metadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    }),
  ];

  return { snapshot: { parent, children: [child], evidence: [], events }, links, remoteRuns };
}

function createRemoteRun(
  link: TraceLink,
  runType: string,
  name: string,
  parentRunId: string | null,
  outputs: Record<string, unknown>,
): RemoteRun {
  return {
    id: link.remoteRunId,
    trace_id: link.traceId,
    ...(parentRunId === null ? { parent_run_id: null } : { parent_run_id: parentRunId }),
    name,
    run_type: runType,
    end_time: EVENT_TIME,
    status: 'success',
    outputs,
    extra: { metadata: { agentRunId: link.agentRunId, spanKey: link.spanKey } },
  };
}

function withFailedModelAttempt(
  fixture: ReturnType<typeof createFixture>,
  options: {
    readonly localUsage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly cachedInputTokens?: number } | undefined;
    readonly remoteStatus: string;
    readonly remoteError?: string | undefined;
    readonly remoteUsage?: Record<string, unknown> | undefined;
  },
): ReturnType<typeof createFixture> {
  const events = fixture.snapshot.events.map((item) => {
    if (item.type !== 'MODEL_CALL_COMPLETED') return item;
    const localUsage = Object.hasOwn(options, 'localUsage') ? options.localUsage : EXPECTED_USAGE;
    const failed: Extract<AgentEventEnvelopeV2, { type: 'MODEL_CALL_FAILED' }> = {
      ...item,
      type: 'MODEL_CALL_FAILED',
      payload: {
        error: { code: 'MODEL_ERROR', message: 'safe model failure', retryable: false },
        attempt: item.payload.attempt,
        retryable: false,
        durationMs: item.payload.durationMs,
        ...(localUsage === undefined ? {} : { usage: localUsage }),
        finishReason: 'length',
      },
    };
    return failed;
  });
  const remoteRuns = fixture.remoteRuns.map((run) => run.id === MODEL_REMOTE_ID
    ? {
      ...run,
      status: options.remoteStatus,
      ...(options.remoteError === undefined ? {} : { error: options.remoteError }),
      outputs: {
        status: options.remoteStatus,
        usage_metadata: options.remoteUsage ?? { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
        finishReason: 'length',
      },
    }
    : run);
  return { ...fixture, snapshot: { ...fixture.snapshot, events }, remoteRuns };
}

function createFakeClient(responses: readonly (readonly RemoteRun[] | Error)[]) {
  const requests: QueryParams[] = [];
  let queryIndex = 0;
  const fake = {
    listRuns(params: QueryParams): AsyncIterable<RemoteRun> {
      requests.push({
        ...(params.id === undefined ? {} : { id: [...params.id] }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.select === undefined ? {} : { select: params.select }),
      });
      const response = responses[Math.min(queryIndex++, responses.length - 1)] ?? [];
      return asAsyncIterable(response);
    },
  };
  return { client: fake as unknown as Client, requests };
}

function asAsyncIterable(response: readonly RemoteRun[] | Error): AsyncIterable<RemoteRun> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<RemoteRun> {
      if (response instanceof Error) {
        return { next: () => Promise.reject(response) };
      }
      const iterator = response[Symbol.iterator]();
      return { next: () => Promise.resolve(iterator.next()) };
    },
  };
}

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Expected a JSON request body.');
  return body;
}

function createSdkClient(fetchImplementation: typeof globalThis.fetch): Client {
  return new Client({
    apiUrl: 'https://langsmith.invalid',
    apiKey: 'unit-test-only-key',
    timeout_ms: 1_000,
    callerOptions: { maxRetries: 0 },
    fetchImplementation,
  });
}

describe('verifyLangSmithTrace', () => {
  it('verifies this run tree, canonical model usage, and the exact SDK ID filter', async () => {
    const fixture = createFixture();
    const unrelatedLink: TraceLink = {
      spanKey: 'run:unrelated:unrelated-stream',
      agentRunId: 'unrelated-run',
      remoteRunId: '11111111-1111-4111-8111-111111111111',
      traceId: '22222222-2222-4222-8222-222222222222',
    };
    const links = [...fixture.links, unrelatedLink];
    const fetchRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const byId = new Map(fixture.remoteRuns.map((run) => [run.id, run]));
    const client = createSdkClient((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = requestBody(init?.body);
      fetchRequests.push({
        url,
        body: JSON.parse(body) as Record<string, unknown>,
      });
      const ids = (JSON.parse(body) as { id: string[] }).id;
      return Promise.resolve(Response.json({ runs: ids.flatMap((id) => byId.has(id) ? [byId.get(id)] : []), cursors: {} }));
    });

    const result = await verifyLangSmithTrace({ ...fixture, links, client });

    expect(result).toEqual({ status: 'verified', checkedSpanCount: fixture.links.length });
    expect(fetchRequests).toHaveLength(1);
    expect(fetchRequests[0]?.url).toBe('https://langsmith.invalid/runs/query');
    expect(fetchRequests[0]?.body.id).toEqual(fixture.links.map((link) => link.remoteRunId).sort());
    expect(fetchRequests[0]?.body.limit).toBe(fixture.links.length);
    expect(fetchRequests[0]?.body).not.toHaveProperty('trace');
    expect(fetchRequests[0]?.body).not.toHaveProperty('projectName');
  });

  it('verifies linked remote spans without requiring local identifiers in uploaded metadata', async () => {
    const fixture = createFixture();
    const remoteRuns = fixture.remoteRuns.map((run) => ({ ...run, extra: { metadata: {} } }));
    const client = createFakeClient([remoteRuns]);

    const result = await verifyLangSmithTrace({ ...fixture, client: client.client });

    expect(result).toEqual({ status: 'verified', checkedSpanCount: fixture.links.length });
  });

  it('verifies the current child-owned Source lifecycle with a matching parent/tool/child identity', async () => {
    const fixture = createFixture();
    const events = fixture.snapshot.events.map((item) => item.type === 'SUBAGENT_STARTED'
      || item.type === 'SUBAGENT_COMPLETED'
      ? { ...item, runId: CHILD_RUN_ID, parentRunId: PARENT_RUN_ID }
      : item);
    const client = createFakeClient([fixture.remoteRuns]);

    const result = await verifyLangSmithTrace({ ...fixture, snapshot: { ...fixture.snapshot, events }, client: client.client });

    expect(result.status).toBe('verified');
    expect(client.requests).toHaveLength(1);
  });

  it('rejects a child-owned Source terminal tied to a different parent tool call before querying', async () => {
    const fixture = createFixture();
    const events = fixture.snapshot.events.map((item) => {
      if (item.type === 'SUBAGENT_STARTED' || item.type === 'SUBAGENT_COMPLETED') {
        return { ...item, runId: CHILD_RUN_ID, parentRunId: PARENT_RUN_ID,
          ...(item.type === 'SUBAGENT_COMPLETED' ? { toolCallId: 'different-tool-call' } : {}) };
      }
      return item;
    });
    const client = createFakeClient([fixture.remoteRuns]);
    let diagnostic: unknown;

    const result = await verifyLangSmithTrace({ ...fixture, snapshot: { ...fixture.snapshot, events }, client: client.client }, {
      onDiagnostic: (value) => { diagnostic = value; },
    });

    expect(result.status).toBe('failed');
    expect(client.requests).toHaveLength(0);
    expect(diagnostic).toEqual({ phase: 'local_snapshot', reason: 'invalid_source_invocation', remoteQueriesSent: 0 });
  });

  it('verifies a failed model attempt only when remote failure state and known usage match', async () => {
    const fixture = withFailedModelAttempt(createFixture(), { remoteStatus: 'failed', remoteError: 'TRACE_ERROR' });
    const client = createFakeClient([fixture.remoteRuns]);

    const result = await verifyLangSmithTrace({ ...fixture, client: client.client });

    expect(result.status).toBe('verified');
  });

  it('rejects a failed local attempt when remote model status or known usage disagrees', async () => {
    for (const remoteStatus of ['completed', 'failed'] as const) {
      const fixture = withFailedModelAttempt(createFixture(), {
        remoteStatus,
        remoteError: remoteStatus === 'failed' ? 'TRACE_ERROR' : undefined,
        remoteUsage: remoteStatus === 'failed' ? { input_tokens: 12, output_tokens: 6, total_tokens: 18 } : undefined,
      });
      const client = createFakeClient([fixture.remoteRuns]);

      const result = await verifyLangSmithTrace({ ...fixture, client: client.client });

      expect(result.status).toBe('failed');
    }
  });

  it('rejects a remote finish reason that disagrees with the known failed model attempt', async () => {
    const fixture = withFailedModelAttempt(createFixture(), { remoteStatus: 'failed', remoteError: 'TRACE_ERROR' });
    const remoteRuns = fixture.remoteRuns.map((run) => run.id === MODEL_REMOTE_ID
      ? { ...run, outputs: { ...run.outputs, finishReason: 'stop' } }
      : run);
    const client = createFakeClient([remoteRuns]);

    const result = await verifyLangSmithTrace({ ...fixture, client: client.client });

    expect(result.status).toBe('failed');
  });

  it('keeps failed-attempt verification unavailable when local usage is missing', async () => {
    const fixture = withFailedModelAttempt(createFixture(), {
      localUsage: undefined,
      remoteStatus: 'failed',
      remoteError: 'TRACE_ERROR',
    });
    const client = createFakeClient([fixture.remoteRuns, fixture.remoteRuns, fixture.remoteRuns]);
    let now = 0;

    const result = await verifyLangSmithTrace({ ...fixture, client: client.client }, {
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); },
    });

    expect(result.status).toBe('unavailable');
    expect(client.requests).toHaveLength(3);
  });

  it('reports invalid source identity locally and never queries remote spans', async () => {
    const fixture = createFixture();
    const events = fixture.snapshot.events.map((item) => item.type === 'SUBAGENT_STARTED'
      ? { ...item, runId: CHILD_RUN_ID, parentRunId: 'another-parent' }
      : item);
    const client = createFakeClient([fixture.remoteRuns]);
    let diagnostic: unknown;

    const result = await verifyLangSmithTrace({ ...fixture, snapshot: { ...fixture.snapshot, events }, client: client.client }, {
      onDiagnostic: (value) => { diagnostic = value; },
    });

    expect(result.status).toBe('failed');
    expect(client.requests).toHaveLength(0);
    expect(diagnostic).toEqual({ phase: 'local_snapshot', reason: 'invalid_source_invocation', remoteQueriesSent: 0 });
  });

  it('reports remote missing spans and usage mismatches with bounded query counts', async () => {
    const fixture = createFixture();
    let now = 0;
    const missing = createFakeClient([[], [], []]);
    let missingDiagnostic: unknown;
    const unavailable = await verifyLangSmithTrace({ ...fixture, client: missing.client }, {
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); },
      onDiagnostic: (value) => { missingDiagnostic = value; },
    });
    expect(unavailable.status).toBe('unavailable');
    expect(missing.requests).toHaveLength(3);
    expect(missingDiagnostic).toEqual({ phase: 'remote_query', reason: 'remote_unavailable', remoteQueriesSent: 3 });

    const wrongUsage = fixture.remoteRuns.map((run) => run.id === MODEL_REMOTE_ID
      ? { ...run, outputs: { usage_metadata: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }
      : run);
    const mismatch = createFakeClient([wrongUsage]);
    let mismatchDiagnostic: unknown;
    const failed = await verifyLangSmithTrace({ ...fixture, client: mismatch.client }, {
      onDiagnostic: (value) => { mismatchDiagnostic = value; },
    });
    expect(failed.status).toBe('failed');
    expect(mismatch.requests).toHaveLength(1);
    expect(mismatchDiagnostic).toEqual({ phase: 'remote_compare', reason: 'usage_mismatch', remoteQueriesSent: 1 });
  });

  it('fails closed when linked remote payloads contain fields outside the telemetry allowlist', async () => {
    const attacks: readonly { label: string; mutate: (run: RemoteRun) => RemoteRun }[] = [
      {
        label: 'model inputs',
        mutate: (run) => ({ ...run, inputs: { question: 'PRIVATE_PROMPT_CANARY' } }),
      },
      {
        label: 'run outputs',
        mutate: (run) => ({ ...run, outputs: { ...run.outputs, rawLog: 'PRIVATE_RAW_LOG_CANARY' } }),
      },
      {
        label: 'run metadata',
        mutate: (run) => ({ ...run, extra: { metadata: { rawLog: 'PRIVATE_METADATA_CANARY' } } }),
      },
      {
        label: 'unreviewed runtime fields',
        mutate: (run) => ({
          ...run,
          extra: { metadata: run.extra?.metadata, runtime: { systemPrompt: 'PRIVATE_RUNTIME_CANARY', storagePath: 'D:\\agentops\\private\\db.sqlite' } },
        }),
      },
      {
        label: 'unknown top-level SDK fields',
        mutate: (run) => ({ ...run, privateStorePath: 'D:\\agentops\\private\\db.sqlite' } as unknown as RemoteRun),
      },
    ];

    for (const attack of attacks) {
      const fixture = createFixture();
      const targetRunId = attack.label === 'model inputs' ? MODEL_REMOTE_ID : PARENT_REMOTE_ID;
      const remoteRuns = fixture.remoteRuns.map((run) => run.id === targetRunId ? attack.mutate(run) : run);
      const client = createFakeClient([remoteRuns]);

      const result = await verifyLangSmithTrace({ ...fixture, client: client.client });

      expect(result.status, attack.label).toBe('failed');
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_.*_CANARY/u);
      expect(client.requests[0]?.select).toContain('inputs');
      expect(client.requests[0]?.select).toContain('extra');
    }
  });

  it('returns unavailable rather than inventing usage when a canonical local attempt lacks tokens', async () => {
    const fixture = createFixture();
    const completionIndex = fixture.snapshot.events.findIndex((item) => item.type === 'MODEL_CALL_COMPLETED');
    const completion = fixture.snapshot.events[completionIndex];
    if (completion?.type !== 'MODEL_CALL_COMPLETED') throw new Error('Fixture model completion missing.');
    const events = [...fixture.snapshot.events];
    const payload = { ...completion.payload };
    delete payload.usage;
    events[completionIndex] = { ...completion, payload };
    const client = createFakeClient([fixture.remoteRuns]);
    let now = 0;

    const result = await verifyLangSmithTrace({
      ...fixture,
      snapshot: { ...fixture.snapshot, events },
      client: client.client,
    }, { now: () => now, sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); } });

    expect(result.status).toBe('unavailable');
    expect(result).not.toHaveProperty('usage');
  });

  it('returns unavailable when LangSmith omits canonical usage metadata', async () => {
    const fixture = createFixture();
    const remoteRuns = fixture.remoteRuns.map((run) => run.id === MODEL_REMOTE_ID
      ? { ...run, outputs: { status: 'completed' } }
      : run);
    const client = createFakeClient([remoteRuns, remoteRuns, remoteRuns]);
    let now = 0;

    const result = await verifyLangSmithTrace({ ...fixture, client: client.client }, {
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); },
    });

    expect(result.status).toBe('unavailable');
    expect(client.requests).toHaveLength(3);
  });

  it('fails when remote token usage disagrees with the local V2 attempt', async () => {
    const fixture = createFixture();
    const remoteRuns = fixture.remoteRuns.map((run) => run.id === MODEL_REMOTE_ID
      ? { ...run, outputs: { usage_metadata: { input_tokens: 13, output_tokens: 5, total_tokens: 18 } } }
      : run);
    const client = createFakeClient([remoteRuns]);

    const result = await verifyLangSmithTrace({ ...fixture, client: client.client });

    expect(result.status).toBe('failed');
  });

  it('fails when remote parent_run_id or trace_id disagrees with the linked hierarchy', async () => {
    const fixture = createFixture();
    const remoteRuns = fixture.remoteRuns.map((run) => run.id === CHILD_REMOTE_ID
      ? { ...run, parent_run_id: PARENT_REMOTE_ID, trace_id: PARENT_REMOTE_ID }
      : run);
    const client = createFakeClient([remoteRuns]);

    const result = await verifyLangSmithTrace({ ...fixture, client: client.client });

    expect(result.status).toBe('failed');
  });

  it('rejects duplicate local span links before making a remote query', async () => {
    const fixture = createFixture();
    const client = createFakeClient([fixture.remoteRuns]);

    const result = await verifyLangSmithTrace({ ...fixture, links: [...fixture.links, fixture.links[0]!], client: client.client });

    expect(result.status).toBe('failed');
    expect(client.requests).toHaveLength(0);
  });

  it('does not query when a required current-run TraceLink is missing', async () => {
    const fixture = createFixture();
    const client = createFakeClient([fixture.remoteRuns]);

    const result = await verifyLangSmithTrace({
      ...fixture,
      links: fixture.links.filter((link) => link.remoteRunId !== CHILD_REMOTE_ID),
      client: client.client,
    });

    expect(result.status).toBe('unavailable');
    expect(client.requests).toHaveLength(0);
  });

  it('rejects duplicate or unrelated remote run rows', async () => {
    const fixture = createFixture();
    const duplicated = createFakeClient([[...fixture.remoteRuns, fixture.remoteRuns[0]!]]);
    const duplicateResult = await verifyLangSmithTrace({ ...fixture, client: duplicated.client });
    expect(duplicateResult.status).toBe('failed');

    const foreign = { ...fixture.remoteRuns[0]!, id: '11111111-1111-4111-8111-111111111111' };
    const unrelated = createFakeClient([[foreign]]);
    const unrelatedResult = await verifyLangSmithTrace({ ...fixture, client: unrelated.client });
    expect(unrelatedResult.status).toBe('failed');
  });

  it.each([403, 404])('returns unavailable for LangSmith HTTP %i without broadening the query', async (status) => {
    const fixture = createFixture();
    let requests = 0;
    const client = createSdkClient(() => {
      requests += 1;
      return Promise.resolve(new Response(JSON.stringify({ detail: 'private remote error' }), { status }));
    });

    const result = await verifyLangSmithTrace({ ...fixture, client });

    expect(result.status).toBe('unavailable');
    expect(requests).toBe(1);
  });

  it('bounds network failures to three current-ID queries', async () => {
    const fixture = createFixture();
    const client = createFakeClient([
      new Error('synthetic network failure'),
      new Error('synthetic network failure'),
      new Error('synthetic network failure'),
    ]);
    let now = 0;

    const result = await verifyLangSmithTrace({ ...fixture, client: client.client }, {
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); },
    });

    expect(result.status).toBe('unavailable');
    expect(client.requests).toHaveLength(3);
  });

  it('retries a missing bounded result at most three times with one-second injected waits', async () => {
    const fixture = createFixture();
    const client = createFakeClient([[], fixture.remoteRuns]);
    const waits: number[] = [];
    let now = 0;

    const result = await verifyLangSmithTrace({ ...fixture, client: client.client }, {
      now: () => now,
      sleep: (milliseconds) => { waits.push(milliseconds); now += milliseconds; return Promise.resolve(); },
    });

    expect(result.status).toBe('verified');
    expect(client.requests).toHaveLength(2);
    expect(waits).toEqual([1_000]);
    for (const request of client.requests) {
      expect(request.id).toEqual(fixture.links.map((link) => link.remoteRunId).sort());
      expect(request.limit).toBe(fixture.links.length);
    }
  });

  it('does not exceed three queries when the remote never returns this run', async () => {
    const fixture = createFixture();
    const client = createFakeClient([[], [], []]);
    let now = 0;

    const result = await verifyLangSmithTrace({ ...fixture, client: client.client }, {
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); },
    });

    expect(result.status).toBe('unavailable');
    expect(client.requests).toHaveLength(3);
  });

  it('returns unavailable when a query exceeds the injected deadline', async () => {
    const fixture = createFixture();
    const never: AsyncIterable<RemoteRun> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<RemoteRun>>(() => undefined) }),
    };
    const hanging = { listRuns: () => never } as unknown as Client;
    let deadlineCalls = 0;
    const deadline = <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
      deadlineCalls += 1;
      void operation;
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(10_000);
      const error = new Error('deadline');
      error.name = 'TimeoutError';
      return Promise.reject(error);
    };

    const result = await verifyLangSmithTrace({ ...fixture, client: hanging }, { withDeadline: deadline });

    expect(result.status).toBe('unavailable');
    expect(deadlineCalls).toBe(1);
  });
});
