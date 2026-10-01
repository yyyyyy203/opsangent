import { randomBytes } from 'node:crypto';
import type { MessageCursor, MessageCursorCodec } from '../contracts/web-read-model.js';

interface CursorEntry {
  cursor: MessageCursor;
  expiresAt: number;
}

/** Issues bounded, process-local opaque cursors instead of exposing storage IDs. */
export class OpaqueMessageCursorCodec implements MessageCursorCodec {
  private readonly entries = new Map<string, CursorEntry>();

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 15 * 60 * 1_000,
    private readonly maxEntries = 4_096,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be a positive safe integer');
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new RangeError('maxEntries must be a positive safe integer');
  }

  public encode(cursor: MessageCursor): string {
    this.prune();
    let token = randomBytes(24).toString('base64url');
    while (this.entries.has(token)) token = randomBytes(24).toString('base64url');
    this.entries.set(token, { cursor: { ...cursor }, expiresAt: this.now() + this.ttlMs });
    this.trimToLimit();
    return token;
  }

  public decode(token: string, runId: string): MessageCursor {
    this.prune();
    const entry = this.entries.get(token);
    if (entry === undefined || entry.cursor.runId !== runId) throw new RangeError('cursor is invalid.');
    return { ...entry.cursor };
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(token);
  }

  private trimToLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== 'string') return;
      this.entries.delete(oldest);
    }
  }
}
