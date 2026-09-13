import { createHash } from 'node:crypto';
import { randomIdGenerator, systemClock, type Clock, type IdGenerator } from '../contracts/common.js';
import { canonicalJson, assertEvidenceCaptureBudget } from '../contracts/index.js';
import type { EvidenceRecorderEventChannel } from './evidence-recorder.js';
import type {
  CommitEvidenceManifestInput,
  EvidenceBlobStore,
  EvidenceCaptureResult,
  EvidenceManifest,
  EvidenceManifestStore,
  EvidenceSourcePage,
  EvidenceSummary,
  EvidenceChunkRef,
  NormalizedLogRecord,
  StreamingEvidenceCaptureRequest,
  StreamingEvidenceRecorder,
} from '../contracts/index.js';

const DEFAULT_PAGE_BYTES = 512 * 1024;
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_SUMMARY_BYTES = 16 * 1024;
const DEFAULT_SAMPLE_BYTES = 2 * 1024;
const DEFAULT_REDACTION_POLICY = 'redaction/v1';
const MAX_TOP_VALUES = 20;
const MAX_TRACE_IDS = 100;

export type StreamingEvidenceErrorCode = 'ABORTED' | 'BUDGET_EXCEEDED' | 'MCP_PROTOCOL_ERROR' | 'STORAGE_ERROR';

export class StreamingEvidenceCaptureError extends Error {
  public readonly retryable: boolean;

  public constructor(
    public readonly code: StreamingEvidenceErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StreamingEvidenceCaptureError';
    this.retryable = code === 'STORAGE_ERROR';
  }
}

export type EvidenceRecordRedactor = (record: NormalizedLogRecord) => NormalizedLogRecord;

export interface StreamingEvidenceRecorderOptions {
  blobStore: EvidenceBlobStore;
  manifests: EvidenceManifestStore;
  clock?: Clock;
  ids?: IdGenerator;
  maxPageBytes?: number;
  chunkTargetBytes?: number;
  redactionPolicyVersion?: string;
  redactor?: EvidenceRecordRedactor;
  events?: EvidenceRecorderEventChannel;
}

export class DefaultStreamingEvidenceRecorder implements StreamingEvidenceRecorder {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly maxPageBytes: number;
  private readonly chunkTargetBytes: number;
  private readonly redactionPolicyVersion: string;
  private readonly redactor: EvidenceRecordRedactor;

