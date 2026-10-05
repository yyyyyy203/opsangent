import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { startAgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import { createLangSmithEventObservability } from '../src/bootstrap/langsmith.js';
import { createLangSmithAuditedFetch, isSafeLangSmithExportBody } from '../src/acceptance/real-model-runner.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LangSmith Web runtime integration', () => {
  it('exports a local-only parent/child trace with shared trace identity', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'opsangent-langsmith-runtime-'));
    roots.push(dataDirectory);
    const requests: { url: string; body: string }[] = [];
    const exportFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: await request.text() });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const langSmithConfig = {
      enabled: true,
      apiKey: 'integration-test-key',
      projectName: 'inspection-agent-test',
      endpoint: 'https://smith.invalid',
    } as const;
    let outboundAuditPassed = true;
    const auditedFetch = createLangSmithAuditedFetch(
      exportFetch,
      langSmithConfig,
      ['integration-test-key', '本地检查', '本地完成'],
      () => { outboundAuditPassed = false; },
    );
    const tracing = createLangSmithEventObservability(langSmithConfig, {
      fetch: auditedFetch,
      now: () => Date.parse('2026-10-04T10:00:00.000Z'),
    });
    const runtime = await startAgentWebRuntime({
      dataDirectory,
      workspaceRoots: [dataDirectory],
      model: new ScriptedModel([{ text: '本地完成', toolCalls: [] }]),
      modelIdentity: { provider: 'test-provider', model: 'scripted-model' },
      eventObservability: tracing.eventObservability,
      port: 0,
    });

    try {
      const started = await fetch(`${runtime.url}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'langsmith-runtime-run', message: '本地检查', profileId: 'group-buy-market' }),
      });
      expect(started.status).toBe(202);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const detail = await fetch(`${runtime.url}/runs/langsmith-runtime-run`);
        if (detail.status === 200 && (await detail.clone().json() as { status: string }).status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await (await fetch(`${runtime.url}/runs/langsmith-runtime-run`)).json() as { status: string }).status)
        .toBe('completed');
      await runtime.flushEventObservability();

      const rootLink = tracing.getTraceLinks().find((link) => link.spanKey.startsWith('run:langsmith-runtime-run:'));
      const modelLink = tracing.getTraceLinks().find((link) => link.spanKey.startsWith('model:langsmith-runtime-run:'));
      expect(rootLink).toBeDefined();
      expect(modelLink).toBeDefined();
      expect(modelLink?.traceId).toBe(rootLink?.traceId);
      expect(modelLink?.parentRemoteRunId).toBe(rootLink?.remoteRunId);
      const batchRequests = requests.filter(({ url }) => url.endsWith('/runs/batch'));
      expect(batchRequests.length).toBeGreaterThan(0);
      expect(batchRequests.every(({ body }) => isSafeLangSmithExportBody(body, [
        'integration-test-key', '本地检查', '本地完成',
      ]))).toBe(true);
      expect(batchRequests.every(({ body }) => {
        const batch = JSON.parse(body) as { post?: Array<{ extra?: Record<string, unknown> }>; patch?: Array<{ extra?: Record<string, unknown> }> };
        return [...(batch.post ?? []), ...(batch.patch ?? [])]
          .every((run) => run.extra === undefined || !Object.hasOwn(run.extra, 'runtime'));
      })).toBe(true);
      expect(outboundAuditPassed).toBe(true);
      expect(requests.map(({ body }) => body).join('\n')).not.toContain('本地检查');
      expect(tracing.getDiagnostics().pending).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it('starts and shuts down the Node CLI with tracing enabled without model or eager trace requests', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'opsangent-langsmith-cli-'));
    roots.push(dataDirectory);
    const requestPaths: string[] = [];
    const fakeLangSmith = createServer((request, response) => {
      requestPaths.push(request.url ?? '/');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise<void>((resolve, reject) => {
      fakeLangSmith.once('error', reject);
      fakeLangSmith.listen(0, '127.0.0.1', resolve);
    });
    const address = fakeLangSmith.address();
    if (address === null || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE');
    const proxy = `http://127.0.0.1:${address.port}`;
    const serverPath = fileURLToPath(new URL('../apps/agent-server/index.mjs', import.meta.url));
    const preloadPath = fileURLToPath(new URL('./fixtures/langsmith-fetch-proxy.mjs', import.meta.url));
    const child = spawn(process.execPath, ['--import', pathToFileURL(preloadPath).href, serverPath], {
      env: {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.env.SYSTEMROOT === undefined ? {} : { SYSTEMROOT: process.env.SYSTEMROOT }),
        ...(process.env.TEMP === undefined ? {} : { TEMP: process.env.TEMP }),
        ...(process.env.TMP === undefined ? {} : { TMP: process.env.TMP }),
        AGENTOPS_DATA_DIR: dataDirectory,
        AGENTOPS_WORKSPACE_ROOTS: dataDirectory,
        AGENTOPS_WEB_PROFILE: 'simulation',
        AGENTOPS_METRICS_MCP_URL: 'http://127.0.0.1:1/mcp',
        AGENTOPS_MODEL_BASE_URL: 'https://model.invalid/v1',
        AGENTOPS_MODEL_API_KEY: 'model-test-key',
        AGENTOPS_MODEL: 'scripted-model',
        AGENTOPS_MODEL_PROVIDER: 'test-provider',
        AGENTOPS_HOST: '127.0.0.1',
        AGENTOPS_PORT: '0',
        LANGSMITH_TRACING: 'true',
        LANGSMITH_API_KEY: 'langsmith-test-key',
        LANGSMITH_PROJECT: 'cli-smoke-test',
        LANGSMITH_ENDPOINT: 'https://api.smith.langchain.com',
        AGENTOPS_LANGSMITH_TEST_PROXY: proxy,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.stdout === null || child.stderr === null) throw new Error('CLI_TEST_PIPES_UNAVAILABLE');
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const readyLine = new Promise<string>((resolve, reject) => {
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        resolve(buffer.slice(0, newline));
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`CLI_EXITED_BEFORE_READY:${code ?? 'signal'}:${stderr}`)));
    });
    try {
      const line = await withTimeout(readyLine, 15_000, 'CLI_START_TIMEOUT');
      const ready = JSON.parse(line) as { status: string; url: string };
      expect(ready).toMatchObject({ status: 'ready' });
      const health = await fetch(`${ready.url}/health`);
      expect(health.status).toBe(200);
      child.kill('SIGTERM');
      const exit = await withTimeout(exitPromise, 15_000, 'CLI_SHUTDOWN_TIMEOUT');
      expect(exit.code === 0 || exit.signal === 'SIGTERM'
        || (process.platform === 'win32' && exit.code === null)).toBe(true);
      expect(requestPaths).toHaveLength(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await withTimeout(exitPromise, 15_000, 'CLI_CLEANUP_TIMEOUT');
      await new Promise<void>((resolve) => fakeLangSmith.close(() => resolve()));
    }
  }, 35_000);

  it('fails closed when the LangSmith test proxy is given an unrelated origin', () => {
    const preloadPath = fileURLToPath(new URL('./fixtures/langsmith-fetch-proxy.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(preloadPath).href,
      '--input-type=module',
      '-e', "try { await fetch('http://127.0.0.1:9/unapproved'); process.exitCode = 2; } catch (error) { process.stdout.write(error instanceof Error ? error.message : 'UNKNOWN'); }",
    ], {
      env: {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.env.SYSTEMROOT === undefined ? {} : { SYSTEMROOT: process.env.SYSTEMROOT }),
        AGENTOPS_LANGSMITH_TEST_PROXY: 'http://127.0.0.1:12345',
      },
      encoding: 'utf8',
      timeout: 5_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('TEST_PROXY_ORIGIN_REJECTED');
  });
});

async function withTimeout<T>(promise: Promise<T>, durationMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), durationMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
