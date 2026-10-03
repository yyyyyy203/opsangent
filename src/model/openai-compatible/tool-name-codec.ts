import { createHash } from 'node:crypto';
import type { AgentMessage, ModelResponse, Tool } from '../../contracts/index.js';
import { ModelFailure } from '../model-failure.js';

const MAX_WIRE_NAME_LENGTH = 64;
const WIRE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface ModelToolNameCodec {
  toWireName(internalName: string): string;
  toInternalName(wireName: string): string;
  toInternalResponse(response: ModelResponse): ModelResponse;
}

/** Provides stable, reversible, provider-safe names without changing internal Tool identities. */
export function createModelToolNameCodec(messages: readonly AgentMessage[], tools: readonly Tool[]): ModelToolNameCodec {
  const internalNames = new Set(tools.map((tool) => tool.name));
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type === 'tool_call' || block.type === 'raw_tool_call') internalNames.add(block.call.name);
    }
  }

  const candidates = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const internalName of internalNames) {
    if (internalName.trim().length === 0) throw protocolFailure('Tool name must not be empty.');
    const base = safeBase(internalName);
    candidates.set(internalName, base);
    const group = groups.get(base) ?? [];
    group.push(internalName);
    groups.set(base, group);
  }

  const internalToWire = new Map<string, string>();
  const wireToInternal = new Map<string, string>();
  for (const [internalName, base] of candidates) {
    const needsHash = internalName.length > MAX_WIRE_NAME_LENGTH
      || (groups.get(base)?.length ?? 0) > 1;
    const wireName = needsHash
      ? hashedWireName(base, internalName)
      : WIRE_NAME_PATTERN.test(internalName) ? internalName : base;
    if (!isWireSafe(wireName)) throw protocolFailure('Tool name could not be represented for the model provider.');
    const existing = wireToInternal.get(wireName);
    if (existing !== undefined && existing !== internalName) throw protocolFailure('Tool names collide after provider-safe mapping.');
    internalToWire.set(internalName, wireName);
    wireToInternal.set(wireName, internalName);
  }

  let unknownPrefix = '__unadvertised_model_tool__';
  while ([...internalNames].some((name) => name.startsWith(unknownPrefix))) unknownPrefix += '_';

  const toWireName = (internalName: string): string => {
    const wireName = internalToWire.get(internalName);
    if (wireName === undefined) throw protocolFailure('Assistant ToolCall does not match the current Tool snapshot.');
    return wireName;
  };
  const toInternalName = (wireName: string): string => wireToInternal.get(wireName)
    ?? `${unknownPrefix}${createHash('sha256').update(wireName).digest('hex').slice(0, 16)}`;

  return {
    toWireName,
    toInternalName,
    toInternalResponse: (response) => ({
      ...response,
      toolCalls: response.toolCalls.map((call) => ({ ...call, name: toInternalName(call.name) })),
      ...(response.rawToolCalls === undefined ? {} : {
        rawToolCalls: response.rawToolCalls.map((call) => ({ ...call, name: toInternalName(call.name) })),
      }),
    }),
  };
}

function safeBase(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_WIRE_NAME_LENGTH);
  return normalized.length === 0 ? 'tool' : normalized;
}

function hashedWireName(base: string, internalName: string): string {
  const suffix = createHash('sha256').update(internalName).digest('hex').slice(0, 8);
  return `${base.slice(0, MAX_WIRE_NAME_LENGTH - suffix.length - 1)}_${suffix}`;
}

function isWireSafe(name: string): boolean {
  return name.length > 0 && name.length <= MAX_WIRE_NAME_LENGTH && WIRE_NAME_PATTERN.test(name);
}

function protocolFailure(message: string): ModelFailure {
  return new ModelFailure('protocol', message, false);
}