  public constructor(private readonly options: StreamingEvidenceRecorderOptions) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIdGenerator;
    this.maxPageBytes = options.maxPageBytes ?? DEFAULT_PAGE_BYTES;
    this.chunkTargetBytes = options.chunkTargetBytes ?? DEFAULT_CHUNK_BYTES;
    this.redactionPolicyVersion = options.redactionPolicyVersion ?? DEFAULT_REDACTION_POLICY;
    this.redactor = options.redactor ?? defaultRedactor;
    if (!Number.isSafeInteger(this.maxPageBytes) || this.maxPageBytes <= 0) throw new RangeError('maxPageBytes must be positive');
    if (!Number.isSafeInteger(this.chunkTargetBytes) || this.chunkTargetBytes <= 0) throw new RangeError('chunkTargetBytes must be positive');
  }

  public async capture(
    request: StreamingEvidenceCaptureRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<EvidenceCaptureResult> {
    validateRequest(request);
    assertEvidenceCaptureBudget(request.budget);
    const signal = options.signal;
    throwIfAborted(signal);
    const existing = await this.options.manifests.get(request.evidenceId);
    if (existing !== null && existing.state !== 'pending') {
      if (existing.state === 'committed' || existing.state === 'partial') {
        if (existing.summary === undefined) throw new StreamingEvidenceCaptureError('STORAGE_ERROR', 'Visible Evidence Manifest has no summary');
        await this.publishEvidenceEvent(existing, existing.summary);
        return toCaptureResult(existing, existing.summary);
      }
      throw new StreamingEvidenceCaptureError('STORAGE_ERROR', 'Evidence Manifest is not resumable');
    }

    const manifestId = existing?.manifestId ?? this.ids.next('manifest');
    const pending = await this.options.manifests.createPending({
      manifestId,
      evidenceId: request.evidenceId,
      runId: request.runId,
      stepId: request.stepId,
      toolCallId: request.toolCallId,
      captureKey: request.captureKey,
      source: request.source,
      queryDigest: request.queryDigest,
      timeRange: request.timeRange,
      compression: 'gzip_ndjson',
      redactionPolicyVersion: this.redactionPolicyVersion,
      createdAt: this.clock.now().toISOString(),
    });
    if (pending.state === 'committed' || pending.state === 'partial') {
      if (pending.summary === undefined) throw new StreamingEvidenceCaptureError('STORAGE_ERROR', 'Visible Evidence Manifest has no summary');
      await this.publishEvidenceEvent(pending, pending.summary);
      return toCaptureResult(pending, pending.summary);
    }
    if (pending.state !== 'pending') throw new StreamingEvidenceCaptureError('STORAGE_ERROR', 'Evidence Manifest is not writable');

    const startedAt = this.clock.now().getTime();
    const aggregateHash = createHash('sha256');
    const chunks: EvidenceChunkRef[] = [];
    const accumulator = new SummaryAccumulator(request.budget.maxSamples);
    let sourceBytes = 0;
    let recordCount = 0;
    let chunkPieces: Buffer[] = [];
    let chunkBytes = 0;
    let chunkRecordCount = 0;
    let chunkFirstTimestamp: string | undefined;
    let chunkLastTimestamp: string | undefined;
    let truncated = false;
    const missingEvidence: string[] = [];

    const flushChunk = async (nextCursor?: string, sourceSnapshotId?: string): Promise<void> => {
      if (chunkBytes === 0) return;
      const bytes = Buffer.concat(chunkPieces);
      const chunkIndex = chunks.length;
      const writer = await this.options.blobStore.begin({
        manifestId,
        evidenceId: request.evidenceId,
        captureKey: request.captureKey,
        source: request.source,
        chunkIndex,
        chunkTargetBytes: this.chunkTargetBytes,
        recordCount: chunkRecordCount,
        ...(chunkFirstTimestamp === undefined ? {} : { firstCapturedAt: chunkFirstTimestamp }),
        ...(chunkLastTimestamp === undefined ? {} : { lastCapturedAt: chunkLastTimestamp }),
      });
      try {
        await writer.write(bytes, signal === undefined ? {} : { signal });
        const descriptor = await writer.commit();
        const chunk = descriptor.chunks[0];
        if (chunk === undefined) throw new StreamingEvidenceCaptureError('STORAGE_ERROR', 'Blob writer returned no chunk');
        await this.options.manifests.recordChunk({
          evidenceId: request.evidenceId,
          chunk,
          ...(nextCursor === undefined ? {} : { nextCursor }),
          ...(sourceSnapshotId === undefined ? {} : { sourceSnapshotId }),
          updatedAt: this.clock.now().toISOString(),
        });
        aggregateHash.update(bytes);
        chunks.push(chunk);
      } catch (error) {
        await writer.abort('CHUNK_COMMIT_FAILED').catch(() => undefined);
        throw error;
      }
      chunkPieces = [];
      chunkBytes = 0;
      chunkRecordCount = 0;
      chunkFirstTimestamp = undefined;
      chunkLastTimestamp = undefined;
    };

    try {
      for await (const page of request.pages) {
        throwIfAborted(signal);
        validatePage(page, this.maxPageBytes);
        for (const sourceRecord of page.records) {
          throwIfAborted(signal);
          if (recordCount >= request.budget.maxRecords) {
            truncated = true;
            addMissing(missingEvidence, 'ELK_CAPTURE_RECORD_BUDGET_EXCEEDED');
            break;
          }
          if (this.clock.now().getTime() - startedAt >= request.budget.maxDurationMs) {
            truncated = true;
            addMissing(missingEvidence, 'ELK_CAPTURE_DURATION_BUDGET_EXCEEDED');
            break;
          }
          const normalized = this.redactor(sourceRecord);
          validateRecord(normalized);
          const encoded = Buffer.from(canonicalJson(normalized) + '\n', 'utf8');
          if (encoded.length > this.chunkTargetBytes) {
            throw new StreamingEvidenceCaptureError('MCP_PROTOCOL_ERROR', 'One normalized evidence record exceeds the Blob chunk target');
          }
          if (sourceBytes + encoded.length > request.budget.maxSourceBytes) {
            truncated = true;
            addMissing(missingEvidence, 'ELK_CAPTURE_BYTE_BUDGET_EXCEEDED');
            break;
          }
          if (chunkBytes + encoded.length > this.chunkTargetBytes) {
            await flushChunk();
          }
          chunkPieces.push(encoded);
          chunkBytes += encoded.length;
          chunkRecordCount += 1;
          if (chunkFirstTimestamp === undefined) chunkFirstTimestamp = normalized.timestamp;
          chunkLastTimestamp = normalized.timestamp;
          sourceBytes += encoded.length;
          recordCount += 1;
          accumulator.add(normalized, encoded.length);
        }
        if (truncated) {
          await flushChunk();
          break;
        }
        await flushChunk(page.nextCursor, page.sourceSnapshotId);
      }
      await flushChunk();
      if (chunks.length === 0) {
        throw new StreamingEvidenceCaptureError('BUDGET_EXCEEDED', 'Evidence capture produced no committed records', {
          category: 'empty_evidence',
        });
      }
      const summary = accumulator.build(request.budget.maxModelSummaryBytes);
      const coverage = calculateCoverage(request.timeRange, summary, truncated);
      return await this.commitCapture({
        manifestId,
        request,
        chunks,
        rawSha256: aggregateHash.digest('hex'),
        summary,
        coverage,
        truncated,
        missingEvidence,
      });
    } catch (error) {
      if (isAbort(error, signal)) {
        await this.options.manifests.markFailed({
          evidenceId: request.evidenceId,
          reasonCode: 'CAPTURE_ABORTED',
          updatedAt: this.clock.now().toISOString(),
        }).catch(() => undefined);
        throw new StreamingEvidenceCaptureError('ABORTED', 'Evidence capture aborted');
      }
      if (error instanceof StreamingEvidenceCaptureError && error.code !== 'MCP_PROTOCOL_ERROR' && error.code !== 'STORAGE_ERROR') {
        await this.options.manifests.markFailed({
          evidenceId: request.evidenceId,
          reasonCode: error.code,
          updatedAt: this.clock.now().toISOString(),
        }).catch(() => undefined);
        throw error;
      }
      if (chunks.length > 0 && !(error instanceof StreamingEvidenceCaptureError && error.code === 'STORAGE_ERROR')) {
        const sourceFailure = [...missingEvidence, 'ELK_SOURCE_FAILED'];
        const summary = accumulator.build(request.budget.maxModelSummaryBytes);
        const coverage = calculateCoverage(request.timeRange, summary, true);
        return await this.commitCapture({
          manifestId,
          request,
          chunks,
          rawSha256: aggregateHash.digest('hex'),
          summary,
          coverage,
          truncated: true,
          missingEvidence: unique(sourceFailure),
        });
      }
      await this.options.manifests.markFailed({
        evidenceId: request.evidenceId,
        reasonCode: error instanceof StreamingEvidenceCaptureError ? error.code : 'CAPTURE_FAILED',
        updatedAt: this.clock.now().toISOString(),
      }).catch(() => undefined);
      if (error instanceof StreamingEvidenceCaptureError) throw error;
      throw new StreamingEvidenceCaptureError('STORAGE_ERROR', 'Evidence capture failed');
    }
  }

  private async commitCapture(input: {
    manifestId: string;
    request: StreamingEvidenceCaptureRequest;
    chunks: readonly EvidenceChunkRef[];
    rawSha256: string;
    summary: EvidenceSummary;
    coverage: number;
    truncated: boolean;
    missingEvidence: readonly string[];
  }): Promise<EvidenceCaptureResult> {
    const now = this.clock.now().toISOString();
    const descriptor = {
      manifestId: input.manifestId,
      evidenceId: input.request.evidenceId,
      captureKey: input.request.captureKey,
      compression: 'gzip_ndjson' as const,
      sourceBytes: input.chunks.reduce((total, chunk) => total + chunk.sourceBytes, 0),
      storedBytes: input.chunks.reduce((total, chunk) => total + chunk.storedBytes, 0),
      rawSha256: input.rawSha256,
      chunks: input.chunks,
    };
    const commit: CommitEvidenceManifestInput = {
      evidenceId: input.request.evidenceId,
      descriptor,
      summary: input.summary,
      coverage: input.coverage,
      truncated: input.truncated,
      missingEvidence: unique(input.missingEvidence),
      updatedAt: now,
      committedAt: now,
    };
    const manifest = await this.options.manifests.commit(commit);
    if (manifest.summary === undefined || (manifest.state !== 'committed' && manifest.state !== 'partial')) {
      throw new StreamingEvidenceCaptureError('STORAGE_ERROR', 'Evidence Manifest was not visible after commit');
    }
    const visible = await this.options.manifests.getVisible(input.request.evidenceId);
    if (visible === null) throw new StreamingEvidenceCaptureError('STORAGE_ERROR', 'Evidence Manifest was not readable after commit');
    await this.publishEvidenceEvent(visible, manifest.summary);
    return {
      evidenceId: input.request.evidenceId,
      summary: manifest.summary,
      manifest: visible,
      coverage: visible.coverage,
      truncated: visible.truncated,
      missingEvidence: [...visible.missingEvidence],
    };
  }

  private async publishEvidenceEvent(
    manifest: Pick<EvidenceManifest, 'evidenceId' | 'runId' | 'stepId' | 'toolCallId' | 'source' | 'coverage' | 'updatedAt' | 'committedAt'>,
    summary: EvidenceSummary,
  ): Promise<void> {
    const events = this.options.events;
    if (events === undefined) return;
    const eventId = 'evidence-' + manifest.evidenceId;
    const existing = await events.store.findById(eventId);
    if (existing !== null) {
      if (existing.runId !== manifest.runId || existing.type !== 'EVIDENCE_COLLECTED') {
        throw new StreamingEvidenceCaptureError('STORAGE_ERROR', 'Evidence event identity collision');
      }
      return;
    }
    const pending = events.factory.create('EVIDENCE_COLLECTED', {
      runId: manifest.runId,
      correlationId: events.correlationId(manifest.runId),
      visibility: 'audit',
      durability: 'durable',
      stepId: manifest.stepId,
      toolCallId: manifest.toolCallId,
    }, {
      evidenceIds: [manifest.evidenceId],
      coverage: manifest.coverage,
      source: manifest.source,
      summary: canonicalJson(summary),
    });
    await events.publisher.publish({
      ...pending,
      eventId,
      timestamp: manifest.committedAt ?? manifest.updatedAt,
    });
  }
}

