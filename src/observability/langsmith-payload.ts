import type { SpanStart } from '../contracts/index.js';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const eventNamePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const safeTags = new Set(['agentops', 'event-v2', 'inspection-smoke']);

const metadataStringFields = new Set([
  'profile', 'purpose', 'provider', 'model', 'eventType', 'source', 'status', 'outcome', 'stage',
  'subagentType', 'toolName', 'finishReason', 'code', 'category', 'reasonCode', 'terminalStatus',
  'usageCompleteness',
]);
const metadataNumberFields = new Set(['attempt', 'durationMs', 'ttftMs', 'retryCount', 'inputTokens', 'outputTokens']);
const metadataBooleanFields = new Set(['cacheHit', 'retryable', 'orphan', 'continuedAfterPause']);
const outputStringFields = new Set([
  'status', 'outcome', 'stage', 'code', 'category', 'reasonCode', 'terminalStatus', 'finishReason', 'usageCompleteness',
]);
const outputNumberFields = new Set(['durationMs', 'ttftMs', 'retryCount']);
const inputStringFields = new Set(['profile', 'purpose', 'stage']);

export interface SafeLangSmithSpanStart {
  readonly name: string;
  readonly inputs: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly tags: string[];
}

export function toSafeLangSmithSpanStart(input: SpanStart, tags: readonly string[] = []): SafeLangSmithSpanStart {
  const fields: Record<string, unknown> = {
    agentRunId: input.runId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.replyId === undefined ? {} : { replyId: input.replyId }),
    ...(input.streamId === undefined ? {} : { streamId: input.streamId }),
    ...(input.spanKey === undefined ? {} : { spanKey: input.spanKey }),
    ...(input.parentSpanKey === undefined ? {} : { parentSpanKey: input.parentSpanKey }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    ...(input.attributes ?? {}),
  };

  return {
    name: safeSpanName(input.name),
    inputs: safeInputMap(input.input),
    metadata: toSafeLangSmithMetadata(fields),
    tags: tags.filter((tag) => safeTags.has(tag)),
  };
}

export function toSafeLangSmithMetadata(fields: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'eventType' && isSafeEventName(value)) metadata[key] = value;
    else if (metadataStringFields.has(key) && isSafeIdentifier(value)) metadata[key] = value;
    else if (metadataNumberFields.has(key) && isSafeCounter(value)) metadata[key] = value;
    else if (metadataBooleanFields.has(key) && typeof value === 'boolean') metadata[key] = value;
    else if ((key === 'evidenceIds' || key === 'missingEvidenceCodes') && Array.isArray(value)) {
      const safeItems = value.filter(isSafeIdentifier).slice(0, 100);
      if (safeItems.length > 0) metadata[key] = [...new Set(safeItems)];
    } else if (key === 'coverage' && isRecord(value)) {
      const coverage = safeNumericBooleanMap(value);
      if (Object.keys(coverage).length > 0) metadata[key] = coverage;
    } else if (key === 'budget' && isRecord(value)) {
      const budget = safeBudget(value);
      if (budget !== undefined) metadata[key] = budget;
    }
  }

  const provider = metadata.provider;
  const model = metadata.model;
  if (typeof provider === 'string') metadata.ls_provider = provider;
  if (typeof model === 'string') metadata.ls_model_name = model;
  return metadata;
}

export function toSafeLangSmithOutput(output: unknown): Record<string, unknown> {
  if (!isRecord(output)) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output)) {
    if (outputStringFields.has(key) && isSafeIdentifier(value)) safe[key] = value;
    else if (outputNumberFields.has(key) && isSafeCounter(value)) safe[key] = value;
    else if (key === 'cacheHit' && typeof value === 'boolean') safe[key] = value;
    else if ((key === 'evidenceIds' || key === 'missingEvidenceCodes') && Array.isArray(value)) {
      const safeItems = value.filter(isSafeIdentifier).slice(0, 100);
      if (safeItems.length > 0) safe[key] = [...new Set(safeItems)];
    } else if (key === 'coverage' && isRecord(value)) {
      const coverage = safeNumericBooleanMap(value);
      if (Object.keys(coverage).length > 0) safe[key] = coverage;
    } else if (key === 'usage') {
      const usage = toCanonicalUsageMetadata(value);
      if (usage !== undefined) safe.usage_metadata = usage;
    }
  }
  return safe;
}

export function toSafeLangSmithError(error: unknown): string {
  void error;
  return 'TRACE_ERROR';
}

export function toCanonicalUsageMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = safeTokenCount(value.inputTokens);
  const outputTokens = safeTokenCount(value.outputTokens);
  const cachedInputTokens = safeTokenCount(value.cachedInputTokens);
  const usage: Record<string, unknown> = {};
  if (inputTokens !== undefined) usage.input_tokens = inputTokens;
  if (outputTokens !== undefined) usage.output_tokens = outputTokens;
  if (inputTokens !== undefined && outputTokens !== undefined
    && Number.isSafeInteger(inputTokens + outputTokens)) {
    usage.total_tokens = inputTokens + outputTokens;
  }
  if (inputTokens !== undefined && cachedInputTokens !== undefined && cachedInputTokens <= inputTokens) {
    usage.input_token_details = { cache_read: cachedInputTokens };
  }
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function safeInputMap(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (inputStringFields.has(key) && isSafeIdentifier(item)) result[key] = item;
  }
  return result;
}

function safeSpanName(value: string): string {
  if (value === 'agent.run') return value;
  const match = /^(model|tool|subagent)\.([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/u.exec(value);
  return match === null ? 'agent.span' : `${match[1]}.${match[2]}`;
}

function safeBudget(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = value.type;
  const limit = value.limit;
  const used = value.used;
  if (!isSafeIdentifier(type) || !isSafeCounter(limit) || !isSafeCounter(used)) return undefined;
  return { type, limit, used };
}

function safeNumericBooleanMap(value: Record<string, unknown>): Record<string, number | boolean> {
  const safe: Record<string, number | boolean> = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (isSafeIdentifier(key) && (typeof item === 'boolean' || isSafeCounter(item))) safe[key] = item;
  }
  return safe;
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifierPattern.test(value);
}

function isSafeEventName(value: unknown): value is string {
  return typeof value === 'string' && eventNamePattern.test(value);
}

function isSafeCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safeTokenCount(value: unknown): number | undefined {
  return isSafeCounter(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
