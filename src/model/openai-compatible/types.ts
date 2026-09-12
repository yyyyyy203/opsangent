import type { ModelStreamEvent } from '../../contracts/model.js';

export interface OpenAICompatibleFunctionCall {
  name: string;
  arguments: string;
}

export interface OpenAICompatibleToolCall {
  id: string;
  type: 'function';
  function: OpenAICompatibleFunctionCall;
}

export interface OpenAICompatibleSystemMessage {
  role: 'system';
  content: string;
}

export interface OpenAICompatibleUserMessage {
  role: 'user';
  content: string;
}

export interface OpenAICompatibleAssistantMessage {
  role: 'assistant';
  content: string;
  tool_calls?: readonly OpenAICompatibleToolCall[];
}

export interface OpenAICompatibleToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type OpenAICompatibleMessage =
  | OpenAICompatibleSystemMessage
  | OpenAICompatibleUserMessage
  | OpenAICompatibleAssistantMessage
  | OpenAICompatibleToolMessage;

export interface OpenAICompatibleTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAICompatibleRequest {
  model: string;
  messages: readonly OpenAICompatibleMessage[];
  stream: true;
  stream_options?: { include_usage: true };
  tools?: readonly OpenAICompatibleTool[];
  tool_choice?: 'none';
}

export interface OpenAICompatibleChoice {
  index: number;
  delta?: {
    content?: string | null;
    tool_calls?: readonly OpenAICompatibleToolCallDelta[];
  };
  finish_reason?: string | null;
}

export interface OpenAICompatibleToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAICompatibleUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
}

export interface OpenAICompatibleStreamChunk {
  choices: readonly OpenAICompatibleChoice[];
  usage?: OpenAICompatibleUsage | null;
}

export type OpenAICompatibleTextEvent = Extract<ModelStreamEvent, { type: 'text_delta' }>;