class SummaryAccumulator {
  private readonly levels = new Map<string, number>();
  private readonly services = new Map<string, number>();
  private readonly exceptions = new Map<string, number>();
  private readonly traces = new Set<string>();
  private readonly samples: NormalizedLogRecord[] = [];
  private recordCount = 0;
  private sourceBytes = 0;
  private firstTimestamp?: string;
  private lastTimestamp?: string;

  public constructor(private readonly maxSamples: number) {}

  public add(record: NormalizedLogRecord, encodedBytes: number): void {
    this.recordCount += 1;
    this.sourceBytes += encodedBytes;
    if (this.firstTimestamp === undefined || record.timestamp < this.firstTimestamp) this.firstTimestamp = record.timestamp;
    if (this.lastTimestamp === undefined || record.timestamp > this.lastTimestamp) this.lastTimestamp = record.timestamp;
    increment(this.levels, record.level);
    increment(this.services, record.service);
    increment(this.exceptions, record.exception);
    if (record.traceId !== undefined && this.traces.size < MAX_TRACE_IDS) this.traces.add(record.traceId);
    if (this.samples.length < this.maxSamples) this.samples.push(sampleRecord(record));
  }

  public build(maxBytes: number): EvidenceSummary {
    const summary: EvidenceSummary = {
      recordCount: this.recordCount,
      sourceBytes: this.sourceBytes,
      ...(this.firstTimestamp === undefined ? {} : { firstTimestamp: this.firstTimestamp }),
      ...(this.lastTimestamp === undefined ? {} : { lastTimestamp: this.lastTimestamp }),
      levels: topCounts(this.levels),
      services: topCounts(this.services),
      exceptionSignatures: topCounts(this.exceptions),
      traceIds: [...this.traces].sort().slice(0, MAX_TRACE_IDS),
      samples: this.samples.map((record) => structuredClone(record)),
    };
    return boundSummary(summary, maxBytes);
  }
}

