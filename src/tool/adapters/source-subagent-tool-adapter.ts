import type {
  AgentErrorCode,
  AgentEventPayloadMap,
  SourceFinding,
  SourceSubagentDescriptor,
  SourceSubagentExecution,
  SourceSubagentRequest,
  SourceSubagentResult,
  SourceSubagentRetryPolicy,
  Tool,
  ToolCallOptions,
  ToolResponse,
  ToolResponseChunk,
} from '../../contracts/index.js';
import { canonicalSourceToolName } from '../../contracts/index.js';
import { validateToolInput } from '../schema.js';

const MAX_ATTEMPTS = 3;
const DEFAULT_ATTEMPTS = 2;
const MAX_ITEMS = 20;
const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_STATEMENT_CHARS = 4_096;
const MAX_TRACE_ID_CHARS = 256;

const RETRYABLE_CODES = new Set<AgentErrorCode>([
  'MCP_NETWORK_ERROR',
  'MCP_TIMEOUT',
  'MCP_RATE_LIMITED',
  'MCP_SERVER_ERROR',
  'TIMEOUT',
]);

/**
 * Adapts a source-specific child Runner to the ordinary parent Tool contract.
 * The adapter owns identity, host-scope validation, retries and public result bounds;
 * the Runner owns child Harness construction and evidence collection.
 */
export function createSourceSubagentTool(descriptor: SourceSubagentDescriptor): Tool {
  if (descriptor.publicToolName !== canonicalSourceToolName(descriptor.subagentType)) {
    throw new Error(`Source Tool name must be canonical for ${descriptor.subagentType}.`);
  }

  const schemaTool: Tool = {
    name: descriptor.publicToolName,
    description: descriptor.description,
    kind: 'evidence',
    source: 'subagent',
    inputSchema: descriptor.inputSchema,
  };

  const tool: Tool = {
    name: descriptor.publicToolName,
    description: descriptor.description,
    kind: 'evidence',
    source: 'subagent',
    inputSchema: descriptor.inputSchema,
    recoveryPolicy: 'verify_before_retry',
    isConcurrencySafe: () => false,
    userFacingLabel: () => `调查${descriptor.subagentType}数据源`,
    validateSemantics: (input) => {
      try {
        validateRequest(input, undefined);
        return { valid: true, value: input };
      } catch (error) {
        return { valid: false, error: toAgentError(error, 'INVALID_INPUT') };
      }
    },
    call: (input, options) => invokeSourceSubagent(descriptor, schemaTool, input, options),
  };
  return Object.freeze(tool);
}

