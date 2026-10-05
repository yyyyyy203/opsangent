import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAcceptanceFixture } from './fixtures/acceptance-cases.js';
import type { AgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import type { RealModelAcceptanceDependencies } from '../src/acceptance/real-model-runner.js';
import type { CreateOpenAICompatibleModelOptions } from '../src/bootstrap/openai-compatible.js';
import type { PublicEvidenceView } from '../src/contracts/read-model.js';
import {
  createLangSmithAuditedFetch,
  isPublicEvidenceEnvelope,
  isPublicEventEnvelope,
  isPublicMessageEnvelope,
  isPublicPageEnvelope,
  isPublicBoundaryPayloadSafe,
  isSafeLangSmithExportBody,
  matchesPublicEvidenceView,
  runRealModelAcceptance,
  type RealModelAcceptanceOptions,
} from '../src/acceptance/real-model-runner.js';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const PRECHECK_ROOT = resolve(tmpdir(), 'agentops-real-model-runner-test');

describe('acceptance boundary payload audit', () => {
  it('accepts only the public Evidence view fields and rejects raw-content additions', () => {
    const evidence: PublicEvidenceView = {
      evidenceId: 'evidence-1', runId: 'run-1', source: 'log', state: 'committed',
      capturedAt: '2026-10-05T00:00:00.000Z', summary: {
        recordCount: 1, sourceBytes: 100, storedBytes: 50, coverage: 1, truncated: false, missingEvidence: [],
      },
      traceIdCount: 0, retrievable: false, rawSha256: 'a'.repeat(64), coverage: 1, truncated: false,
      recordCount: 1, sourceBytes: 100, storedBytes: 50, chunkCount: 1,
      timeRange: { start: '2026-10-05T00:00:00.000Z', end: '2026-10-05T00:00:00.000Z' },
    };
    expect(isPublicEvidenceEnvelope(evidence)).toBe(true);
    expect(isPublicEvidenceEnvelope({ ...evidence, content: 'raw log body' })).toBe(false);
    expect(isPublicEvidenceEnvelope({ ...evidence, samples: [{ message: 'raw log body' }] })).toBe(false);
    expect(isPublicEvidenceEnvelope({ ...evidence, summary: { ...evidence.summary, samples: [{ message: 'raw log body' }] } })).toBe(false);
    expect(isPublicEvidenceEnvelope({ ...evidence, summary: { ...evidence.summary, content: 'raw log body' } })).toBe(false);
    expect(isPublicPageEnvelope({ items: [evidence] })).toBe(true);
    expect(isPublicPageEnvelope({ items: [evidence], rawRecords: ['raw log body'] })).toBe(false);
    expect(matchesPublicEvidenceView(evidence, evidence)).toBe(true);
    expect(matchesPublicEvidenceView({ ...evidence, state: 'partial' }, evidence)).toBe(false);
    expect(matchesPublicEvidenceView({ ...evidence, rawSha256: 'b'.repeat(64) }, evidence)).toBe(false);

    const metricEvidence: PublicEvidenceView = {
      evidenceId: 'metric-evidence-1', runId: 'run-1', source: 'metric', state: 'committed',
      capturedAt: '2026-10-05T00:00:00.000Z', summary: {
        status: 'breached', total: 100, failed: 15, failureRate: 0.15, threshold: 0.05, minSamples: 20,
        service: 'checkout', environment: 'simulation', start: 1_791_158_100, end: 1_791_158_400,
        missingEvidence: ['logs', 'traces'],
      },
      traceIdCount: 0, retrievable: false,
    };
    expect(isPublicEvidenceEnvelope(metricEvidence)).toBe(true);
    expect(isPublicEvidenceEnvelope({ ...metricEvidence, summary: { ...metricEvidence.summary, samples: ['raw'] } })).toBe(false);
  });

  it('accepts public evidence summaries and cryptographic references without raw payloads', () => {
    expect(isPublicBoundaryPayloadSafe({
      evidenceId: 'metric-evidence-1', runId: 'metrics-run', retrievable: false,
      summary: { failureRate: 0.15, total: 100 }, rawSha256: 'a'.repeat(64),
    })).toBe(true);
  });

  it('rejects raw evidence fields and any configured credential in public responses', () => {
    expect(isPublicBoundaryPayloadSafe({ evidence: { rawLog: 'PRIVATE_RAW_LOG' } })).toBe(false);
    expect(isPublicBoundaryPayloadSafe({ summary: 'private credential value' }, ['private credential'])).toBe(false);
  });

  it('rejects credential fields, credential-shaped values, internal addresses, and local filesystem paths', () => {
    for (const payload of [
      { password: 'value' },
      { systemPrompt: 'private' },
      { storageKey: 'private' },
      { value: 'Bearer token-value' },
      { value: 'D:\\agentops\\private\\storage.db' },
      { value: '/var/lib/agentops/storage.db' },
      { endpoint: 'http://127.0.0.1:9200/private' },
    ]) expect(isPublicBoundaryPayloadSafe(payload)).toBe(false);
    expect(isPublicBoundaryPayloadSafe({ summary: 'settlement failure rate is high' })).toBe(true);
    const secret = 'synthetic-token-canary-847291';
    expect(isPublicBoundaryPayloadSafe({ [secret]: 'opaque' }, [secret])).toBe(false);
    expect(isPublicBoundaryPayloadSafe({ value: 'file:///D:/private/runtime.sqlite' })).toBe(false);
  });

  it('validates public Message V2 pages and complete SSE terminal envelopes', () => {
    const message = {
      schemaVersion: 2,
      id: 'message-1',
      runId: 'run-1',
      role: 'assistant',
      status: 'completed',
      visibility: 'user',
      blocks: [{ type: 'text', blockId: 'block-1', text: 'Inspection complete.' }],
      createdAt: '2026-10-04T12:00:00.000Z',
      completedAt: '2026-10-04T12:00:01.000Z',
    };
    expect(isPublicMessageEnvelope(message)).toBe(true);
    const pageItem = { message, version: 1, truncated: false };
    expect(isPublicMessageEnvelope(pageItem, 'run-1')).toBe(true);
    expect(isPublicMessageEnvelope({ ...pageItem, message: { ...message, runId: 'another-run' } }, 'run-1')).toBe(false);
    expect(isPublicMessageEnvelope({ ...pageItem, unknown: 'field' }, 'run-1')).toBe(false);
    expect(isPublicMessageEnvelope(42)).toBe(false);
    expect(isPublicMessageEnvelope({ ...message, visibility: 'audit' })).toBe(false);

    const terminal = {
      schemaVersion: 2,
      eventId: 'acceptance-sse-1',
      sequence: 1,
      type: 'RUN_FINISHED',
      runId: 'run-1',
      correlationId: 'acceptance-correlation',
      timestamp: '2026-10-04T12:00:01.000Z',
      durability: 'durable',
      payload: { outcome: 'complete', durationMs: 1_000 },
    };
    expect(isPublicEventEnvelope(terminal, 'run-1')).toBe(true);
    const stepStarted = { ...terminal, type: 'STEP_STARTED', payload: { iteration: 1, stage: 'triage', budgetSnapshot: {} } };
    expect(isPublicEventEnvelope(stepStarted, 'run-1')).toBe(true);
    expect(isPublicEventEnvelope({ ...stepStarted, payload: {} }, 'run-1')).toBe(false);
    expect(isPublicEventEnvelope({ runId: 'run-1', type: 'RUN_FINISHED' }, 'run-1')).toBe(false);
    expect(isPublicEventEnvelope({ ...terminal, runId: 'another-run' }, 'run-1')).toBe(false);
    expect(isPublicEventEnvelope({ ...terminal, payload: {} }, 'run-1')).toBe(false);
  });

  it('audits serialized LangSmith SDK batches and fails closed for unsanitized run data', () => {
    const safeBatch = JSON.stringify({ post: [{
      id: 'remote-run-id', name: 'model.deepseek', run_type: 'llm', trace_id: 'remote-trace-id', start_time: 0,
      session_name: 'acceptance-test', dotted_order: '20261005T120000000000Zremote-run-id', serialized: {},
      child_runs: [], attachments: [], events: [], tags: [],
      inputs: { profile: 'simulation', purpose: 'inspection' },
      outputs: { status: 'completed', usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      extra: { metadata: { eventType: 'MODEL_CALL_COMPLETED', provider: 'deepseek' } }, error: null,
    }] });
    const unsafeBatch = JSON.stringify({ post: [{
      id: 'remote-run-id', name: 'model.deepseek', run_type: 'llm', inputs: { prompt: 'PRIVATE_PROMPT' },
    }] });
    const safeRun = JSON.parse(safeBatch) as { post: Record<string, unknown>[] };
    const hiddenRuntimeBatch = JSON.stringify({ post: [{
      ...safeRun.post[0], extra: { metadata: { eventType: 'MODEL_CALL_COMPLETED' }, runtime: { platform: 'node' } },
    }] });
    const unknownEnvelopeBatch = JSON.stringify({ post: [{ ...safeRun.post[0], storagePath: 'opaque' }] });
    const coercedRunTypeBatch = JSON.stringify({ post: [{ ...safeRun.post[0], run_type: ['llm'] }] });
    const unicodeSessionNameBatch = JSON.stringify({ post: [{ ...safeRun.post[0], session_name: 'Agent Acceptance 巡检' }] });

    expect(isSafeLangSmithExportBody(safeBatch)).toBe(true);
    expect(isSafeLangSmithExportBody(unsafeBatch)).toBe(false);
    expect(isSafeLangSmithExportBody(hiddenRuntimeBatch)).toBe(false);
    expect(isSafeLangSmithExportBody(unknownEnvelopeBatch)).toBe(false);
    expect(isSafeLangSmithExportBody(coercedRunTypeBatch)).toBe(false);
    expect(isSafeLangSmithExportBody(unicodeSessionNameBatch)).toBe(true);
    expect(isSafeLangSmithExportBody(safeBatch, ['remote-run-id'])).toBe(false);
  });

  it('blocks an unsafe outbound LangSmith request before network transmission', async () => {
    const send = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response('{}', { status: 200 })));
    const onUnsafe = vi.fn();
    const audited = createLangSmithAuditedFetch(send, {
      enabled: true,
      apiKey: 'test-langsmith-key',
      projectName: 'acceptance-test',
      endpoint: 'https://smith.invalid',
    }, [], onUnsafe);

    const response = await audited('https://smith.invalid/runs/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post: [{ id: 'run-1', name: 'model.test', run_type: 'llm', inputs: { prompt: 'private' } }] }),
    });

    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(onUnsafe).toHaveBeenCalledOnce();
  });
});

