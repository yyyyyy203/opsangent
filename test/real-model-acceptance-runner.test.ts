import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAcceptanceFixture } from './fixtures/acceptance-cases.js';
import type { AgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import type { RealModelAcceptanceDependencies } from '../src/acceptance/real-model-runner.js';
import type { CreateOpenAICompatibleModelOptions } from '../src/bootstrap/openai-compatible.js';
import { runRealModelAcceptance, type RealModelAcceptanceOptions } from '../src/acceptance/real-model-runner.js';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const PRECHECK_ROOT = resolve(tmpdir(), 'agentops-real-model-runner-test');

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
      return Promise.reject(new Error('UNEXPECTED_LOCAL_HTTP_REQUEST'));
    };
    const fixture = createAcceptanceFixture('settlement_failure');
    const dependencies: RealModelAcceptanceDependencies = {
      startLab,
      startWeb,
      httpFetch,
      fetch: () => Promise.reject(new Error('MODEL_MUST_NOT_BE_CALLED_BY_FAKE_WEB')),
      now: () => NOW,
      readSnapshot: () => Promise.resolve({
        parent: fixture.parent,
        children: fixture.children,
        evidence: fixture.evidence.map((item) => item.source === 'metric'
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
          } }
          : item),
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