async function* invokeSourceSubagent(
  descriptor: SourceSubagentDescriptor,
  schemaTool: Tool,
  input: Record<string, unknown>,
  options: ToolCallOptions,
): AsyncGenerator<ToolResponseChunk, ToolResponse> {
  const request = validateRequest(input, schemaTool);
  const executionBase = createExecutionBase(request, options);
  const childRunId = descriptor.childRunId(executionBase);
  if (typeof childRunId !== 'string' || childRunId.trim().length === 0) {
    throw new SourceToolFailure('STORAGE_ERROR', 'Child Run identity could not be created.', false);
  }
  const execution: SourceSubagentExecution = { ...executionBase, childRunId };
  await descriptor.validateEvidenceIds?.(request.evidenceIds, {
    parentRunId: execution.parentRunId,
    profileId: execution.profileId,
  });
  const attempts = resolveMaxAttempts(descriptor);
  const lifecycle = descriptor.lifecycle;
  await publishLifecycle(lifecycle, 'SUBAGENT_STARTED', execution, {
    subagentType: descriptor.subagentType,
    childRunId,
    parentRunId: options.runId,
    budget: {
      type: 'tool_calls',
      limit: options.remainingToolCalls!,
      used: 0,
    },
  });

  const retry = descriptor.retry;
  let lastError: unknown;
  let lastPartialResult: SourceSubagentResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let exposedOutput = false;
    try {
      const stream = descriptor.runner.run(request, execution);
      let result: SourceSubagentResult;
      let completed = false;
      try {
        while (true) {
          throwIfAborted(options.signal);
          const item = await stream.next();
          if (item.done) {
            result = validateResult(item.value, descriptor.subagentType);
            completed = true;
            break;
          }
          exposedOutput = true;
          yield sanitizeChunk(item.value);
        }
      } finally {
        if (!completed) await stream.return(undefined as never).catch(() => undefined);
      }
      const response = flattenResult(result);
      if (result.status === 'unavailable') {
        await publishLifecycle(lifecycle, 'SUBAGENT_FALLBACK_ACTIVATED', execution, {
          childRunId,
          fallbackMode: 'empty',
          reasonCode: 'UNAVAILABLE',
        }, attempt);
        await publishLifecycle(lifecycle, 'SUBAGENT_FAILED', execution, {
          childRunId,
          error: errorPayload('UNAVAILABLE', '数据源当前不可用。', false),
          partialEvidenceIds: [],
        }, attempt);
        return response;
      }
      if (result.status === 'partial') {
        await publishLifecycle(lifecycle, 'SUBAGENT_FALLBACK_ACTIVATED', execution, {
          childRunId,
          fallbackMode: 'reduced_scope',
          reasonCode: 'PARTIAL_EVIDENCE',
        }, attempt);
      }
      await publishLifecycle(lifecycle, 'SUBAGENT_COMPLETED', execution, {
        childRunId,
        status: result.status === 'partial' ? 'partial' : 'completed',
        evidenceIds: result.evidenceIds,
        coverage: result.coverage,
      }, attempt);
      return response;
    } catch (error) {
      lastError = error;
      const code = errorCode(error);
      const partialResult = partialResultFrom(error, descriptor.subagentType);
      if (partialResult !== undefined) lastPartialResult = partialResult;
      const retryable = shouldRetry(descriptor, error, code, exposedOutput, options.signal, attempt, attempts);
      if (retryable) {
        const delayMs = resolveDelay(retry?.delayMs, attempt);
        await publishLifecycle(lifecycle, 'SUBAGENT_RETRY_SCHEDULED', execution, {
          childRunId,
          attempt,
          reasonCode: code,
        }, attempt);
        if (delayMs > 0) await (retry?.sleep ?? sleep)(delayMs, options.signal);
        continue;
      }
      const reducedScopeResult = partialResult ?? lastPartialResult;
      if (reducedScopeResult !== undefined) {
        const response = flattenResult(reducedScopeResult);
        await publishLifecycle(lifecycle, 'SUBAGENT_FALLBACK_ACTIVATED', execution, {
          childRunId,
          fallbackMode: 'reduced_scope',
          reasonCode: 'RETRY_EXHAUSTED',
        }, attempt);
        await publishLifecycle(lifecycle, 'SUBAGENT_COMPLETED', execution, {
          childRunId,
          status: 'partial',
          evidenceIds: reducedScopeResult.evidenceIds,
          coverage: reducedScopeResult.coverage,
        }, attempt);
        return response;
      }
      await publishLifecycle(lifecycle, 'SUBAGENT_FAILED', execution, {
        childRunId,
        error: errorPayload(lifecycleErrorCode(code), safeErrorMessage(error), false),
        partialEvidenceIds: [],
      }, attempt);
      throw toSourceToolFailure(error, code);
    }
  }
  const exhausted = lastError ?? new SourceToolFailure('UNAVAILABLE', 'Source subagent attempts exhausted.', false);
  throw toSourceToolFailure(exhausted, errorCode(exhausted));
}

function partialResultFrom(error: unknown, source: SourceSubagentDescriptor['subagentType']): SourceSubagentResult | undefined {
  if (!isSourceSubagentFailure(error) || error.partialResult === undefined || error.partialResult.status !== 'partial'
    || error.partialResult.evidenceIds.length === 0) return undefined;
  return validateResult(error.partialResult, source);
}

