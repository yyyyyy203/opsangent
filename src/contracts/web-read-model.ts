import type { AgentMessageV2 } from './message-v2/index.js';
import type { StoredAgentMessageV2 } from './event-store.js';

export interface MessagePageOptions { cursor?: string; limit?: number }
export interface PublicMessageItem { message: AgentMessageV2; version: number; truncated: boolean }
export interface PublicMessagePage { items: readonly PublicMessageItem[]; nextCursor?: string }
export interface WebMessageQueries { listMessages(runId: string, options?: MessagePageOptions): Promise<PublicMessagePage> }
export interface PublicConfirmation { runId: string; toolCallId: string; expectedRevision: number; summary: string; expiresAt?: string }
export interface PublicProfile { id: string; name: string; description: string; capabilities: { readOnly: boolean } }

export interface MessageCursor { runId: string; createdAt: string; id: string }
export function messageLimit(limit: number | undefined): number {
  const value = limit ?? 20;
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new RangeError('limit must be between 1 and 50.');
  return value;
}
export function parseMessageCursor(cursor: string | undefined, runId: string): MessageCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('runId' in parsed) || !('createdAt' in parsed) || !('id' in parsed)
      || parsed.runId !== runId || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string'
      || parsed.createdAt.length === 0 || parsed.id.length === 0) throw new Error('invalid');
    return { runId, createdAt: parsed.createdAt, id: parsed.id };
  } catch { throw new RangeError('cursor is invalid.'); }
}
export function encodeMessageCursor(message: AgentMessageV2): string {
  return Buffer.from(JSON.stringify({ runId: message.runId, createdAt: message.createdAt, id: message.id })).toString('base64url');
}
export function compareMessages(left: StoredAgentMessageV2, right: StoredAgentMessageV2): number {
  return right.message.createdAt.localeCompare(left.message.createdAt) || right.message.id.localeCompare(left.message.id);
}
export function afterMessageCursor(record: StoredAgentMessageV2, cursor: MessageCursor): boolean {
  return record.message.createdAt < cursor.createdAt || (record.message.createdAt === cursor.createdAt && record.message.id < cursor.id);
}

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
    clone.blocks = clone.blocks.filter((block) => block.type === 'error').slice(0, 8);
    clone.blocks.push({ type: 'text', blockId: 'public-truncation', text: '[TRUNCATED]' });
  }
  if (Buffer.byteLength(JSON.stringify(clone), 'utf8') > MESSAGE_BYTES) {
    clone.blocks = [{ type: 'text', blockId: 'public-truncation', text: '[TRUNCATED]' }];
  }
  return { message: clone, truncated };
}
function shorten(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max)}[TRUNCATED]`; }

export function makePublicMessagePage(records: readonly (StoredAgentMessageV2 & { truncated?: boolean })[], limit: number, hasMore: boolean): PublicMessagePage {
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
    ? { items, nextCursor: encodeMessageCursor(items[items.length - 1]!.message) }
    : { items };
}