afterEach(async () => {
  await rm(PRECHECK_ROOT, { recursive: true, force: true });
});

describe('runRealModelAcceptance preflight', () => {
  it('rejects an unauthorized smoke before starting the Lab', async () => {
    const startLab = vi.fn(() => Promise.reject(new Error('MUST_NOT_START')));
    const options = makeOptions({ authorization: 'none' });

    await expect(runRealModelAcceptance(options, { startLab, now: () => NOW }))
      .rejects.toMatchObject({ code: 'SMOKE_NOT_AUTHORIZED' });
    expect(startLab).not.toHaveBeenCalled();
  });

  it('rejects an unsafe model endpoint before starting the Lab', async () => {
    const startLab = vi.fn(() => Promise.reject(new Error('MUST_NOT_START')));
    const options = makeOptions({ modelConfig: { baseUrl: 'http://model.example/v1' } });

    await expect(runRealModelAcceptance(options, { startLab, now: () => NOW }))
      .rejects.toMatchObject({ code: 'PRECHECK_MODEL_CONFIG_INVALID' });
    expect(startLab).not.toHaveBeenCalled();
  });

  it('rejects a stale lab snapshot before creating the Web runtime or posting a Run', async () => {
    const closeLab = vi.fn(() => Promise.resolve());
    const startLab = vi.fn<NonNullable<RealModelAcceptanceDependencies['startLab']>>(() => Promise.resolve({
      metricsMcpUrl: 'http://127.0.0.1:19210/mcp',
      logsMcpUrl: 'http://127.0.0.1:19211/mcp',
      statusUrl: 'http://127.0.0.1:19209/status',
      scenario: 'settlement_failure' as const,
      snapshotId: 'snapshot-test',
      expiresAt: new Date(NOW + 99_999).toISOString(),
      close: closeLab,
    }));
    const startWeb = vi.fn<NonNullable<RealModelAcceptanceDependencies['startWeb']>>(
      () => Promise.reject(new Error('MUST_NOT_START')),
    );
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error('MUST_NOT_FETCH')));

    await expect(runRealModelAcceptance(makeOptions(), { startLab, startWeb, fetch, now: () => NOW }))
      .rejects.toMatchObject({ code: 'PRECHECK_SNAPSHOT_TOO_CLOSE' });
    expect(startWeb).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(closeLab).toHaveBeenCalledOnce();
  });

  it('rechecks Lab readiness immediately before the single parent Run POST', async () => {
    const closeLab = vi.fn(() => Promise.resolve());
    const closeWeb = vi.fn(() => Promise.resolve());
    const expiresAt = new Date(NOW + 120_000).toISOString();
    const lab = {
      metricsMcpUrl: 'http://127.0.0.1:19210/mcp',
      logsMcpUrl: 'http://127.0.0.1:19211/mcp',
      statusUrl: 'http://127.0.0.1:19209/status',
      scenario: 'settlement_failure' as const,
      snapshotId: 'snapshot-test',
      expiresAt,
      close: closeLab,
    };
    const webUrl = 'http://127.0.0.1:42001';
    const fakeWeb: AgentWebRuntime = {
      url: webUrl,
      server: { host: '127.0.0.1', port: 42001, url: webUrl, server: createServer(), close: () => Promise.resolve() },
      flushEventObservability: () => Promise.resolve(),
      close: closeWeb,
    };
    const startLab = vi.fn<NonNullable<RealModelAcceptanceDependencies['startLab']>>(() => Promise.resolve(lab));
    const startWeb = vi.fn<NonNullable<RealModelAcceptanceDependencies['startWeb']>>(() => Promise.resolve(fakeWeb));
    let statusReads = 0;
    let parentPosts = 0;
    const httpFetch: typeof globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.pathname === '/status') {
        statusReads += 1;
        const readiness = statusReads === 1 ? 'ready' : 'not_ready';
        return Promise.resolve(Response.json({ readiness, scenario: 'settlement_failure', snapshotId: 'snapshot-test', expiresAt }));
      }
      if (url.pathname === '/runs' && method === 'POST') {
        parentPosts += 1;
        return Promise.resolve(Response.json({ runId: 'unexpected-parent-run', status: 'started' }, { status: 202 }));
      }
      return Promise.reject(new Error('UNEXPECTED_LOCAL_HTTP_REQUEST'));
    };

    await expect(runRealModelAcceptance(makeOptions(), {
      startLab, startWeb, httpFetch, now: () => NOW,
    })).rejects.toMatchObject({ code: 'PRECHECK_LAB_NOT_READY' });

    expect(statusReads).toBe(2);
    expect(parentPosts).toBe(0);
    expect(closeWeb).toHaveBeenCalledOnce();
    expect(closeLab).toHaveBeenCalledOnce();
  });

  it('starts one parent Run, closes only owned resources, and writes a review-required report', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'agentops-real-runner-success-'));
    const expiresAt = new Date(NOW + 120_000).toISOString();
    const labClose = vi.fn(() => Promise.resolve());
    const webClose = vi.fn(() => Promise.resolve());
    const flush = vi.fn(() => Promise.resolve());
    const lab = {
      metricsMcpUrl: 'http://127.0.0.1:19210/mcp',
      logsMcpUrl: 'http://127.0.0.1:19211/mcp',
      statusUrl: 'http://127.0.0.1:19209/status',
      scenario: 'settlement_failure' as const,
      snapshotId: 'snapshot-test',
      expiresAt,
      close: labClose,
    };
    const webUrl = 'http://127.0.0.1:42001';
    const fakeWeb: AgentWebRuntime = {
      url: webUrl,
      server: { host: '127.0.0.1', port: 42001, url: webUrl, server: createServer(), close: () => Promise.resolve() },
      flushEventObservability: flush,
      close: webClose,
    };
    const startLab = vi.fn<NonNullable<RealModelAcceptanceDependencies['startLab']>>(() => Promise.resolve(lab));
    const startWeb = vi.fn<NonNullable<RealModelAcceptanceDependencies['startWeb']>>(() => Promise.resolve(fakeWeb));
    const posts: string[] = [];
    const publicReads = new Set<string>();
    const fixture = createAcceptanceFixture('settlement_failure');
    const snapshotEvidence = fixture.evidence.map((item) => item.source === 'metric'
      ? { ...item, summary: {
        status: fixture.metricFact.status,
        total: fixture.metricFact.total,
        failed: fixture.metricFact.failed,
        failureRate: fixture.metricFact.failureRate,
        threshold: fixture.metricFact.threshold,
        minSamples: fixture.metricFact.minSamples,
        service: fixture.metricFact.service,
        environment: fixture.metricFact.environment,
        start: fixture.metricFact.start,
        end: fixture.metricFact.end,
        missingEvidence: ['logs', 'traces'],
      } }
      : item);
    const httpFetch: typeof globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.pathname === '/status') {
        return Promise.resolve(Response.json({ readiness: 'ready', scenario: 'settlement_failure', snapshotId: 'snapshot-test', expiresAt }));
      }
      if (url.pathname === '/runs' && method === 'POST') {
        const body = init?.body;
        posts.push(typeof body === 'string' ? body : '');
        return Promise.resolve(Response.json({ runId: 'acceptance-settlement_failure-parent', status: 'started' }, { status: 202 }));
      }
      if (url.pathname === '/runs/acceptance-settlement_failure-parent') {
        return Promise.resolve(Response.json({ runId: 'acceptance-settlement_failure-parent', status: 'completed' }));
      }
      const publicRoute = /^\/runs\/([^/]+)\/(messages|evidence|events)$/u.exec(url.pathname);
      if (publicRoute?.[1] !== undefined && publicRoute[2] !== undefined) {
        publicReads.add(`${publicRoute[2]}:${publicRoute[1]}`);
        if (publicRoute[2] === 'events') {
          const stepStarted = {
            schemaVersion: 2, eventId: 'acceptance-sse-step-1', sequence: 1, type: 'STEP_STARTED', runId: publicRoute[1],
            correlationId: 'acceptance-correlation', timestamp: '2026-10-04T12:00:00.500Z', durability: 'durable',
            payload: { iteration: 1, stage: 'triage', budgetSnapshot: {} },
          };
          return Promise.resolve(new Response(
            `event: STEP_STARTED\ndata: ${JSON.stringify(stepStarted)}\n\nevent: RUN_FINISHED\ndata: ${JSON.stringify({
              schemaVersion: 2, eventId: 'acceptance-sse-2', sequence: 2, type: 'RUN_FINISHED', runId: publicRoute[1],
              correlationId: 'acceptance-correlation', timestamp: '2026-10-04T12:00:01.000Z', durability: 'durable',
              payload: { outcome: 'complete', durationMs: 1_000 },
            })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          ));
        }
        const items = publicRoute[2] === 'messages'
          ? [{
            message: {
              schemaVersion: 2, id: `public-${publicRoute[1]}`, runId: publicRoute[1], role: 'assistant',
              status: 'completed', visibility: 'user',
              blocks: [{ type: 'text', blockId: `public-block-${publicRoute[1]}`, text: 'Inspection evidence is available.' }],
              createdAt: '2026-10-04T12:00:00.000Z', completedAt: '2026-10-04T12:00:01.000Z',
            },
            version: 1,
            truncated: false,
          }]
          : publicRoute[2] === 'evidence'
          ? publicRoute[1] === fixture.parent.runId
            ? snapshotEvidence
            : snapshotEvidence.filter((item) => item.runId === publicRoute[1])
          : [];
        return Promise.resolve(Response.json({ items }));
      }
      const evidenceDetail = /^\/runs\/([^/]+)\/evidence\/([^/]+)$/u.exec(url.pathname);
      if (evidenceDetail?.[1] !== undefined && evidenceDetail[2] !== undefined) {
        const evidence = snapshotEvidence.find((item) => item.evidenceId === evidenceDetail[2]
          && (evidenceDetail[1] === fixture.parent.runId || item.runId === evidenceDetail[1]));
        return Promise.resolve(evidence === undefined ? Response.json({ error: 'NOT_FOUND' }, { status: 404 }) : Response.json(evidence));
      }
      return Promise.reject(new Error('UNEXPECTED_LOCAL_HTTP_REQUEST'));
    };
    const dependencies: RealModelAcceptanceDependencies = {
      startLab,
      startWeb,
      httpFetch,
      fetch: () => Promise.reject(new Error('MODEL_MUST_NOT_BE_CALLED_BY_FAKE_WEB')),
      now: () => NOW,
      readSnapshot: () => Promise.resolve({
        parent: fixture.parent,
        children: fixture.children,
        evidence: snapshotEvidence,
        events: fixture.events,
      }),
    };

    try {
      const report = await runRealModelAcceptance(makeOptions({
        dataDirectory: resolve(root, 'data'),
        workspaceRoot: root,
        artifactDirectory: resolve(root, 'artifacts'),
      }), dependencies);
      expect(report.verdict).toBe('review_required');
      expect(report.traceVerification.status).toBe('unavailable');
      expect(publicReads.size).toBe(9);
      expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0] ?? '{}')).toMatchObject({ profileId: 'simulation', maxDurationMs: 90_000, maxToolCalls: 12 });
      expect(startWeb.mock.calls[0]?.[0]).toMatchObject({ sourceInvocationLimit: 1, host: '127.0.0.1', port: 0 });
      expect(flush).toHaveBeenCalledOnce();
      expect(webClose).toHaveBeenCalledOnce();
      expect(labClose).toHaveBeenCalledOnce();
      const stored = await readFile(resolve(root, 'data', 'acceptance', `${report.runId}.json`), 'utf8');
      const artifact = await readFile(resolve(root, 'artifacts', `${report.runId}.json`), 'utf8');
      expect(stored).toBe(artifact);
      expect(stored).not.toContain('test-only-api-key');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

type RunnerOverrides = Omit<Partial<RealModelAcceptanceOptions>, 'modelConfig'> & {
  modelConfig?: Partial<CreateOpenAICompatibleModelOptions>;
};

function makeOptions(overrides: RunnerOverrides = {}): RealModelAcceptanceOptions {
  const root = PRECHECK_ROOT;
  const { modelConfig, ...otherOverrides } = overrides;
  return {
    authorization: 'explicit-smoke',
    dataDirectory: resolve(root, 'data'),
    workspaceRoot: resolve(root, 'workspace'),
    artifactDirectory: resolve(root, 'artifacts'),
    modelIdentity: { provider: 'test-provider', model: 'test-model' },
    langSmithConfig: { enabled: false },
    lab: {
      elasticsearchUrl: 'http://127.0.0.1:19200',
      prometheusUrl: 'http://127.0.0.1:19290',
      labCursorSecret: 'test-only-lab-secret-0123456789012345',
      evidenceCursorSecret: 'test-only-evidence-secret-0123456789012345',
    },
    codeRevision: 'test-revision',
    profileRevision: 'simulation-v1',
    ...otherOverrides,
    modelConfig: { baseUrl: 'https://model.example/v1', apiKey: 'test-only-api-key', model: 'test-model', ...modelConfig },
  };
}