function defaultRedactor(record: NormalizedLogRecord): NormalizedLogRecord {
  return {
    ...record,
    ...(record.service === undefined ? {} : { service: redactText(record.service) }),
    ...(record.level === undefined ? {} : { level: redactText(record.level) }),
    ...(record.message === undefined ? {} : { message: redactText(record.message) }),
    ...(record.exception === undefined ? {} : { exception: redactText(record.exception) }),
    ...(record.traceId === undefined ? {} : { traceId: redactText(record.traceId) }),
    ...(record.fields === undefined ? {} : { fields: redactFields(record.fields) }),
  };
}

function redactFields(fields: Record<string, import('../contracts/common.js').JsonValue>): Record<string, import('../contracts/common.js').JsonValue> {
  const output: Record<string, import('../contracts/common.js').JsonValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/authorization|cookie|password|passwd|secret|token|api[-_]?key/i.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = redactValue(value);
    }
  }
  return output;
}

function redactValue(value: import('../contracts/common.js').JsonValue): import('../contracts/common.js').JsonValue {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const output: Record<string, import('../contracts/common.js').JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i.test(key)
        ? '[REDACTED]'
        : redactValue(item);
    }
    return output;
  }
  return value;
}

function redactText(value: string): string {
  return /\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}/i.test(value) ? '[REDACTED]' : value;
}

