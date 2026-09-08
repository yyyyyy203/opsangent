import { describe, expect, it } from 'vitest';
import { startInspectionHttpServer } from '../src/api/http-server.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

describe('inspection HTTP/SSE bootstrap', () => {
  it('starts a run over HTTP and streams its V2 events with AsyncGenerator semantics', async () => {
    const runtime = createAgentRuntime({ model: new ScriptedModel([{ text: '完成', toolCalls: [] }]), workspaceRoots: [] });
    const server = await startInspectionHttpServer({ agent: runtime.agent, events: runtime.eventStreamV2 });
    try {
      expect((await fetch(`${server.url}/health`)).status).toBe(200);
      const started = await fetch(`${server.url}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '巡检结算', profileId: 'group-buy-market' }),
      });
      expect(started.status).toBe(202);
      const { runId } = await started.json() as { runId: string };
      expect(runId).toBeTruthy();

      const response = await fetch(`${server.url}/runs/${encodeURIComponent(runId)}/events`);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('SSE response has no body');
      let body = '';
      while (!body.includes('event: RUN_FINISHED')) {
        const item = await reader.read();
        if (item.done) break;
        body += new TextDecoder().decode(item.value);
      }
      expect(body).toContain('event: RUN_STARTED');
      expect(body).toContain('event: RUN_FINISHED');
      await reader.cancel();
      expect((await fetch(`${server.url}/runs`, { method: 'POST', body: '{bad' })).status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
