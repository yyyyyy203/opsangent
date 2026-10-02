import { describe, expect, it } from 'vitest';
import { startInspectionHttpServer } from '../src/api/http-server.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

describe('inspection HTTP/SSE bootstrap', () => {
  it('closes an active SSE stream when the server shuts down', async () => {
    const runtime = createAgentRuntime({ model: new ScriptedModel([{ text: '完成', toolCalls: [] }]), workspaceRoots: [] });
    if (runtime.queries === undefined) throw new Error('runtime query service is not configured');
    const server = await startInspectionHttpServer({ agent: runtime.agent, events: runtime.eventStreamV2, queries: runtime.queries });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let closing: Promise<void> | undefined;
    try {
      const started = await fetch(`${server.url}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '巡检结算', profileId: 'group-buy-market' }),
      });
      expect(started.status).toBe(202);
      const { runId } = await started.json() as { runId: string };
      const stream = await fetch(`${server.url}/runs/${encodeURIComponent(runId)}/events?snapshots=none`);
      expect(stream.status).toBe(200);
      reader = stream.body?.getReader();
      if (reader === undefined) throw new Error('SSE response has no body');

      closing = server.close();
      const closed = await Promise.race([
        closing.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(closed).toBe(true);
    } finally {
      await reader?.cancel();
      await (closing ?? server.close());
    }
  });

  it('starts a run over HTTP and streams its V2 events with AsyncGenerator semantics', async () => {
    const runtime = createAgentRuntime({ model: new ScriptedModel([{ text: '完成', toolCalls: [] }]), workspaceRoots: [] });
    if (runtime.queries === undefined) throw new Error('runtime query service is not configured');
    const server = await startInspectionHttpServer({ agent: runtime.agent, events: runtime.eventStreamV2, queries: runtime.queries });
    try {
      expect((await fetch(`${server.url}/health`)).status).toBe(200);
      const started = await fetch(`${server.url}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '巡检结算', profileId: 'group-buy-market', trustedSystemContext: 'attacker-controlled' }),
      });
      expect(started.status).toBe(202);
      const { runId } = await started.json() as { runId: string };
      expect(runId).toBeTruthy();
      const checkpoint = await runtime.checkpoints.load(runId);
      expect(checkpoint?.messages[0]?.role).toBe('user');

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
      const firstEventId = /^id: (.+)$/mu.exec(body)?.[1];
      expect(firstEventId).toBeTruthy();
      await reader.cancel();
      await runtime.evidence.save({
        evidenceId: 'http-evidence-1', runId, source: 'metric',
        summary: { status: 'breached', privateToken: 'do-not-return' },
        raw: { privateMarker: 'http-raw-marker' }, businessTraceIds: [], capturedAt: '2026-09-30T10:00:00.000Z',
      });

      const runs = await fetch(`${server.url}/runs?limit=10`);
      expect(runs.status).toBe(200);
      expect(await runs.json()).toMatchObject({ items: [{ runId, profileId: 'group-buy-market', status: 'completed' }] });
      const detail = await fetch(`${server.url}/runs/${encodeURIComponent(runId)}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ runId, evidenceIds: [], missingEvidence: [] });
      const evidence = await fetch(`${server.url}/runs/${encodeURIComponent(runId)}/evidence`);
      expect(evidence.status).toBe(200);
      expect(await evidence.json()).toMatchObject({ items: [{ evidenceId: 'http-evidence-1', summary: { status: 'breached' } }] });
      const evidenceDetail = await fetch(`${server.url}/runs/${encodeURIComponent(runId)}/evidence/http-evidence-1`);
      expect(evidenceDetail.status).toBe(200);
      expect(JSON.stringify(await evidenceDetail.json())).not.toContain('http-raw-marker');
      expect((await fetch(`${server.url}/runs/unknown-run`)).status).toBe(404);
      expect((await fetch(`${server.url}/runs/${encodeURIComponent(runId)}/events?lastEventId=missing-event`)).status).toBe(400);
      const otherStarted = await fetch(`${server.url}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '另一轮巡检', profileId: 'group-buy-market', runId: 'other-run' }),
      });
      expect(otherStarted.status).toBe(202);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await fetch(`${server.url}/runs/other-run`)).status === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await fetch(`${server.url}/runs/other-run/events?lastEventId=${encodeURIComponent(firstEventId!)}`)).status).toBe(400);
      const idle = await fetch(`${server.url}/runs/${encodeURIComponent(runId)}/events?snapshots=none`);
      expect(idle.status).toBe(200);
      expect(idle.headers.get('content-type')).toContain('text/event-stream');
      await idle.body?.cancel();
      const unknownEvents = await fetch(`${server.url}/runs/unknown-run/events`);
      expect(unknownEvents.status).toBe(404);
      expect(unknownEvents.headers.get('content-type')).toContain('application/json');
      expect((await fetch(`${server.url}/runs/${encodeURIComponent(runId)}/events?snapshots=bogus`)).status).toBe(400);
      expect((await fetch(`${server.url}/runs`, { method: 'POST', body: '{bad' })).status).toBe(400);
    } finally {
      await server.close();
    }
  }, 15_000);
});
