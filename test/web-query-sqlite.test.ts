import { describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteEventMessageStore } from '../src/infrastructure/sqlite/index.js';
import { SqliteWebMessageQuery } from '../src/infrastructure/sqlite/web-message-query.js';

describe('SQLite web message query', () => {
  it('uses bounded SQL keyset pages without invoking a full MessageStore scan', async () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      const store = new SqliteEventMessageStore(database);
      for (const id of ['a', 'b', 'c', 'd']) await store.saveMessage({ schemaVersion: 2, id, runId: 'run-1', role: 'assistant', status: 'completed', visibility: 'user', blocks: [], createdAt: '2026-10-01T00:00:00.000Z' }, null);
      const statements: string[] = [];
      const query = new SqliteWebMessageQuery({ raw: { prepare: (sql: string) => {
        if (!/\bLIMIT\b/i.test(sql)) throw new Error('unbounded SQL query forbidden');
        statements.push(sql);
        return database.raw.prepare(sql);
      } } } as unknown as SqliteDatabase);
      const first = await query.listMessages('run-1', { limit: 2 });
      if (!first.nextCursor) throw new Error('first page lacked a cursor');
      const second = await query.listMessages('run-1', { cursor: first.nextCursor, limit: 2 });
      expect([...first.items, ...second.items].map((item) => item.message.id)).toEqual(['d', 'c', 'b', 'a']);
      expect(statements.some((sql) => /\bLIMIT\b/i.test(sql))).toBe(true);
    } finally { database.close(); }
  });

  it('sanitizes address-like message and block IDs while preserving SQLite cursor pagination', async () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      const store = new SqliteEventMessageStore(database);
      const createdAt = '2026-10-01T00:00:00.000Z';
      await store.saveMessage({ schemaVersion: 2, id: 'z-http://10.1.2.3:9090', runId: 'run-1', role: 'assistant',
        status: 'completed', visibility: 'user', blocks: [{ type: 'text', blockId: 'block-http://10.1.2.3:9090', text: 'safe' }], createdAt }, null);
      await store.saveMessage({ schemaVersion: 2, id: 'a-safe', runId: 'run-1', role: 'assistant',
        status: 'completed', visibility: 'user', blocks: [], createdAt }, null);
      const query = new SqliteWebMessageQuery(database);
      const first = await query.listMessages('run-1', { limit: 1 });
      expect(first.items[0]?.message.id).not.toContain('10.1.2.3');
      expect(first.items[0]?.message.blocks[0]?.blockId).not.toContain('10.1.2.3');
      expect(JSON.stringify(first)).not.toContain('10.1.2.3');
      if (!first.nextCursor) throw new Error('first page lacked a cursor');
      const second = await query.listMessages('run-1', { cursor: first.nextCursor, limit: 1 });
      expect(second.items.map((item) => item.message.id)).toEqual(['a-safe']);
    } finally { database.close(); }
  });
});
