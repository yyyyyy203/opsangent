import type { AgentEventPayloadMap, EventFactoryV2Like, EventPublisherV2Like, IdGenerator, Tool, ToolCallOptions, ToolCallReturn, ToolResponse, ToolResponseChunk } from '../../contracts/index.js';

export interface SubagentDescriptor {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  invoke?: (input: Record<string, unknown>, signal: AbortSignal) => ToolCallReturn;
  concurrencySafe?: boolean;
  retry?: {
    maxAttempts?: number;
    sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
    shouldRetry?: (error: unknown) => boolean;
    delayMs?: number | ((attempt: number) => number);
  };
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
  const retry = subagent.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > 3) throw new Error('Subagent maxAttempts must be between 1 and 3.');
  if (lifecycle) await emit(lifecycle, 'SUBAGENT_STARTED', options, { subagentType: subagent.name, childRunId, parentRunId: options.runId, budget: { type: 'tool_calls', limit: 8, used: 0 } });
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let exposedOutput = false;
    try {
      const returned = subagent.invoke!(input, options.signal);
      let response: ToolResponse;
      if (isAsyncIterable(returned)) {
        while (true) {
          const item = await returned.next();
          if (item.done) { response = item.value; break; }
          exposedOutput = true;
          yield item.value;
        }
      } else {
        response = await returned;
      }
      if (lifecycle) await emit(lifecycle, 'SUBAGENT_COMPLETED', options, { childRunId, status: 'completed', evidenceIds: response.evidenceIds ?? [], coverage: 1 }, attempt);
      return response;
    } catch (error) {
      const retryable = !options.signal.aborted && !exposedOutput && (retry?.shouldRetry?.(error) ?? true);
      if (retryable && attempt < maxAttempts) {
        const delayMs = resolveDelay(retry?.delayMs, attempt);
        if (lifecycle) await emit(lifecycle, 'SUBAGENT_RETRY_SCHEDULED', options, { childRunId, attempt, reasonCode: reasonCode(error) }, attempt);
        if (delayMs > 0) await (retry?.sleep ?? sleep)(delayMs, options.signal);
        continue;
      }
      if (lifecycle) await emit(lifecycle, 'SUBAGENT_FAILED', options, { childRunId, error: subagentError(error, retryable), partialEvidenceIds: [] }, attempt);
      throw error;
    }
  }
  throw new Error('Subagent attempts exhausted.');
}

function isAsyncIterable(value: ToolCallReturn): value is AsyncGenerator<ToolResponseChunk, ToolResponse> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

async function emit<T extends keyof AgentEventPayloadMap>(
  lifecycle: NonNullable<SubagentDescriptor['lifecycle']>, type: T, options: ToolCallOptions, payload: AgentEventPayloadMap[T], attempt?: number,
): Promise<void> {
  const childRunId = typeof payload === 'object' && payload !== null && 'childRunId' in payload ? String(payload.childRunId) : options.runId;
  const event = lifecycle.factory.create(type, {
    runId: childRunId,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.replyId === undefined ? {} : { replyId: options.replyId }),
    ...(options.streamId === undefined ? {} : { streamId: options.streamId }),
    parentRunId: options.runId,
    correlationId: lifecycle.correlationId(options.runId),
    visibility: 'audit',
    durability: 'durable',
    stepId: options.stepId,
    ...(attempt === undefined ? {} : { attemptId: `subattempt:${childRunId}:${attempt}` }),
  }, payload);
  await lifecycle.publisher.publish(event).then(() => undefined);
}

function resolveDelay(value: number | ((attempt: number) => number) | undefined, attempt: number): number {
  const delay = typeof value === 'function' ? value(attempt) : value ?? 0;
  if (!Number.isFinite(delay) || delay < 0) throw new RangeError('Subagent retry delay must be finite and non-negative.');
  return delay;
}

function reasonCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && error.code.length > 0) return error.code;
  return 'UNAVAILABLE';
}

function subagentError(error: unknown, retryable: boolean): { code: 'MODEL_ERROR' | 'STORAGE_ERROR' | 'MCP_NETWORK_ERROR' | 'MCP_TIMEOUT' | 'MCP_RATE_LIMITED' | 'MCP_SERVER_ERROR' | 'MCP_AUTH_ERROR' | 'MCP_PROTOCOL_ERROR' | 'CIRCUIT_OPEN' | 'TIMEOUT' | 'UNAVAILABLE'; message: string; retryable: boolean } {
  const code = reasonCode(error);
  const allowed = new Set(['MODEL_ERROR', 'STORAGE_ERROR', 'MCP_NETWORK_ERROR', 'MCP_TIMEOUT', 'MCP_RATE_LIMITED', 'MCP_SERVER_ERROR', 'MCP_AUTH_ERROR', 'MCP_PROTOCOL_ERROR', 'CIRCUIT_OPEN', 'TIMEOUT', 'UNAVAILABLE']);
  return { code: allowed.has(code) ? code as ReturnType<typeof subagentError>['code'] : 'UNAVAILABLE', message: error instanceof Error ? error.message : 'Subagent failed.', retryable };
}

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Subagent retry aborted.')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
    const abort = () => { clearTimeout(timer); reject(new Error('Subagent retry aborted.')); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