function sampleRecord(record: NormalizedLogRecord): NormalizedLogRecord {
  const sample = structuredClone(record);
  if (sample.message !== undefined) sample.message = truncateUtf8(sample.message, DEFAULT_SAMPLE_BYTES);
  if (sample.fields !== undefined) delete sample.fields;
  return sample;
}

function boundSummary(summary: EvidenceSummary, maxBytes: number): EvidenceSummary {
  const candidate = structuredClone(summary);
  while (serializedBytes(candidate) > maxBytes && candidate.samples.length > 0) candidate.samples = candidate.samples.slice(0, -1);
  while (serializedBytes(candidate) > maxBytes && candidate.traceIds.length > 0) candidate.traceIds = candidate.traceIds.slice(0, -1);
  while (serializedBytes(candidate) > maxBytes && candidate.exceptionSignatures.length > 0) candidate.exceptionSignatures = candidate.exceptionSignatures.slice(0, -1);
  while (serializedBytes(candidate) > maxBytes && candidate.services.length > 0) candidate.services = candidate.services.slice(0, -1);
  while (serializedBytes(candidate) > maxBytes && candidate.levels.length > 0) candidate.levels = candidate.levels.slice(0, -1);
  if (serializedBytes(candidate) > maxBytes) {
    throw new StreamingEvidenceCaptureError('BUDGET_EXCEEDED', 'Evidence summary exceeds the model budget', {
      category: 'evidence_summary_too_large',
    });
  }
  return candidate;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

function topCounts(values: Map<string, number>): EvidenceSummary['levels'] {
  return [...values.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_TOP_VALUES)
    .map(([value, count]) => ({ value, count }));
}

function increment(values: Map<string, number>, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  values.set(value, (values.get(value) ?? 0) + 1);
}

function calculateCoverage(
  range: { start: string; end: string },
  summary: EvidenceSummary,
  truncated: boolean,
): number {
  if (!truncated) return 1;
  if (summary.lastTimestamp === undefined) return 0;
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  const observed = Date.parse(summary.lastTimestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(observed) || end <= start) return 0;
  return Math.max(0, Math.min(1, (observed - start) / (end - start)));
}

function validateRequest(request: StreamingEvidenceCaptureRequest): void {
  for (const [name, value] of [
    ['evidenceId', request.evidenceId],
    ['runId', request.runId],
    ['stepId', request.stepId],
    ['toolCallId', request.toolCallId],
    ['captureKey', request.captureKey],
    ['queryDigest', request.queryDigest],
  ] as const) if (value.length === 0) throw new StreamingEvidenceCaptureError('MCP_PROTOCOL_ERROR', name + ' cannot be empty');
  if (request.source !== 'log' && request.source !== 'trace') throw new StreamingEvidenceCaptureError('MCP_PROTOCOL_ERROR', 'Evidence source is invalid');
  validateRange(request.timeRange);
}

function validatePage(page: EvidenceSourcePage, maxPageBytes: number): void {
  if (!Number.isSafeInteger(page.encodedBytes) || page.encodedBytes < 0 || page.encodedBytes > maxPageBytes) {
    throw new StreamingEvidenceCaptureError('MCP_PROTOCOL_ERROR', 'Evidence source page exceeds the configured bound');
  }
  if (page.nextCursor !== undefined && page.nextCursor.length === 0) throw new StreamingEvidenceCaptureError('MCP_PROTOCOL_ERROR', 'Evidence cursor cannot be empty');
  if (page.sourceSnapshotId !== undefined && page.sourceSnapshotId.length === 0) throw new StreamingEvidenceCaptureError('MCP_PROTOCOL_ERROR', 'Evidence snapshot ID cannot be empty');
}

function validateRecord(record: NormalizedLogRecord): void {
  if (!Number.isFinite(Date.parse(record.timestamp))) throw new StreamingEvidenceCaptureError('MCP_PROTOCOL_ERROR', 'Evidence record timestamp is invalid');
  for (const value of [record.service, record.level, record.message, record.exception, record.traceId]) {
    if (value !== undefined && value.length === 0) throw new StreamingEvidenceCaptureError('MCP_PROTOCOL_ERROR', 'Evidence record contains an empty field');
  }
}

function validateRange(range: { start: string; end: string }): void {
  if (!Number.isFinite(Date.parse(range.start)) || !Number.isFinite(Date.parse(range.end)) || Date.parse(range.end) < Date.parse(range.start)) {
    throw new StreamingEvidenceCaptureError('MCP_PROTOCOL_ERROR', 'Evidence time range is invalid');
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let output = '';
  for (const character of value) {
    if (Buffer.byteLength(output + character, 'utf8') > maxBytes) break;
    output += character;
  }
  return output;
}

function addMissing(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new StreamingEvidenceCaptureError('ABORTED', 'Evidence capture aborted');
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || error instanceof StreamingEvidenceCaptureError && error.code === 'ABORTED';
}

function toCaptureResult(
  manifest: EvidenceManifest,
  summary: EvidenceSummary,
): EvidenceCaptureResult {
  if (manifest.state !== 'committed' && manifest.state !== 'partial') {
    throw new StreamingEvidenceCaptureError('STORAGE_ERROR', 'Evidence Manifest is not visible');
  }
  return {
    evidenceId: manifest.evidenceId,
    summary,
    manifest: {
      manifestId: manifest.manifestId,
      evidenceId: manifest.evidenceId,
      runId: manifest.runId,
      stepId: manifest.stepId,
      toolCallId: manifest.toolCallId,
      captureKey: manifest.captureKey,
      source: manifest.source,
      state: manifest.state,
      queryDigest: manifest.queryDigest,
      timeRange: manifest.timeRange,
      recordCount: manifest.recordCount,
      sourceBytes: manifest.sourceBytes,
      storedBytes: manifest.storedBytes,
      chunkCount: manifest.chunkCount,
      rawSha256: manifest.rawSha256,
      compression: manifest.compression,
      coverage: manifest.coverage,
      truncated: manifest.truncated,
      missingEvidence: [...manifest.missingEvidence],
      redactionPolicyVersion: manifest.redactionPolicyVersion,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      ...(manifest.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: manifest.sourceSnapshotId }),
      ...(manifest.nextCursor === undefined ? {} : { nextCursor: manifest.nextCursor }),
      ...(manifest.retentionUntil === undefined ? {} : { retentionUntil: manifest.retentionUntil }),
      ...(manifest.committedAt === undefined ? {} : { committedAt: manifest.committedAt }),
    },
    coverage: manifest.coverage,
    truncated: manifest.truncated,
    missingEvidence: [...manifest.missingEvidence],
  };
}
