import type { AgentMessageV2 } from './message-v2/index.js';
import type { StoredAgentMessageV2 } from './event-store.js';

export interface MessagePageOptions { cursor?: string; limit?: number }
export interface PublicMessageItem { message: AgentMessageV2; version: number; truncated: boolean }
export interface PublicMessagePage { items: readonly PublicMessageItem[]; nextCursor?: string }
export interface WebMessageQueries { listMessages(runId: string, options?: MessagePageOptions): Promise<PublicMessagePage> }
export interface PublicConfirmation { runId: string; toolCallId: string; expectedRevision: number; summary: string; expiresAt?: string }
export interface PublicProfile { id: string; name: string; description: string; capabilities: { readOnly: boolean } }

export interface MessageCursor { runId: string; createdAt: string; id: string }
export interface MessageCursorCodec {
  encode(cursor: MessageCursor): string;
  decode(token: string, runId: string): MessageCursor;
}
export function messageLimit(limit: number | undefined): number {
  const value = limit ?? 20;
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new RangeError('limit must be between 1 and 50.');
  return value;
}
export function parseMessageCursor(cursor: string | undefined, runId: string, codec: MessageCursorCodec): MessageCursor | undefined {
  if (cursor === undefined) return undefined;
  try { return codec.decode(cursor, runId); }
  catch { throw new RangeError('cursor is invalid.'); }
}
export function encodeMessageCursor(message: AgentMessageV2, codec: MessageCursorCodec, identity?: { runId: string; id: string }): string {
  return codec.encode({ runId: identity?.runId ?? message.runId, createdAt: message.createdAt, id: identity?.id ?? message.id });
}
export function compareMessages(left: StoredAgentMessageV2, right: StoredAgentMessageV2): number {
  return compareUtf8(right.message.createdAt, left.message.createdAt) || compareUtf8(right.message.id, left.message.id);
}
export function afterMessageCursor(record: StoredAgentMessageV2, cursor: MessageCursor): boolean {
  const createdAtOrder = compareUtf8(record.message.createdAt, cursor.createdAt);
  return createdAtOrder < 0 || (createdAtOrder === 0 && compareUtf8(record.message.id, cursor.id) < 0);
}
function compareUtf8(left: string, right: string): number { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }

/** Bounds untrusted block strings before the public sanitizer runs. */
export function preparePublicProjection(message: AgentMessageV2): { message: AgentMessageV2; truncated: boolean } {
  let truncated = false;
  const blocks = message.blocks.map((block) => JSON.parse(JSON.stringify(block, (_key, value: unknown) => {
    if (typeof value === 'string' && value.length > 2_000) {
      truncated = true;
      return `${value.slice(0, 2_000)}[TRUNCATED]`;
    }
    return value;
  })) as AgentMessageV2['blocks'][number]);
  return { message: { ...message, blocks }, truncated };
}

const MESSAGE_BYTES = 64 * 1024;
const PAGE_BYTES = 512 * 1024;
/** Receives already projected messages; never mutates persisted originals. */
export function boundPublicMessage(message: AgentMessageV2): { message: AgentMessageV2; truncated: boolean } {
  const clone = structuredClone(message);
  if (Buffer.byteLength(JSON.stringify(clone), 'utf8') <= MESSAGE_BYTES) return { message: clone, truncated: false };
  const truncated = true;
  for (const block of clone.blocks) {
    if (block.type === 'text') block.text = shorten(block.text, 512);
    else if (block.type === 'reasoning_summary') block.summary = shorten(block.summary, 512);
    else if (block.type === 'evidence_ref') block.summary = shorten(block.summary, 512);
    else if (block.type === 'confirmation_request') block.riskSummary = shorten(block.riskSummary, 512);
  }
  // Preserve safety notices and message identity if a pathological block list is still oversized.
  if (Buffer.byteLength(JSON.stringify(clone), 'utf8') > MESSAGE_BYTES) {
    const safetyNotices: AgentMessageV2['blocks'] = [];
    let errorCount = 0;
    const marker: AgentMessageV2['blocks'][number] = { type: 'text', blockId: 'public-truncation', text: '[TRUNCATED]' };
    for (const block of clone.blocks) {
      if (block.type === 'error') {
        if (errorCount >= 8) continue;
        errorCount++;
      } else if (block.type === 'confirmation_request') {
        block.toolCallIds = block.toolCallIds.slice(0, 8);
        block.riskSummary = shorten(block.riskSummary, 256);
      } else continue;
      const candidate = { ...clone, blocks: [...safetyNotices, block, marker] };
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= MESSAGE_BYTES) safetyNotices.push(block);
    }
    clone.blocks = [...safetyNotices, marker];
  }
  return { message: clone, truncated };
}
function shorten(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max)}[TRUNCATED]`; }

export function makePublicMessagePage(records: readonly (StoredAgentMessageV2 & { truncated?: boolean; cursorRunId?: string; cursorMessageId?: string })[], limit: number, hasMore: boolean, codec: MessageCursorCodec): PublicMessagePage {
  const items: PublicMessageItem[] = [];
  for (const record of records.slice(0, limit)) {
    const bounded = boundPublicMessage(record.message);
    const item = { ...bounded, version: record.version, truncated: bounded.truncated || record.truncated === true };
    const candidate = { items: [...items, item], nextCursor: 'x'.repeat(1024) };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PAGE_BYTES) break;
    items.push(item);
  }
  const more = hasMore || items.length < Math.min(records.length, limit);
  return more && items.length > 0
    ? { items, nextCursor: encodeMessageCursor(items[items.length - 1]!.message, codec, {
      runId: records[items.length - 1]!.cursorRunId ?? items[items.length - 1]!.message.runId,
      id: records[items.length - 1]!.cursorMessageId ?? items[items.length - 1]!.message.id,
    }) }
    : { items };
}
