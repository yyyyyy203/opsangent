import { StoredDataCorruptionError, type StoredAgentMessageV2 } from '../../contracts/event-store.js';
import { makePublicMessagePage, messageLimit, parseMessageCursor, preparePublicProjection, type MessagePageOptions, type PublicMessagePage, type WebMessageQueries } from '../../contracts/web-read-model.js';
import { parseAgentMessageV2 } from '../../contracts/message-v2/schema.js';
import { PublicMessageProjectorV2 } from '../../event/projectors/public-message-projector.js';
import type { SqliteDatabase } from './database.js';

interface Row { message_id: string; version: number; message_json: string }
export class SqliteWebMessageQuery implements WebMessageQueries {
  private readonly projector = new PublicMessageProjectorV2();
  public constructor(private readonly database: SqliteDatabase) {}

  public listMessages(runId: string, options: MessagePageOptions = {}): Promise<PublicMessagePage> {
    const limit = messageLimit(options.limit);
    const cursor = parseMessageCursor(options.cursor, runId);
    const rows = this.database.raw.prepare(`
      SELECT message_id, version, message_json FROM agent_messages
      WHERE run_id = ? AND json_extract(message_json, '$.visibility') <> 'audit'
        AND (? IS NULL OR json_extract(message_json, '$.createdAt') < ?
          OR (json_extract(message_json, '$.createdAt') = ? AND message_id < ?))
      ORDER BY json_extract(message_json, '$.createdAt') DESC, message_id DESC
      LIMIT ?
    `).all(runId, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1) as Row[];
    const records = rows.slice(0, limit).flatMap((row): Array<StoredAgentMessageV2 & { truncated: boolean; cursorRunId: string; cursorMessageId: string }> => {
      try {
        const source = parseAgentMessageV2(JSON.parse(row.message_json));
        const prepared = preparePublicProjection(source);
        const message = this.projector.project(prepared.message);
        return message === null ? [] : [{ message, version: row.version, truncated: prepared.truncated,
          cursorRunId: source.runId, cursorMessageId: source.id }];
      } catch { throw new StoredDataCorruptionError('message', row.message_id); }
    });
    return Promise.resolve(makePublicMessagePage(records, limit, rows.length > limit));
  }
}
