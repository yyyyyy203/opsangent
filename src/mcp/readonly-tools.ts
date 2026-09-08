import type { Tool, ToolCallOptions, ToolResponse, ToolResponseChunk } from '../contracts/tool.js';
import type { McpConnection } from './types.js';
import { type ResilientExecutor, SourceFailure, type RetryEvent } from './resilience.js';
import { validateToolInput } from '../tool/schema.js';

export interface ReadonlyMcpManifest {
  localName: string;
  remoteName: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  expectedRemoteSchema: Record<string, unknown>;
  readOnly: true;
  idempotent: true;
  concurrencySafe: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function bindReadonlyMcpTools(
  connection: McpConnection, manifests: readonly ReadonlyMcpManifest[],
  options: { signal: AbortSignal; executor: ResilientExecutor; now?: () => number; onEvent?: (sourceId: string, event: RetryEvent) => void },
): Promise<Tool[]> {
  const now = options.now ?? Date.now;
  const descriptors = await options.executor.execute((signal) => connection.listTools(signal), { signal: options.signal, deadline: now() + 30_000 });
  const names = new Set<string>();
  // Validate the complete manifest before returning any capability.
  for (const manifest of manifests) {
    const remote = descriptors.find((tool) => tool.name === manifest.remoteName);
    if (manifest.readOnly !== true || manifest.idempotent !== true || names.has(manifest.localName)) throw new SourceFailure('POLICY_DENIED');
    names.add(manifest.localName);
    if (!remote || canonical(remote.inputSchema) !== canonical(manifest.expectedRemoteSchema)) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  }
  return manifests.map((manifest) => {
    const tool: Tool = {
      name: manifest.localName, description: manifest.description, kind: 'evidence', inputSchema: manifest.inputSchema,
      isConcurrencySafe: () => manifest.concurrencySafe,
      call: (input, callOptions) => invoke(connection, manifest.localName, manifest.remoteName, tool, input, callOptions, options.executor, now, options.onEvent),
    };
    return Object.freeze(tool);
  });
}

async function* invoke(
  connection: McpConnection, sourceId: string, remoteName: string, tool: Tool, input: Record<string, unknown>,
  options: ToolCallOptions, executor: ResilientExecutor, now: () => number, onEvent?: (sourceId: string, event: RetryEvent) => void,
): AsyncGenerator<ToolResponseChunk, ToolResponse> {
  const validation = validateToolInput(tool, input);
  if (!validation.valid || !validation.value) throw new SourceFailure('TOOL_ARGUMENTS_SCHEMA_INVALID');
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  const queue: RetryEvent[] = [];
  let wake: () => void = () => {};
  let complete = false;
  let response: ToolResponse | undefined;
  let failure: unknown;
  const pending = executor.execute((attemptSignal) => connection.call(remoteName, validation.value ?? input, attemptSignal), {
    signal, deadline: Math.min(options.deadline ?? Infinity, now() + 30_000),
    ...(options.networkAttemptBudget ? { attemptBudget: options.networkAttemptBudget } : {}),
    onEvent: (event) => { onEvent?.(sourceId, event); queue.push(event); wake(); },
  }).then((value) => { response = value; }).catch((error: unknown) => { failure = error; }).finally(() => { complete = true; wake(); });
  try {
    while (!complete || queue.length > 0) {
      const event = queue.shift();
      if (event) yield { type: 'event', name: 'mcp_attempt', payload: { ...event } };
      else await new Promise<void>((resolve) => { wake = resolve; });
    }
    await pending;
    if (failure !== undefined) throw failure instanceof Error ? failure : new SourceFailure('MCP_PROTOCOL_ERROR');
    if (!response) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    return response;
  } finally { controller.abort(); }
}
