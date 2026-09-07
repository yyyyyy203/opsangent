import type { MessageBlockV2 } from './blocks.js';
import type { JsonValue, MessageRoleV2, MessageStatusV2, MessageVisibilityV2 } from './common.js';

export interface AgentMessageV2 {
  schemaVersion: 2;
  id: string;
  runId: string;
  sessionId?: string;
  replyId?: string;
  stepId?: string;
  parentMessageId?: string;
  role: MessageRoleV2;
  status: MessageStatusV2;
  visibility: MessageVisibilityV2;
  blocks: MessageBlockV2[];
  createdAt: string;
  completedAt?: string;
  metadata?: Record<string, JsonValue>;
}

export * from './blocks.js';
export * from './common.js';
export * from './schema.js';
