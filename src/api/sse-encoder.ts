import type { JsonValue } from '../contracts/common.js';
import { isJsonValue } from '../contracts/message-v2/common.js';

export interface SseFrame {
  id?: string;
  event: string;
  data: JsonValue;
}

/** Encode a single frame. Transport snapshots may omit id to preserve the cursor. */
export function encodeSseFrame(frame: SseFrame): string {
  validateField(frame.event);
  if (frame.id !== undefined) validateField(frame.id);
  if (!isJsonValue(frame.data)) throw new TypeError('SSE data must be JSON-safe');
  const lines = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`, `data: ${JSON.stringify(frame.data)}`);
  return `${lines.join('\n')}\n\n`;
}

function validateField(value: string): void {
  if (value.length === 0 || /[\r\n\0]/u.test(value)) {
    throw new TypeError('SSE event and id must be nonempty single-line fields without NUL');
  }
}
