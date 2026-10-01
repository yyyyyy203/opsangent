import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, ChatModel, ModelResponse, ModelStreamEvent } from '../src/contracts/index.js';
import { startAgentWebRuntime } from '../src/bootstrap/agent-web-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

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

  it('exposes only the simulation Profile and injects one host-generated window without connecting at startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opsangent-web-metrics-'));
    roots.push(root);
    const seenMessages: AgentMessage[][] = [];
    const model: ChatModel = {
      async *stream(messages: AgentMessage[], tools, options): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        await Promise.resolve();
        void tools;
        void options;
        seenMessages.push(messages);
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
    } finally {
      await runtime.close();
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
