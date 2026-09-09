import type { AgentMessage } from './message.js';
import type { Tool, ToolCall, RawToolCall } from './tool.js';

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface ModelResponse {
  text?: string;
  toolCalls: ToolCall[];
  rawToolCalls?: RawToolCall[];
  usage?: ModelUsage;
  finishReason?: string;
}

export type ModelStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };

export interface ModelCallOptions {
  signal: AbortSignal;
  runId: string;
  stepId: string;
  sessionId?: string;
  replyId?: string;
  streamId?: string;
  deadline?: number;
}

export interface ChatModel {
  stream(messages: AgentMessage[], tools: Tool[], options: ModelCallOptions): AsyncGenerator<ModelStreamEvent, ModelResponse>;
}
