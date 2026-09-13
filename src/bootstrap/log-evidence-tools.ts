import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  assertEvidenceCaptureBudget,
  canonicalJson,
  type EvidenceCaptureBudget,
  type EvidenceCaptureResult,
  type EvidenceManifestStore,
  type EvidenceSourcePage,
  type LogEvidenceAggregation,
  type LogEvidenceFilter,
  type LogEvidenceReadPage,
  type LogEvidenceReader,
  type NormalizedLogRecord,
  type StreamingEvidenceRecorder,
  type Tool,
  type ToolCallOptions,
  type ToolResponse,
} from '../contracts/index.js';
import { SourceFailure } from '../mcp/resilience.js';
import type { ElkEvidenceQuery } from '../infrastructure/elk/paged-evidence-source.js';

const DEFAULT_MAX_MODEL_BYTES = 16 * 1024;
const MAX_RECORD_FIELD_CHARS = 1_024;
const MAX_READ_LIMIT = 20;

export type { LogEvidenceAggregation, LogEvidenceFilter, LogEvidenceReadPage, LogEvidenceReader } from '../contracts/log-evidence.js';

export interface LogEvidenceToolOptions {
  source: LogEvidencePageSource;
  recorder: StreamingEvidenceRecorder;
  manifests: EvidenceManifestStore;
  reader: LogEvidenceReader;
  budget: EvidenceCaptureBudget;
  id?: () => string;
  maxModelBytes?: number;
}

/** Source seam used by the Tool factory; PagedEvidenceSource is only one implementation. */
export interface LogEvidencePageSource {
  pages(query: ElkEvidenceQuery, options?: { signal?: AbortSignal }): AsyncIterable<EvidenceSourcePage>;
}

const captureInput = z.object({
  service: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
});

const filterInput = {
  service: z.string().min(1).optional(),
  level: z.string().min(1).optional(),
  exception: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  contains: z.string().min(1).optional(),
};

const searchInput = z.object({
  evidenceId: z.string().min(1),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
  ...filterInput,
});

const aggregateInput = z.object({
  evidenceId: z.string().min(1),
  topN: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
  ...filterInput,
});

const sliceInput = z.object({
  evidenceId: z.string().min(1),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
  ...filterInput,
});