function validateRequest(input: Record<string, unknown>, schemaTool: Tool | undefined): SourceSubagentRequest {
  if (schemaTool !== undefined) {
    const validation = validateToolInput(schemaTool, input);
    if (!validation.valid || validation.value === undefined) {
      throw new SourceToolFailure('INVALID_INPUT', 'Invalid source subagent input.', false);
    }
    input = validation.value;
  } else if (!isToolInputSchemaForSemantic(input)) {
    // Semantic validation is also used by the ToolAdmission path before call().
    // The complete schema validation still happens inside call() through schemaTool.
  }
  if (typeof input.profileId !== 'string' || input.profileId.trim().length === 0
    || typeof input.service !== 'string' || input.service.trim().length === 0
    || typeof input.start !== 'string' || typeof input.end !== 'string'
    || typeof input.question !== 'string' || input.question.trim().length === 0) {
    throw new SourceToolFailure('INVALID_INPUT', 'Source subagent input is incomplete.', false);
  }
  const start = Date.parse(input.start);
  const end = Date.parse(input.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new SourceToolFailure('INVALID_INPUT', 'Source subagent time range is invalid.', false);
  }
  const evidenceIdsValue = input.evidenceIds;
  if (evidenceIdsValue !== undefined && !isStringArray(evidenceIdsValue)) {
    throw new SourceToolFailure('INVALID_INPUT', 'Source subagent evidenceIds are invalid.', false);
  }
  const evidenceIds = evidenceIdsValue === undefined ? [] : evidenceIdsValue;
  return {
    profileId: input.profileId,
    service: input.service,
    start: input.start,
    end: input.end,
    question: input.question,
    evidenceIds: [...new Set(evidenceIds)],
  };
}

function createExecutionBase(
  request: SourceSubagentRequest,
  options: ToolCallOptions,
): Omit<SourceSubagentExecution, 'childRunId'> {
  if (options.toolCallId === undefined || options.toolCallId.trim().length === 0) {
    throw new SourceToolFailure('POLICY_DENIED', 'Source subagent requires a stable parent ToolCall identity.', false);
  }
  if (options.profileId === undefined || options.profileId.trim().length === 0) {
    throw new SourceToolFailure('POLICY_DENIED', 'Source subagent requires a host profile scope.', false);
  }
  if (request.profileId !== options.profileId) {
    throw new SourceToolFailure('POLICY_DENIED', 'Source subagent profile scope does not match the host scope.', false);
  }
  if (options.remainingToolCalls === undefined
    || !Number.isSafeInteger(options.remainingToolCalls) || options.remainingToolCalls <= 0) {
    throw new SourceToolFailure('BUDGET_EXCEEDED', 'Parent Tool-call budget is exhausted or unavailable.', false);
  }
  return {
    parentRunId: options.runId,
    parentToolCallId: options.toolCallId,
    parentStepId: options.stepId,
    profileId: options.profileId,
    ...(options.profileRevision === undefined ? {} : { profileRevision: options.profileRevision }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.replyId === undefined ? {} : { replyId: options.replyId }),
    ...(options.streamId === undefined ? {} : { streamId: options.streamId }),
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    signal: options.signal,
    ...(options.toolCallBudget === undefined ? {} : { toolCallBudget: options.toolCallBudget }),
    ...(options.networkAttemptBudget === undefined ? {} : { networkAttemptBudget: options.networkAttemptBudget }),
    remainingToolCalls: options.remainingToolCalls,
  };
}

function resolveMaxAttempts(descriptor: SourceSubagentDescriptor): number {
  const value = descriptor.retry?.maxAttempts ?? descriptor.maxAttempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ATTEMPTS) {
    throw new SourceToolFailure('INVALID_INPUT', 'Source subagent maxAttempts must be between 1 and 3.', false);
  }
  return value;
}

function shouldRetry(
  descriptor: SourceSubagentDescriptor,
  error: unknown,
  code: AgentErrorCode,
  exposedOutput: boolean,
  signal: AbortSignal,
  attempt: number,
  maxAttempts: number,
): boolean {
  if (exposedOutput || signal.aborted || attempt >= maxAttempts || code === 'ABORTED'
    || code === 'POLICY_DENIED' || code === 'INVALID_INPUT' || code === 'BUDGET_EXCEEDED'
    || code === 'MCP_AUTH_ERROR' || code === 'MCP_PROTOCOL_ERROR') return false;
  if (descriptor.retry?.shouldRetry !== undefined) return descriptor.retry.shouldRetry(error);
  return RETRYABLE_CODES.has(code);
}

