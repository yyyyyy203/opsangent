import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, ChatModel, ModelResponse, ModelStreamEvent } from '../src/contracts/index.js';
import { startAgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import { stableSourceChildRunId } from '../src/bootstrap/source-subagent-identity.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { RecordingObservability } from './fixtures/recording-observability.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local Agent web runtime', () => {
  it('waits for durable readiness, rejects unknown Profiles, and reopens the explicit data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-web-'));
    roots.push(root);
    const options = {
      dataDirectory: root,
      workspaceRoots: [root],
      model: new ScriptedModel([{ text: '完成', toolCalls: [] }]),
      port: 0,
      allowedOrigins: ['http://127.0.0.1:5173'],
    } as const;
    const first = await startAgentWebRuntime(options);
    try {
      const profiles = await fetch(`${first.url}/profiles`, { headers: { Origin: 'http://127.0.0.1:5173' } });
      expect(profiles.status).toBe(200);
      expect(JSON.stringify(await profiles.json())).not.toContain('AGENTOPS_MODEL_API_KEY');

      const forbiddenOrigin = await fetch(`${first.url}/health`, { headers: { Origin: 'http://evil.example' } });
      expect(forbiddenOrigin.status).toBe(403);

      const unknownProfile = await fetch(`${first.url}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify({ runId: 'web-run', message: 'inspect', profileId: 'not-enabled' }),
      });
      expect(unknownProfile.status).toBe(400);
      expect(await unknownProfile.json()).toMatchObject({ error: 'PROFILE_NOT_ALLOWED' });

      const started = await fetch(`${first.url}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify({ runId: 'web-run', message: 'inspect', profileId: 'group-buy-market' }),
      });
      expect(started.status).toBe(202);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const detail = await fetch(`${first.url}/runs/web-run`);
        if (detail.status === 200 && (await detail.clone().json() as { status: string }).status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await fetch(`${first.url}/runs/web-run`)).status).toBe(200);
    } finally {
      await first.close();
    }

    const second = await startAgentWebRuntime({ ...options, model: new ScriptedModel([]) });
    try {
      const detail = await fetch(`${second.url}/runs/web-run`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ runId: 'web-run', status: 'completed' });
    } finally {
      await second.close();
    }
  });

  it('requires an explicit absolute data directory and keeps the host loopback-only', async () => {
    await expect(startAgentWebRuntime({ dataDirectory: 'relative-data', workspaceRoots: [], model: new ScriptedModel([]) }))
      .rejects.toThrow('dataDirectory must be an absolute path');
    await expect(startAgentWebRuntime({ dataDirectory: 'C:\\agentops-data', workspaceRoots: [], model: new ScriptedModel([]), host: '0.0.0.0' }))
      .rejects.toThrow('bind to loopback');
  });

  it('exports Web and inherited Metrics child spans through the event-only port and exposes flush', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-web-observability-'));
    roots.push(root);
    const exporter = new RecordingObservability();
    const runId = 'identity-parent-run';
    const childRunId = stableSourceChildRunId('metrics', runId, 'metrics-tool-call');
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'metrics-tool-call', name: 'metrics_subagent', input: {
        profileId: 'simulation', service: 'checkout',
        start: '2026-10-02T12:29:56.000Z', end: '2026-10-02T12:34:56.000Z',
        question: '检查结算指标',
      } }] },
      { text: '子 Agent 不查询来源。', toolCalls: [] },
      { text: '巡检结束。', toolCalls: [] },
    ]);
    const runtime = await startAgentWebRuntime({
      dataDirectory: root,
      workspaceRoots: [root],
      model,
      modelIdentity: { provider: 'test-provider', model: 'parent-child-model' },
      eventObservability: exporter,
      clock: { now: () => new Date('2026-10-02T12:34:56.789Z') },
      metrics: {
        profileId: 'simulation', mcpUrl: 'http://127.0.0.1:1/mcp', childModel: model,
        modelIdentity: { provider: 'incorrect-override', model: 'incorrect-override' },
      },
      port: 0,
    });
    try {
      const started = await fetch(`${runtime.url}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId, message: '检查结算', profileId: 'simulation' }),
      });
      expect(started.status).toBe(202);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const detail = await fetch(`${runtime.url}/runs/${runId}`);
        if (detail.status === 200 && (await detail.clone().json() as { status: string }).status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const parentModelSpan = exporter.starts.find((span) => span.runId === runId && span.name === 'model.parent-child-model');
      const childModelSpan = exporter.starts.find((span) => span.runId === childRunId && span.name === 'model.parent-child-model');
      expect(parentModelSpan?.attributes).toMatchObject({ provider: 'test-provider', model: 'parent-child-model' });
      expect(childModelSpan?.attributes).toMatchObject({ provider: 'test-provider', model: 'parent-child-model' });
      expect('flushEventObservability' in runtime).toBe(true);
      if ('flushEventObservability' in runtime && typeof runtime.flushEventObservability === 'function') {
        await runtime.flushEventObservability();
      }
      expect(exporter.flushes).toBe(1);
    } finally {
      await runtime.close();
    }
    expect(exporter.flushes).toBe(2);
  });

  it('exposes only the simulation Profile and injects one host-generated window without connecting at startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-web-metrics-'));
    roots.push(root);
    const seenMessages: AgentMessage[][] = [];
    const seenTools: string[][] = [];
    const model: ChatModel = {
      async *stream(messages: AgentMessage[], tools, options): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        await Promise.resolve();
        void options;
        seenMessages.push(messages);
        seenTools.push(tools.map((tool) => tool.name));
        yield { type: 'text_delta', delta: '完成' };
        return { text: '完成', toolCalls: [] };
      },
    };
    const runtime = await startAgentWebRuntime({
      dataDirectory: root,
      workspaceRoots: [root],
      model,
      clock: { now: () => new Date('2026-10-02T12:34:56.789Z') },
      metrics: { profileId: 'simulation', mcpUrl: 'http://127.0.0.1:1/mcp' },
      port: 0,
      allowedOrigins: ['http://127.0.0.1:5173'],
    });
    try {
      const profiles = await fetch(`${runtime.url}/profiles`, { headers: { Origin: 'http://127.0.0.1:5173' } });
      expect(profiles.status).toBe(200);
      expect(await profiles.json()).toEqual([expect.objectContaining({ id: 'simulation' })]);

      const started = await fetch(`${runtime.url}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify({ runId: 'simulation-run', message: '检查结算', profileId: 'simulation', trustedSystemContext: 'attacker' }),
      });
      expect(started.status).toBe(202);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const detail = await fetch(`${runtime.url}/runs/simulation-run`);
        if (detail.status === 200 && (await detail.clone().json() as { status: string }).status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await fetch(`${runtime.url}/runs/simulation-run`)).status).toBe(200);
      const system = seenMessages[0]?.find((message) => message.role === 'system');
      const systemText = system?.blocks.find((block) => block.type === 'text');
      expect(systemText).toMatchObject({ type: 'text' });
      if (systemText?.type !== 'text') throw new Error('trusted system context missing');
      expect(systemText.text).toContain('profile=simulation');
      expect(systemText.text).toContain('service=checkout');
      expect(systemText.text).toContain('start=2026-10-02T12:29:56.000Z');
      expect(systemText.text).toContain('end=2026-10-02T12:34:56.000Z');
      expect(systemText.text).toContain('allowed_tools=metrics_subagent');
      expect(systemText.text).not.toContain('attacker');
      expect(seenTools).toEqual([['metrics_subagent']]);
    } finally {
      await runtime.close();
    }
  });

  it('adds the Logs source only in metrics-backed mode and describes its window as source metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-web-logs-'));
    roots.push(root);
    const seenMessages: AgentMessage[][] = [];
    const seenTools: string[][] = [];
    const model: ChatModel = {
      async *stream(messages: AgentMessage[], tools, options): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        await Promise.resolve();
        void options;
        seenMessages.push(messages);
        seenTools.push(tools.map((tool) => tool.name));
        yield { type: 'text_delta', delta: '完成' };
        return { text: '完成', toolCalls: [] };
      },
    };
    const runtime = await startAgentWebRuntime({
      dataDirectory: root,
      workspaceRoots: [root],
      model,
      clock: { now: () => new Date('2026-10-02T12:34:56.789Z') },
      metrics: { profileId: 'simulation', mcpUrl: 'http://127.0.0.1:19210/mcp' },
      logs: {
        profileId: 'simulation', mcpUrl: 'http://127.0.0.1:19211/mcp',
        cursorSecret: '0123456789abcdef0123456789abcdef',
      },
      port: 0,
      allowedOrigins: ['http://127.0.0.1:5173'],
    });
    try {
      const started = await fetch(`${runtime.url}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify({ runId: 'simulation-logs-run', message: '检查结算日志', profileId: 'simulation' }),
      });
      expect(started.status).toBe(202);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const detail = await fetch(`${runtime.url}/runs/simulation-logs-run`);
        if (detail.status === 200 && (await detail.clone().json() as { status: string }).status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await fetch(`${runtime.url}/runs/simulation-logs-run`)).status).toBe(200);
      expect(seenTools).toEqual([['metrics_subagent', 'logs_subagent']]);

      const system = seenMessages[0]?.find((message) => message.role === 'system');
      const systemText = system?.blocks.find((block) => block.type === 'text');
      expect(systemText).toMatchObject({ type: 'text' });
      if (systemText?.type !== 'text') throw new Error('trusted system context missing');
      expect(systemText.text).toContain('allowed_tools=metrics_subagent,logs_subagent');
      expect(systemText.text).toContain('日志来源窗口与快照时间以来源元数据为准，不保证完全一致。');
    } finally {
      await runtime.close();
    }
  });

  it('requires Metrics for Logs and rejects credential URLs or short cursor secrets without echoing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-web-logs-invalid-'));
    roots.push(root);
    const base = { dataDirectory: root, workspaceRoots: [root], model: new ScriptedModel([]) };
    const logs = {
      profileId: 'simulation' as const,
      mcpUrl: 'http://127.0.0.1:19211/mcp',
      cursorSecret: '0123456789abcdef0123456789abcdef',
    };

    const logsOnly = await attemptStartup({ ...base, logs });
    if (logsOnly.status === 'started') await logsOnly.close();
    expect(logsOnly.status).toBe('failed');
    if (logsOnly.status === 'failed') expect(errorMessage(logsOnly.error)).toMatch(/metrics/i);

    const credentialUrl = 'http://user:private-marker@127.0.0.1:19211/mcp';
    const invalidUrl = await attemptStartup({
      ...base,
      metrics: { profileId: 'simulation', mcpUrl: 'http://127.0.0.1:19210/mcp' },
      logs: { ...logs, mcpUrl: credentialUrl },
    });
    if (invalidUrl.status === 'started') await invalidUrl.close();
    expect(invalidUrl.status).toBe('failed');
    if (invalidUrl.status === 'failed') {
      expect(errorMessage(invalidUrl.error)).toMatch(/logs\.mcpUrl/i);
      expect(errorMessage(invalidUrl.error)).not.toContain(credentialUrl);
      expect(errorMessage(invalidUrl.error)).not.toContain('private-marker');
    }

    const shortSecret = 'short-cursor-marker';
    const invalidSecret = await attemptStartup({
      ...base,
      metrics: { profileId: 'simulation', mcpUrl: 'http://127.0.0.1:19210/mcp' },
      logs: { ...logs, cursorSecret: shortSecret },
    });
    if (invalidSecret.status === 'started') await invalidSecret.close();
    expect(invalidSecret.status).toBe('failed');
    if (invalidSecret.status === 'failed') {
      expect(errorMessage(invalidSecret.error)).toMatch(/cursorSecret/i);
      expect(errorMessage(invalidSecret.error)).not.toContain(shortSecret);
    }
  });

  it('rejects invalid or unsupported Metrics configuration before creating an HTTP server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-web-metrics-invalid-'));
    roots.push(root);
    const base = { dataDirectory: root, workspaceRoots: [root], model: new ScriptedModel([]) };
    await expect(startAgentWebRuntime({
      ...base,
      metrics: { profileId: 'simulation', mcpUrl: 'not-a-url' },
    })).rejects.toThrow('metrics.mcpUrl');
    await expect(startAgentWebRuntime({
      ...base,
      metrics: { profileId: 'production' as 'simulation', mcpUrl: 'http://127.0.0.1:19110/mcp' },
    })).rejects.toThrow('Unsupported metrics Profile');
  });
});

async function attemptStartup(options: Parameters<typeof startAgentWebRuntime>[0]): Promise<
  { status: 'started'; close: () => Promise<void> } | { status: 'failed'; error: unknown }
> {
  try {
    const runtime = await startAgentWebRuntime(options);
    return { status: 'started', close: () => runtime.close() };
  } catch (error) {
    return { status: 'failed', error };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