/** Creates ordinary evidence Tools. The reader is the only port allowed to inspect committed Blob data. */
export function createLogEvidenceTools(options: LogEvidenceToolOptions): readonly Tool[] {
  assertEvidenceCaptureBudget(options.budget);
  const id = options.id ?? randomUUID;
  const maxModelBytes = options.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES;
  if (!Number.isSafeInteger(maxModelBytes) || maxModelBytes <= 0) throw new RangeError('maxModelBytes must be positive');

  const capture: Tool = {
    name: 'logs.capture',
    description: '按服务和时间窗口分页采集 ELK 日志，保存为可追溯证据并返回有界摘要。',
    kind: 'evidence',
    source: 'mcp',
    inputSchema: captureInput,
    recoveryPolicy: 'verify_before_retry',
    isConcurrencySafe: () => false,
    userFacingLabel: () => '采集日志证据',
    validateSemantics: (input) => {
      try {
        toCaptureQuery(input);
        return { valid: true, value: input };
      } catch {
        return { valid: false, error: newAgentInputError() };
      }
    },
    call: async (input, callOptions) => {
      const query = toCaptureQuery(input);
      requireToolCallId(callOptions);
      throwIfAborted(callOptions.signal);
      const evidenceId = id();
      const queryDigest = digest(query);
      let result: EvidenceCaptureResult;
      try {
        result = await options.recorder.capture({
          evidenceId,
          runId: callOptions.runId,
          stepId: callOptions.stepId,
          toolCallId: callOptions.toolCallId!,
          captureKey: `log:${callOptions.runId}:${callOptions.toolCallId}:${queryDigest}`,
          source: 'log',
          queryDigest,
          timeRange: { start: query.start, end: query.end },
          pages: options.source.pages(query, { signal: callOptions.signal }),
          budget: options.budget,
        }, { signal: callOptions.signal });
      } catch (error) {
        throw normalizeCaptureError(error);
      }
      if (result.evidenceId !== evidenceId || result.manifest.evidenceId !== evidenceId
        || result.manifest.runId !== callOptions.runId || result.manifest.source !== 'log') {
        throw new SourceFailure('POLICY_DENIED');
      }
      throwIfAborted(callOptions.signal);
      const value = boundedCaptureView(result, maxModelBytes);
      return {
        blocks: [{ type: 'json', value }, { type: 'evidence_ref', evidenceId }],
        evidenceIds: [evidenceId],
      } satisfies ToolResponse;
    },
  };

  const search = createReadTool({
    manifests: options.manifests,
    name: 'logs.search_evidence',
    description: '在当前 Run 已提交的日志证据中按结构化条件检索有界样本。',
    inputSchema: searchInput,
    recoveryPolicy: 'replay_safe',
    userFacingLabel: () => '检索日志证据',
    invoke: (input, callOptions) => options.reader.search({
      ...readRequest(input, callOptions),
      limit: asLimit(input.limit),
    }),
    render: (evidenceId, page) => ({
      evidenceId,
      records: boundedRecords(page.records, maxModelBytes),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    }),
  });

  const aggregate: Tool = {
    name: 'logs.aggregate_evidence',
    description: '对当前 Run 的日志证据执行确定性聚合，返回等级、服务、异常和 Trace ID 统计。',
    kind: 'evidence',
    source: 'mcp',
    inputSchema: aggregateInput,
    recoveryPolicy: 'replay_safe',
    isConcurrencySafe: () => true,
    userFacingLabel: () => '聚合日志证据',
    call: async (input, callOptions) => {
      const parsed = parseObject(aggregateInput, input);
      const evidenceId = requiredString(parsed.evidenceId);
      await assertVisibleEvidence(options.manifests, evidenceId, callOptions.runId);
      throwIfAborted(callOptions.signal);
      const filter = toFilter(parsed);
      const result = await options.reader.aggregate({
        evidenceId,
        runId: callOptions.runId,
        ...(filter === undefined ? {} : { filter }),
        topN: asLimit(parsed.topN),
        signal: callOptions.signal,
      });
      throwIfAborted(callOptions.signal);
      return {
        blocks: [{ type: 'json', value: boundedAggregation(evidenceId, result, maxModelBytes) }],
        evidenceIds: [evidenceId],
      } satisfies ToolResponse;
    },
  };

  const slice = createReadTool({
    manifests: options.manifests,
    name: 'logs.read_evidence_slice',
    description: '读取当前 Run 日志证据的少量脱敏样本；不返回 Blob 路径或存储键。',
    inputSchema: sliceInput,
    recoveryPolicy: 'replay_safe',
    userFacingLabel: () => '读取日志样本',
    invoke: (input, callOptions) => options.reader.readSlice({
      ...readRequest(input, callOptions),
      limit: asLimit(input.limit),
    }),
    render: (evidenceId, page) => ({
      evidenceId,
      records: boundedRecords(page.records, maxModelBytes),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    }),
  });

  return Object.freeze([capture, search, aggregate, slice]);
}

function createReadTool(input: {
  manifests: EvidenceManifestStore;
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  recoveryPolicy: 'replay_safe';
  userFacingLabel: (value: Record<string, unknown>) => string;
  invoke: (value: Record<string, unknown>, options: ToolCallOptions) => Promise<LogEvidenceReadPage>;
  render: (evidenceId: string, page: LogEvidenceReadPage) => unknown;
}): Tool {
  return {
    name: input.name,
    description: input.description,
    kind: 'evidence',
    source: 'mcp',
    inputSchema: input.inputSchema,
    recoveryPolicy: input.recoveryPolicy,
    isConcurrencySafe: () => true,
    userFacingLabel: input.userFacingLabel,
    call: async (value, callOptions) => {
      const parsed = parseObject(input.inputSchema, value);
      const evidenceId = requiredString(parsed.evidenceId);
      await assertVisibleEvidence(input.manifests, evidenceId, callOptions.runId);
      throwIfAborted(callOptions.signal);
      const page = await input.invoke(parsed, callOptions);
      throwIfAborted(callOptions.signal);
      return { blocks: [{ type: 'json', value: input.render(evidenceId, page) }], evidenceIds: [evidenceId] } satisfies ToolResponse;
    },
  };
}

function toCaptureQuery(input: Record<string, unknown>): ElkEvidenceQuery {
  const parsed = parseObject(captureInput, input);
  const service = requiredString(parsed.service);
  const start = requiredString(parsed.start);
  const end = requiredString(parsed.end);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  return { service, start, end };
}

function parseObject(schema: z.ZodObject<z.ZodRawShape>, input: Record<string, unknown>): Record<string, unknown> {
  const parsed = schema.strict().safeParse(input);
  if (!parsed.success) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  return parsed.data;
}

function toFilter(input: Record<string, unknown>): LogEvidenceFilter | undefined {
  const filter: LogEvidenceFilter = {};
  for (const key of ['service', 'level', 'exception', 'traceId', 'contains'] as const) {
    const value = input[key];
    if (typeof value === 'string') filter[key] = value;
  }
  return Object.keys(filter).length === 0 ? undefined : filter;
}

