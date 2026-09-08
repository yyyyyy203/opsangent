import type { AgentEventPayloadMap, EventFactoryV2Like, EventPublisherV2Like, IdGenerator, Tool, ToolCallOptions, ToolCallReturn, ToolResponse, ToolResponseChunk } from '../../contracts/index.js';

export interface SubagentDescriptor {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  invoke?: (input: Record<string, unknown>, signal: AbortSignal) => ToolCallReturn;
  concurrencySafe?: boolean;
  lifecycle?: { factory: EventFactoryV2Like; publisher: EventPublisherV2Like; ids: IdGenerator; correlationId: (runId: string) => string };
}

export function adaptSubagentTool(subagent: SubagentDescriptor): Tool {
  return {
    name: `subagent.${subagent.name}`,
    description: subagent.description,
    kind: 'utility',
    inputSchema: subagent.inputSchema,
    ...(subagent.invoke === undefined ? {} : { call: (input, options) => invokeWithLifecycle(subagent, input, options) }),
    userFacingLabel: () => `委派子 Agent：${subagent.name}`,
    isConcurrencySafe: () => subagent.concurrencySafe === true,
  };
}

async function* invokeWithLifecycle(
  subagent: SubagentDescriptor,
  input: Record<string, unknown>,
  options: ToolCallOptions,
): AsyncGenerator<ToolResponseChunk, ToolResponse> {
  const lifecycle = subagent.lifecycle;
  const childRunId = lifecycle?.ids.next('subrun') ?? `subrun-${crypto.randomUUID()}`;
  if (lifecycle) await emit(lifecycle, 'SUBAGENT_STARTED', options.runId, { subagentType: subagent.name, childRunId, parentRunId: options.runId, budget: { type: 'tool_calls', limit: 8, used: 0 } });
  try {
    const result = subagent.invoke!(input, options.signal);
    const response = isAsyncIterable(result) ? yield* result : await result;
    if (lifecycle) await emit(lifecycle, 'SUBAGENT_COMPLETED', options.runId, { childRunId, status: 'completed', evidenceIds: response.evidenceIds ?? [], coverage: 1 });
    return response;
  } catch (error) {
    if (lifecycle) await emit(lifecycle, 'SUBAGENT_FAILED', options.runId, { childRunId, error: { code: 'UNAVAILABLE', message: error instanceof Error ? error.message : 'Subagent failed.', retryable: true }, partialEvidenceIds: [] });
    throw error;
  }
}

function isAsyncIterable(value: ToolCallReturn): value is AsyncGenerator<ToolResponseChunk, ToolResponse> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

async function emit<T extends keyof AgentEventPayloadMap>(
  lifecycle: NonNullable<SubagentDescriptor['lifecycle']>, type: T, parentRunId: string, payload: AgentEventPayloadMap[T],
): Promise<void> {
  const childRunId = typeof payload === 'object' && payload !== null && 'childRunId' in payload ? String(payload.childRunId) : parentRunId;
  const event = lifecycle.factory.create(type, { runId: childRunId, parentRunId, correlationId: lifecycle.correlationId(parentRunId), visibility: 'audit', durability: 'durable' }, payload);
  await lifecycle.publisher.publish(event).then(() => undefined);
}
