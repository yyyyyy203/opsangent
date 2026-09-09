import type { AgentMessage, MessageBlock, Tool, ToolExecutionResult, ToolResponseBlock } from '../../contracts/index.js';
import { toolInputJsonSchema } from '../../tool/schema.js';
import { ModelFailure } from '../model-failure.js';
import type {
  OpenAICompatibleAssistantMessage,
  OpenAICompatibleMessage,
  OpenAICompatibleRequest,
  OpenAICompatibleTool,
  OpenAICompatibleToolCall,
  OpenAICompatibleToolMessage,
} from './types.js';

const CORRECTION_DETAIL_KEYS = [
  'gate',
  'reason',
  'retryableByModel',
  'expectedSchema',
  'issues',
  'correctionChainId',
  'remainingModelRetries',
] as const;

type CorrectionDetailKey = typeof CORRECTION_DETAIL_KEYS[number];

export function formatChatRequest(
  messages: readonly AgentMessage[],
  tools: readonly Tool[],
  options: { model: string; includeUsage: boolean },
): OpenAICompatibleRequest {
  if (options.model.trim().length === 0) throw protocolFailure('Model name is required.');

  const formattedMessages: OpenAICompatibleMessage[] = [];
  for (const message of messages) formattedMessages.push(...formatMessage(message));

  const formattedTools = tools.length === 0 ? undefined : tools.map(formatTool);
  return {
    model: options.model,
    messages: formattedMessages,
    stream: true,
    ...(options.includeUsage ? { stream_options: { include_usage: true as const } } : {}),
    ...(formattedTools === undefined ? {} : { tools: formattedTools }),
  };
}

export function renderToolResultForModel(result: ToolExecutionResult): string {
  const projected: Record<string, unknown> = { status: result.status };
  const blocks = result.response?.blocks.map(projectToolResponseBlock).filter((block): block is Record<string, unknown> => block !== undefined);
  if (blocks !== undefined && blocks.length > 0) projected.blocks = blocks;
  if (result.error !== undefined) projected.error = projectError(result.error);
  return stableJson(projected);
}

function formatMessage(message: AgentMessage): OpenAICompatibleMessage[] {
  switch (message.role) {
    case 'system':
      return [formatTextualMessage('system', message.blocks)];
    case 'user':
      return [formatTextualMessage('user', message.blocks)];
    case 'assistant':
      return [formatAssistantMessage(message.blocks)];
    case 'tool':
      return formatToolMessages(message.blocks);
    default:
      return assertNever(message.role);
  }
}

function formatTextualMessage(
  role: 'system' | 'user',
  blocks: readonly MessageBlock[],
): OpenAICompatibleMessage {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'context_summary') parts.push(stableJson(block.summary));
    else throw protocolFailure(`${role} messages can contain only text and context summary blocks.`);
  }
  return { role, content: parts.join('\n') };
}

