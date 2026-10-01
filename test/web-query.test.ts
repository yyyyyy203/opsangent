import { describe, expect, it } from 'vitest';
import { InMemoryWebMessageQuery } from '../src/storage/in-memory-web-message-query.js';
import { WebQueryService } from '../src/application/web-query-service.js';
import type { AgentMessageV2 } from '../src/contracts/index.js';
import { makePublicMessagePage } from '../src/contracts/web-read-model.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { startInspectionHttpServer } from '../src/api/http-server.js';

const timestamp = '2026-10-01T00:00:00.000Z';
function message(id: string, runId = 'run-1', text = id, visibility: AgentMessageV2['visibility'] = 'user'): AgentMessageV2 {
  return { schemaVersion: 2, id, runId, role: 'assistant', status: 'completed', visibility,
    createdAt: timestamp, blocks: [{ type: 'text', blockId: `block-${id}`, text }] };
}

describe('web message read model', () => {
  it('paginates equal timestamps without duplicate or omitted messages', async () => {
    const query = new InMemoryWebMessageQuery();
    for (const id of ['a', 'b', 'c', 'd', 'e']) query.upsert({ message: message(id), version: 1 });
    const first = await query.listMessages('run-1', { limit: 2 });
    if (!first.nextCursor) throw new Error('first page lacked a cursor');
    const second = await query.listMessages('run-1', { cursor: first.nextCursor, limit: 2 });
    if (!second.nextCursor) throw new Error('second page lacked a cursor');
    const third = await query.listMessages('run-1', { cursor: second.nextCursor, limit: 2 });
    const firstIds = new Set(first.items.map((x) => x.message.id));
    expect(second.items.map((x) => x.message.id).some((id) => firstIds.has(id))).toBe(false);
    expect([...first.items, ...second.items, ...third.items].map((x) => x.message.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(third.nextCursor).toBeUndefined();
  });

  it('excludes audit and cross-Run messages, and keeps the latest version', async () => {
    const query = new InMemoryWebMessageQuery();
    query.upsert({ message: message('audit', 'run-1', 'private', 'audit'), version: 1 });
    query.upsert({ message: message('other', 'run-2'), version: 1 });
    query.upsert({ message: message('versioned', 'run-1', 'new'), version: 2 });
    query.upsert({ message: message('versioned', 'run-1', 'old'), version: 1 });
    const page = await query.listMessages('run-1');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ version: 2, message: { id: 'versioned', blocks: [{ text: 'new' }] } });
  });

  it('redacts secrets and internal addresses, bounds message and page bytes with explicit truncation', async () => {
    const query = new InMemoryWebMessageQuery();
    for (let n = 0; n < 10; n++) query.upsert({ message: message(`big-${n}`, 'run-1', 'x'.repeat(90_000)), version: 1 });
    query.upsert({ message: message('secret', 'run-1', 'fixture-secret http://10.1.2.3:9090'), version: 1 });
    const page = await query.listMessages('run-1', { limit: 50 });
    expect(JSON.stringify(page)).not.toContain('fixture-secret');
    expect(JSON.stringify(page)).not.toContain('10.1.2.3');
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(page.items.some((item) => item.truncated)).toBe(true);
    for (const item of page.items) expect(Buffer.byteLength(JSON.stringify(item.message), 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('stops a page at 512 KiB and resumes at the next message', () => {
    const records = Array.from({ length: 40 }, (_, n) => {
      const draft = message(`page-${String(n).padStart(2, '0')}`);
      draft.blocks = Array.from({ length: 20 }, (_, index) => ({ type: 'text' as const, blockId: `part-${index}`, text: 'x'.repeat(2_000) }));
      return { message: draft, version: 1 };
    });
    const first = makePublicMessagePage(records, 50, false);
    expect(first.items.length).toBeLessThan(40);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(512 * 1024);
    if (!first.nextCursor) throw new Error('bounded page lacked a cursor');
    const second = makePublicMessagePage(records.slice(first.items.length), 50, false);
    expect(second.items[0]?.message.id).not.toBe(first.items.at(-1)?.message.id);
    expect(Buffer.byteLength(JSON.stringify(second), 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(first.items.length + second.items.length).toBeLessThanOrEqual(40);
  });

  it('projects an unexpired confirmation and distinguishes no confirmation from missing Run', async () => {
    const contexts = new Map<string, { revision: number; context: { status: 'awaiting_confirmation' | 'completed'; pendingInterrupt?: { hookId: string; interruptType: string; toolCallId: string; payload: Record<string, unknown>; createdAt: string; expiresAt?: string } } }>([
      ['pending', { revision: 7, context: { status: 'awaiting_confirmation', pendingInterrupt: { hookId: 'risk', interruptType: 'confirmation', toolCallId: 'call-1', payload: { summary: 'Review fixture-secret at 10.1.2.3' }, createdAt: timestamp, expiresAt: '2026-10-02T00:00:00.000Z' } } }],
      ['idle', { revision: 2, context: { status: 'completed' } }],
    ]);
    const service = new WebQueryService({ load: (runId) => Promise.resolve(contexts.get(runId) ?? null) }, [], () => new Date(timestamp));
    expect(await service.getConfirmation('pending')).toEqual({ runId: 'pending', toolCallId: 'call-1', expectedRevision: 7, summary: '[REDACTED]', expiresAt: '2026-10-02T00:00:00.000Z' });
    expect(await service.getConfirmation('idle')).toBeNull();
    await expect(service.getConfirmation('missing')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    const expired = new WebQueryService({ load: (runId) => Promise.resolve(contexts.get(runId) ?? null) }, [], () => new Date('2026-10-03T00:00:00.000Z'));
    expect(await expired.getConfirmation('pending')).toBeNull();
  });

  it('serves safe profiles, messages, and confirmation with stable HTTP errors', async () => {
    const runtime = createAgentRuntime({ model: new ScriptedModel([]), workspaceRoots: [] });
    const messages = new InMemoryWebMessageQuery();
    messages.upsert({ message: message('one', 'known', 'fixture-secret 10.1.2.3'), version: 1 });
    const web = new WebQueryService({ load: (runId) => Promise.resolve(runId === 'known' ? { revision: 3, context: { status: 'completed' as const } } : null) },
      [{ id: 'safe', name: 'Safe', description: 'Read only', enabled: true, capabilities: { readOnly: true } },
        { id: 'hidden', name: 'Hidden', description: 'Secret', enabled: false, capabilities: { readOnly: false } }], () => new Date(timestamp));
    const queries = { getRun: (runId: string) => Promise.resolve(runId === 'known' ? { runId } : null) };
    const server = await startInspectionHttpServer({ agent: runtime.agent, events: runtime.eventStreamV2,
      queries: queries as never, webQueries: web, messageQueries: messages });
    try {
      const profiles = await fetch(`${server.url}/profiles`);
      expect(profiles.status).toBe(200);
      expect(await profiles.json()).toEqual([{ id: 'safe', name: 'Safe', description: 'Read only', capabilities: { readOnly: true } }]);
      const page = await fetch(`${server.url}/runs/known/messages?limit=1`);
      expect(page.status).toBe(200);
      expect(JSON.stringify(await page.json())).not.toContain('fixture-secret');
      expect((await fetch(`${server.url}/runs/known/confirmation`)).status).toBe(200);
      expect(await (await fetch(`${server.url}/runs/known/confirmation`)).json()).toBeNull();
      expect((await fetch(`${server.url}/runs/missing/messages`)).status).toBe(404);
      expect((await fetch(`${server.url}/runs/missing/confirmation`)).status).toBe(404);
      expect((await fetch(`${server.url}/runs/known/messages?limit=51`)).status).toBe(400);
      expect((await fetch(`${server.url}/runs/known/messages?cursor=invalid`)).status).toBe(400);
    } finally { await server.close(); }
  });

  it('returns 503 when web query services are not assembled', async () => {
    const runtime = createAgentRuntime({ model: new ScriptedModel([]), workspaceRoots: [] });
    const server = await startInspectionHttpServer({ agent: runtime.agent, events: runtime.eventStreamV2 });
    try {
      for (const path of ['/profiles', '/runs/x/messages', '/runs/x/confirmation']) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: 'QUERY_UNAVAILABLE' });
      }
    } finally { await server.close(); }
  });
});
