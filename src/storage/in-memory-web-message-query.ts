import type { StoredAgentMessageV2 } from '../contracts/event-store.js';
import { afterMessageCursor, compareMessages, makePublicMessagePage, messageLimit, parseMessageCursor, preparePublicProjection, type MessagePageOptions, type PublicMessagePage, type WebMessageQueries } from '../contracts/web-read-model.js';
import { PublicMessageProjectorV2 } from '../event/projectors/public-message-projector.js';

export class InMemoryWebMessageQuery implements WebMessageQueries {
  private readonly byRun = new Map<string, Map<string, StoredAgentMessageV2>>();
  private readonly projector = new PublicMessageProjectorV2();

  public upsert(record: StoredAgentMessageV2): void {
    const run = this.byRun.get(record.message.runId) ?? new Map<string, StoredAgentMessageV2>();
    const current = run.get(record.message.id);
    if (current === undefined || current.version < record.version) run.set(record.message.id, structuredClone(record));
    this.byRun.set(record.message.runId, run);
  }

  public listMessages(runId: string, options: MessagePageOptions = {}): Promise<PublicMessagePage> {
    const limit = messageLimit(options.limit);
    const cursor = parseMessageCursor(options.cursor, runId);
    const rows = [...(this.byRun.get(runId)?.values() ?? [])]
      .filter((row) => row.message.visibility !== 'audit' && (cursor === undefined || afterMessageCursor(row, cursor)))
      .sort(compareMessages).slice(0, limit + 1);
    const projected = rows.slice(0, limit).flatMap((row) => {
      const prepared = preparePublicProjection(row.message);
      const message = this.projector.project(prepared.message);
      return message === null ? [] : [{ message, version: row.version, truncated: prepared.truncated }];
    });
    return Promise.resolve(makePublicMessagePage(projected, limit, rows.length > limit));
  }
}