function readRequest(input: Record<string, unknown>, callOptions: ToolCallOptions) {
  const evidenceId = requiredString(input.evidenceId);
  const filter = toFilter(input);
  return {
    evidenceId,
    runId: callOptions.runId,
    ...(filter === undefined ? {} : { filter }),
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    signal: callOptions.signal,
  };
}

function asLimit(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_READ_LIMIT
    ? value
    : MAX_READ_LIMIT;
}

async function assertVisibleEvidence(manifests: EvidenceManifestStore, evidenceId: string, runId: string): Promise<void> {
  const visible = await manifests.getVisible(evidenceId);
  if (visible === null || visible.source !== 'log' || visible.runId !== runId) throw new SourceFailure('POLICY_DENIED');
}

function boundedCaptureView(result: EvidenceCaptureResult, maxBytes: number): Record<string, unknown> {
  const value: Record<string, unknown> = {
    status: result.manifest.state,
    evidenceId: result.evidenceId,
    recordCount: result.summary.recordCount,
    sourceBytes: result.summary.sourceBytes,
    coverage: result.coverage,
    truncated: result.truncated,
    missingEvidence: [...result.missingEvidence],
    levels: result.summary.levels,
    services: result.summary.services,
    exceptionSignatures: result.summary.exceptionSignatures,
    traceIds: result.summary.traceIds,
    samples: boundedRecords(result.summary.samples, maxBytes),
  };
  return fitBounded(value, maxBytes, 'samples');
}

function boundedAggregation(evidenceId: string, result: LogEvidenceAggregation, maxBytes: number): Record<string, unknown> {
  const value: Record<string, unknown> = {
    evidenceId,
    recordCount: result.recordCount,
    levels: result.levels,
    services: result.services,
    exceptionSignatures: result.exceptionSignatures,
    traceIds: result.traceIds.slice(0, 100),
  };
  return fitBounded(value, maxBytes, 'traceIds');
}

function boundedRecords(records: readonly NormalizedLogRecord[], maxBytes: number): NormalizedLogRecord[] {
  const safe: NormalizedLogRecord[] = [];
  for (const record of records.slice(0, MAX_READ_LIMIT)) {
    safe.push(sanitizeRecord(record));
    if (byteLength({ records: safe }) > maxBytes) safe.pop();
  }
  return safe;
}

function sanitizeRecord(record: NormalizedLogRecord): NormalizedLogRecord {
  if (typeof record.timestamp !== 'string' || Number.isNaN(Date.parse(record.timestamp))) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  for (const key of ['service', 'level', 'message', 'exception', 'traceId'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') throw new SourceFailure('MCP_PROTOCOL_ERROR');
  }
  return {
    timestamp: record.timestamp.slice(0, MAX_RECORD_FIELD_CHARS),
    ...(record.service === undefined ? {} : { service: record.service.slice(0, MAX_RECORD_FIELD_CHARS) }),
    ...(record.level === undefined ? {} : { level: record.level.slice(0, MAX_RECORD_FIELD_CHARS) }),
    ...(record.message === undefined ? {} : { message: record.message.slice(0, MAX_RECORD_FIELD_CHARS) }),
    ...(record.exception === undefined ? {} : { exception: record.exception.slice(0, MAX_RECORD_FIELD_CHARS) }),
    ...(record.traceId === undefined ? {} : { traceId: record.traceId.slice(0, MAX_RECORD_FIELD_CHARS) }),
  };
}

function fitBounded(value: Record<string, unknown>, maxBytes: number, removableArray: string): Record<string, unknown> {
  const array = value[removableArray];
  if (Array.isArray(array)) {
    while (byteLength(value) > maxBytes && array.length > 0) array.pop();
  }
  if (byteLength(value) > maxBytes) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  return value;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  return value;
}

function requireToolCallId(options: ToolCallOptions): void {
  if (options.toolCallId === undefined || options.toolCallId.trim().length === 0) throw new SourceFailure('STORAGE_ERROR');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SourceFailure('ABORTED');
}

function normalizeCaptureError(error: unknown): unknown {
  if (error instanceof SourceFailure) return error;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ABORTED' || code === 'BUDGET_EXCEEDED' || code === 'MCP_PROTOCOL_ERROR' || code === 'STORAGE_ERROR') {
      return new SourceFailure(code);
    }
  }
  return error;
}

function newAgentInputError() {
  return { code: 'INVALID_INPUT' as const, message: 'Invalid log evidence query.', retryable: false };
}