function formatAssistantMessage(blocks: readonly MessageBlock[]): OpenAICompatibleAssistantMessage {
  const textParts: string[] = [];
  const toolCalls: OpenAICompatibleToolCall[] = [];
  for (const block of blocks) {
    if (block.type === 'text') textParts.push(block.text);
    else if (block.type === 'context_summary') textParts.push(stableJson(block.summary));
    else if (block.type === 'tool_call') toolCalls.push({
      id: requireIdentity(block.call.id, 'tool call id'),
      type: 'function',
      function: {
        name: requireIdentity(block.call.name, 'tool name'),
        arguments: stableJson(block.call.input),
      },
    });
    else if (block.type === 'raw_tool_call') toolCalls.push({
      id: requireIdentity(block.call.id, 'tool call id'),
      type: 'function',
      function: {
        name: requireIdentity(block.call.name, 'tool name'),
        arguments: requireString(block.call.arguments, 'tool call arguments'),
      },
    });
    else throw protocolFailure('Assistant messages cannot contain tool result blocks.');
  }
  return {
    role: 'assistant',
    content: textParts.join('\n'),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}

function formatToolMessages(blocks: readonly MessageBlock[]): OpenAICompatibleToolMessage[] {
  const messages: OpenAICompatibleToolMessage[] = [];
  for (const block of blocks) {
    if (block.type !== 'tool_result') throw protocolFailure('Tool messages can contain only tool result blocks.');
    messages.push({
      role: 'tool',
      tool_call_id: requireIdentity(block.result.toolCallId, 'tool call id'),
      content: renderToolResultForModel(block.result),
    });
  }
  if (messages.length === 0) throw protocolFailure('Tool messages must contain a tool result.');
  return messages;
}

function formatTool(tool: Tool): OpenAICompatibleTool {
  const name = requireIdentity(tool.name, 'tool name');
  const description = requireString(tool.description, 'tool description');
  const parameters = toolInputJsonSchema(tool);
  assertJsonSafe(parameters, 'tool schema');
  return { type: 'function', function: { name, description, parameters: stableValue(parameters) as Record<string, unknown> } };
}

function projectToolResponseBlock(block: ToolResponseBlock): Record<string, unknown> | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: requireString(block.text, 'tool result text') };
    case 'json':
      assertJsonSafe(block.value, 'tool result JSON');
      return { type: 'json', value: stableValue(block.value) };
    case 'evidence_ref':
      return { type: 'evidence_ref', evidenceId: requireIdentity(block.evidenceId, 'evidence id') };
    case 'artifact':
      return undefined;
    default:
      return assertNever(block);
  }
}

function projectError(error: NonNullable<ToolExecutionResult['error']>): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    code: requireIdentity(error.code, 'error code'),
    message: safeErrorMessage(error.message),
    retryable: error.retryable,
  };
  if (error.details !== undefined) {
    const details: Record<string, unknown> = {};
    for (const key of CORRECTION_DETAIL_KEYS) {
      const value = error.details[key];
      if (value === undefined) continue;
      assertCorrectionValue(key, value);
      details[key] = stableValue(value);
    }
    if (Object.keys(details).length > 0) projected.details = details;
  }
  return projected;
}

function assertCorrectionValue(key: CorrectionDetailKey, value: unknown): void {
  if (key === 'gate' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw protocolFailure('Invalid correction gate.');
  if (key === 'retryableByModel' && typeof value !== 'boolean') throw protocolFailure('Invalid correction retryability.');
  if (key === 'remainingModelRetries' && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) throw protocolFailure('Invalid remaining model retries.');
  if (key !== 'gate' && key !== 'retryableByModel' && key !== 'remainingModelRetries') {
    if (key === 'correctionChainId' || key === 'reason') requireString(value, `correction ${key}`);
    assertJsonSafe(value, `correction ${key}`);
  }
}

function safeErrorMessage(value: string): string {
  const message = requireString(value, 'error message');
  return message
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s"']*[\\/])+[^\s"']*/g, '[redacted-path]')
    .slice(0, 1000);
}

function stableJson(value: unknown): string {
  assertJsonSafe(value, 'JSON value');
  const serialized = JSON.stringify(stableValue(value));
  if (serialized === undefined) throw protocolFailure('Value cannot be represented as JSON.');
  return serialized;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
  }
  return value;
}

function assertJsonSafe(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw protocolFailure(`${label} contains a non-finite number.`);
  }
  if (typeof value !== 'object') throw protocolFailure(`${label} contains an unsupported value.`);
  if (seen.has(value)) throw protocolFailure(`${label} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonSafe(item, label, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw protocolFailure(`${label} contains undefined field ${key}.`);
      assertJsonSafe(item, label, seen);
    }
  }
  seen.delete(value);
}

function requireIdentity(value: string, label: string): string {
  return requireString(value, label).trim();
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw protocolFailure(`${label} is required.`);
  return value;
}

function protocolFailure(message: string): ModelFailure {
  return new ModelFailure('protocol', message, false);
}

function assertNever(value: never): never {
  throw protocolFailure(`Unsupported message value: ${String(value)}.`);
}
