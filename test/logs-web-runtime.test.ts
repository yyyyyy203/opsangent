import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, ChatModel, ModelResponse, ModelStreamEvent, Tool } from '../src/contracts/index.js';
import { startAgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const roots: string[] = [];
const cursorSecret = 'web-logs-cursor-secret-0123456789';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Web Logs configuration', () => {
  it('requires Metrics mode before enabling Logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-logs-no-metrics-'));
    roots.push(root);
    const error = await captureStartupError({
      dataDirectory: root,
      workspaceRoots: [],
      model: new ScriptedModel([]),
      logs: { profileId: 'simulation', mcpUrl: 'http://127.0.0.1:19211/mcp', cursorSecret },
    });
    expect(error.message).toMatch(/metrics/i);
  });

  it('rejects an unsupported Logs Profile before starting the Web host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-logs-profile-'));
    roots.push(root);
    const error = await captureStartupError({
      dataDirectory: root,
      workspaceRoots: [],
      model: new ScriptedModel([]),
      metrics: { profileId: 'simulation', mcpUrl: 'http://127.0.0.1:1/metrics-mcp' },
      logs: { profileId: 'production' as 'simulation', mcpUrl: 'http://127.0.0.1:19211/mcp', cursorSecret },
    });
    expect(error.message).toMatch(/unsupported Logs Profile/i);
  });

  it.each([
    ['remote endpoint', 'https://logs.example.test/mcp', cursorSecret],
    ['embedded credentials', 'http://user:password@127.0.0.1:19211/mcp', cursorSecret],
    ['short cursor secret', 'http://127.0.0.1:19211/mcp', 'not-a-stable-secret'],
  ])('rejects %s without reflecting configuration values', async (_label, mcpUrl, secret) => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-logs-invalid-'));
    roots.push(root);
    const metricsUrl = 'http://127.0.0.1:1/metrics-mcp';
    const error = await captureStartupError({
      dataDirectory: root,
      workspaceRoots: [],
      model: new ScriptedModel([]),
      metrics: { profileId: 'simulation', mcpUrl: metricsUrl },
      logs: { profileId: 'simulation', mcpUrl, cursorSecret: secret },
    });
    expect(error.message).not.toContain(mcpUrl);
    expect(error.message).not.toContain(secret);
  });

  it('keeps Metrics-only parent tools unchanged and exposes Logs only in configured mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-logs-enabled-'));
    roots.push(root);
    const now = new Date('2026-10-04T12:00:00.000Z');
    const start = new Date(now.getTime() - 300_000).toISOString();
    const end = now.toISOString();
    const seenToolNames: string[][] = [];
    const seenMessages: string[] = [];
    let callIndex = 0;
    const model: ChatModel = {
      async *stream(messages: AgentMessage[], tools: Tool[], options): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        if (options.signal.aborted) throw new Error('unexpected model abort');
        seenToolNames.push(tools.map((tool) => tool.name));
        seenMessages.push(JSON.stringify(messages));
        const current = callIndex;
        callIndex += 1;
        if (current === 0) {
          const call = {
            id: 'logs-call-1',
            name: 'logs_subagent',
            input: {
              profileId: 'simulation', service: 'checkout', start, end,
              question: '请调查结算日志',
            },
          };
          yield { type: 'tool_call', call };
          return { text: '', toolCalls: [call] };
        }
        await Promise.resolve();
        yield { type: 'text_delta', delta: '完成' };
        return { text: '完成', toolCalls: [] };
      },
    };
    const runtime = await startAgentWebRuntime({
      dataDirectory: root,
      workspaceRoots: [root],
      model,
      clock: { now: () => now },
      metrics: { profileId: 'simulation', mcpUrl: 'http://127.0.0.1:1/metrics-mcp' },
      logs: { profileId: 'simulation', mcpUrl: 'http://127.0.0.1:1/logs-mcp', cursorSecret },
      port: 0,
      allowedOrigins: ['http://127.0.0.1:5173'],
    });
    try {
      const started = await fetch(`${runtime.url}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify({ runId: 'logs-web-run', message: '检查结算日志', profileId: 'simulation' }),
      });
      expect(started.status).toBe(202);
      await waitForCompletedRun(runtime.url, 'logs-web-run');
      expect(seenToolNames).toEqual([
        ['metrics_subagent', 'logs_subagent'],
        ['logs.capture', 'logs.search_evidence', 'logs.aggregate_evidence', 'logs.read_evidence_slice', 'source_report'],
        ['metrics_subagent', 'logs_subagent'],
      ]);
      expect(seenMessages.join('\n')).toContain('knownEvidenceIds=[]');
      expect(seenMessages.join('\n')).not.toContain(cursorSecret);
    } finally {
      await runtime.close();
    }
  });
});

async function waitForCompletedRun(baseUrl: string, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/runs/${runId}`);
    if (response.status === 200) {
      const detail = await response.json() as { status?: string };
      if (detail.status === 'completed') return;
      if (detail.status === 'failed') throw new Error('Logs Web Run failed.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Logs Web Run did not finish within the test deadline.');
}

async function captureStartupError(options: Parameters<typeof startAgentWebRuntime>[0]): Promise<Error> {
  const outcome = await startAgentWebRuntime(options).then(async (runtime) => {
    await runtime.close();
    return undefined;
  }, (error: unknown) => error);
  if (!(outcome instanceof Error)) throw new Error('runtime unexpectedly accepted invalid Logs configuration');
  return outcome;
}