function validateResult(value: SourceSubagentResult, source: SourceSubagentDescriptor['subagentType']): SourceSubagentResult {
  if (typeof value !== 'object' || value === null || value.source !== source
    || !['complete', 'partial', 'unavailable'].includes(value.status)
    || typeof value.summary !== 'string' || !Array.isArray(value.findings)
    || !Array.isArray(value.evidenceIds) || !Array.isArray(value.businessTraceIds)
    || !Array.isArray(value.missingEvidence)
    || !Number.isFinite(value.coverage) || value.coverage < 0 || value.coverage > 1
    || !Number.isSafeInteger(value.toolCallsUsed) || value.toolCallsUsed < 0
    || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
    throw new SourceToolFailure('MCP_PROTOCOL_ERROR', 'Source subagent returned an invalid result.', false);
  }
  return {
    ...value,
    summary: truncateUtf8(value.summary, MAX_SUMMARY_BYTES),
    findings: value.findings.slice(0, MAX_ITEMS).map(normalizeFinding),
    evidenceIds: uniqueStrings(value.evidenceIds),
    businessTraceIds: uniqueStrings(value.businessTraceIds, MAX_TRACE_ID_CHARS),
    missingEvidence: uniqueStrings(value.missingEvidence, MAX_STATEMENT_CHARS),
  };
}

function normalizeFinding(value: SourceFinding): SourceFinding {
  if (typeof value !== 'object' || value === null || (value.kind !== 'observation' && value.kind !== 'inference')
    || typeof value.statement !== 'string' || !Array.isArray(value.evidenceIds)) {
    throw new SourceToolFailure('MCP_PROTOCOL_ERROR', 'Source subagent returned an invalid finding.', false);
  }
  return {
    kind: value.kind,
    statement: value.statement.slice(0, MAX_STATEMENT_CHARS),
    evidenceIds: uniqueStrings(value.evidenceIds),
  };
}

function flattenResult(result: SourceSubagentResult): ToolResponse {
  return {
    blocks: [
      { type: 'json', value: result },
      ...result.evidenceIds.map((evidenceId) => ({ type: 'evidence_ref' as const, evidenceId })),
    ],
    evidenceIds: [...result.evidenceIds],
    ...(result.status === 'unavailable' ? { isError: true } : {}),
  };
}

function sanitizeChunk(chunk: ToolResponseChunk): ToolResponseChunk {
  if (chunk.type === 'progress') return { ...chunk, message: truncateUtf8(chunk.message, 512) };
  if (chunk.type === 'text_delta') return { ...chunk, delta: truncateUtf8(chunk.delta, 4_096) };
  return { type: 'event', name: truncateUtf8(chunk.name, 128), payload: {} };
}

async function publishLifecycle<T extends keyof AgentEventPayloadMap>(
  lifecycle: SourceSubagentDescriptor['lifecycle'],
  type: T,
  execution: SourceSubagentExecution,
  payload: AgentEventPayloadMap[T],
  attempt?: number,
): Promise<void> {
  if (lifecycle === undefined) return;
  const context = {
    runId: execution.childRunId,
    ...(execution.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
    ...(execution.replyId === undefined ? {} : { replyId: execution.replyId }),
    ...(execution.streamId === undefined ? {} : { streamId: execution.streamId }),
    stepId: execution.parentStepId,
    toolCallId: execution.parentToolCallId,
    parentRunId: execution.parentRunId,
    ...(attempt === undefined ? {} : { attemptId: `subattempt:${execution.childRunId}:${attempt}` }),
    correlationId: lifecycle.correlationId(execution.parentRunId),
    visibility: 'audit' as const,
    durability: 'durable' as const,
  };
  try {
    await lifecycle.publisher.publish(lifecycle.factory.create(type, context, payload)).then(() => undefined);
  } catch {
    // Observability is best effort and must not prevent local evidence/result handling.
  }
}

type LifecycleErrorCode =
  | 'MODEL_ERROR'
  | 'STORAGE_ERROR'
  | 'MCP_NETWORK_ERROR'
  | 'MCP_TIMEOUT'
  | 'MCP_RATE_LIMITED'
  | 'MCP_SERVER_ERROR'
  | 'MCP_AUTH_ERROR'
  | 'MCP_PROTOCOL_ERROR'
  | 'CIRCUIT_OPEN'
  | 'TIMEOUT'
  | 'UNAVAILABLE';

function errorPayload(code: LifecycleErrorCode, message: string, retryable: boolean) {
  return { code, message, retryable };
}

function lifecycleErrorCode(code: AgentErrorCode): LifecycleErrorCode {
  const allowed = new Set<LifecycleErrorCode>([
    'MODEL_ERROR', 'STORAGE_ERROR', 'MCP_NETWORK_ERROR', 'MCP_TIMEOUT', 'MCP_RATE_LIMITED',
    'MCP_SERVER_ERROR', 'MCP_AUTH_ERROR', 'MCP_PROTOCOL_ERROR', 'CIRCUIT_OPEN', 'TIMEOUT', 'UNAVAILABLE',
  ]);
  return allowed.has(code as LifecycleErrorCode) ? code as LifecycleErrorCode : 'UNAVAILABLE';
}

function errorCode(error: unknown): AgentErrorCode {
  if (isAgentErrorLike(error)) {
    const allowed = new Set<AgentErrorCode>([
      'ABORTED', 'BUDGET_EXCEEDED', 'CONFIRMATION_EXPIRED', 'INVALID_INPUT', 'LOOP_DETECTED', 'MODEL_ERROR',
      'STORAGE_ERROR', 'TOOL_ERROR', 'TOOL_NOT_FOUND', 'TOOL_ARGUMENTS_PARSE_FAILED', 'TOOL_ARGUMENTS_SCHEMA_INVALID',
      'TOOL_ARGUMENTS_SEMANTIC_INVALID', 'POLICY_DENIED', 'MCP_NETWORK_ERROR', 'MCP_TIMEOUT', 'MCP_RATE_LIMITED',
      'MCP_SERVER_ERROR', 'MCP_AUTH_ERROR', 'MCP_PROTOCOL_ERROR', 'CIRCUIT_OPEN', 'TIMEOUT', 'UNAVAILABLE', 'USER_REJECTED',
    ]);
    if (allowed.has(error.code)) return error.code;
  }
  return 'UNAVAILABLE';
}

function safeErrorMessage(error: unknown): string {
  return `Source subagent failed (${errorCode(error)}).`;
}

function toSourceToolFailure(error: unknown, code: AgentErrorCode): SourceToolFailure {
  if (error instanceof SourceToolFailure) return error;
  return new SourceToolFailure(code, safeErrorMessage(error), isAgentErrorLike(error) && error.retryable);
}

function toAgentError(error: unknown, fallback: AgentErrorCode) {
  if (isAgentErrorLike(error)) return { code: error.code, message: error.message, retryable: error.retryable };
  return { code: fallback, message: 'Invalid source subagent input.', retryable: false };
}

function isAgentErrorLike(value: unknown): value is { code: AgentErrorCode; message: string; retryable: boolean } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown; retryable?: unknown };
  return typeof candidate.code === 'string' && typeof candidate.message === 'string' && typeof candidate.retryable === 'boolean';
}

function isSourceSubagentFailure(value: unknown): value is { partialResult?: SourceSubagentResult; code: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; partialResult?: unknown; code?: unknown };
  return candidate.name === 'SourceSubagentFailure'
    && (candidate.partialResult === undefined || typeof candidate.partialResult === 'object')
    && typeof candidate.code === 'string';
}

function isToolInputSchemaForSemantic(value: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'profileId');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SourceToolFailure('ABORTED', 'Source subagent was aborted.', false);
}

function resolveDelay(value: SourceSubagentRetryPolicy['delayMs'] | undefined, attempt: number): number {
  const delay = typeof value === 'function' ? value(attempt) : 0;
  if (!Number.isFinite(delay) || delay < 0) throw new SourceToolFailure('INVALID_INPUT', 'Retry delay is invalid.', false);
  return delay;
}

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SourceToolFailure('ABORTED', 'Source subagent was aborted.', false));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new SourceToolFailure('ABORTED', 'Source subagent was aborted.', false));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function uniqueStrings(values: readonly unknown[], maxChars = MAX_SUMMARY_BYTES): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.slice(0, maxChars)))].slice(0, MAX_ITEMS);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  for (const character of Array.from(value)) {
    const next = result + character;
    if (Buffer.byteLength(next, 'utf8') > maxBytes) break;
    result = next;
  }
  return result;
}

class SourceToolFailure extends Error {
  public constructor(
    public readonly code: AgentErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SourceToolFailure';
  }
}
