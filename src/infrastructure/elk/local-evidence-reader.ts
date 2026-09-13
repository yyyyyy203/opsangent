import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  canonicalJson,
  type EvidenceBlobStore,
  type EvidenceChunkRef,
  type EvidenceManifest,
  type EvidenceManifestStore,
  type JsonValue,
  type LogEvidenceAggregation,
  type LogEvidenceFilter,
  type LogEvidenceReadPage,
  type LogEvidenceReader,
  type NormalizedLogRecord,
} from '../../contracts/index.js';
import { SourceFailure } from '../../mcp/resilience.js';

const gunzipAsync = promisify(gunzip);
const DEFAULT_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SCAN_RECORDS = 100_000;
const MAX_TRACE_IDS = 100;

export interface LocalEvidenceReaderOptions {
  maxChunkBytes?: number;
  maxScanRecords?: number;
  /** Stable across process restarts when previously issued cursors must remain valid. */
  cursorSecret?: string | Uint8Array;
}

interface EvidenceCursor {
  manifestId: string;
  chunkIndex: number;
  recordIndex: number;
}

/** Reads only committed local evidence; Blob keys remain inside this infrastructure adapter. */
export class LocalEvidenceReader implements LogEvidenceReader {
  private readonly maxChunkBytes: number;
  private readonly maxScanRecords: number;
  private readonly cursorSecret: Buffer;

  public constructor(
    private readonly options: {
      blobStore: EvidenceBlobStore;
      manifests: EvidenceManifestStore;
    } & LocalEvidenceReaderOptions,
  ) {
    this.maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    this.maxScanRecords = options.maxScanRecords ?? DEFAULT_MAX_SCAN_RECORDS;
    this.cursorSecret = Buffer.from(options.cursorSecret ?? randomBytes(32));
    if (this.cursorSecret.length < 16) throw new RangeError('cursorSecret must contain at least 16 bytes');
    if (!Number.isSafeInteger(this.maxChunkBytes) || this.maxChunkBytes <= 0) throw new RangeError('maxChunkBytes must be positive');
    if (!Number.isSafeInteger(this.maxScanRecords) || this.maxScanRecords <= 0) throw new RangeError('maxScanRecords must be positive');
  }

  public search(input: {
    evidenceId: string;
    runId: string;
    filter?: LogEvidenceFilter;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<LogEvidenceReadPage> {
    return this.readPage(input);
  }

  public readSlice(input: {
    evidenceId: string;
    runId: string;
    filter?: LogEvidenceFilter;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<LogEvidenceReadPage> {
    return this.readPage(input);
  }

  public async aggregate(input: {
    evidenceId: string;
    runId: string;
    filter?: LogEvidenceFilter;
    topN: number;
    signal: AbortSignal;
  }): Promise<LogEvidenceAggregation> {
    const manifest = await this.visibleManifest(input.evidenceId, input.runId);
    validatePositiveLimit(input.topN);
    const levels = new Map<string, number>();
    const services = new Map<string, number>();
    const exceptions = new Map<string, number>();
    const traces = new Set<string>();
    let recordCount = 0;
    let scanned = 0;
    for (const chunk of orderedChunks(manifest)) {
      for (const record of await this.readChunk(chunk, input.signal)) {
        throwIfAborted(input.signal);
        scanned += 1;
        if (scanned > this.maxScanRecords) throw new SourceFailure('BUDGET_EXCEEDED');
        if (!matches(record, input.filter)) continue;
        recordCount += 1;
        increment(levels, record.level);
        increment(services, record.service);
        increment(exceptions, record.exception);
        if (record.traceId !== undefined && traces.size < MAX_TRACE_IDS) traces.add(record.traceId);
      }
    }
    return {
      recordCount,
      levels: topCounts(levels, input.topN),
      services: topCounts(services, input.topN),
      exceptionSignatures: topCounts(exceptions, input.topN),
      traceIds: [...traces].sort().slice(0, MAX_TRACE_IDS),
    };
  }

  private async readPage(input: {
    evidenceId: string;
    runId: string;
    filter?: LogEvidenceFilter;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<LogEvidenceReadPage> {
    const manifest = await this.visibleManifest(input.evidenceId, input.runId);
    validatePositiveLimit(input.limit);
    throwIfAborted(input.signal);
    const chunks = orderedChunks(manifest);
    const cursor = decodeCursor(input.cursor, manifest.manifestId, chunks.length, this.cursorSecret);
    const records: NormalizedLogRecord[] = [];
    let scanned = 0;

    for (let chunkIndex = cursor.chunkIndex; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      if (chunk === undefined) throw new SourceFailure('STORAGE_ERROR');
      const chunkRecords = await this.readChunk(chunk, input.signal);
      const firstRecord = chunkIndex === cursor.chunkIndex ? cursor.recordIndex : 0;
      if (firstRecord > chunkRecords.length) throw new SourceFailure('MCP_PROTOCOL_ERROR');
      for (let recordIndex = firstRecord; recordIndex < chunkRecords.length; recordIndex += 1) {
        throwIfAborted(input.signal);
        scanned += 1;
        if (scanned > this.maxScanRecords) throw new SourceFailure('BUDGET_EXCEEDED');
        const record = chunkRecords[recordIndex];
        if (record === undefined || !matches(record, input.filter)) continue;
        records.push(toPublicRecord(record));
        if (records.length >= input.limit) {
          return {
            records,
            nextCursor: encodeCursor({ manifestId: manifest.manifestId, chunkIndex, recordIndex: recordIndex + 1 }, this.cursorSecret),
          };
        }
      }
    }
    return { records };
  }

  private async visibleManifest(evidenceId: string, runId: string): Promise<EvidenceManifest> {
    const manifest = await this.options.manifests.get(evidenceId);
    if (manifest === null || manifest.runId !== runId || manifest.source !== 'log'
      || (manifest.state !== 'committed' && manifest.state !== 'partial')) {
      throw new SourceFailure('POLICY_DENIED');
    }
    return manifest;
  }

  private async readChunk(ref: EvidenceChunkRef, signal: AbortSignal): Promise<NormalizedLogRecord[]> {
    throwIfAborted(signal);
    const pieces: Buffer[] = [];
    let compressedBytes = 0;
    try {
      for await (const piece of this.options.blobStore.readChunk(ref)) {
        throwIfAborted(signal);
        compressedBytes += piece.byteLength;
        if (compressedBytes > this.maxChunkBytes) throw new SourceFailure('BUDGET_EXCEEDED');
        pieces.push(Buffer.from(piece));
      }
      const decoded = await gunzipAsync(Buffer.concat(pieces));
      if (decoded.byteLength > this.maxChunkBytes) throw new SourceFailure('BUDGET_EXCEEDED');
      return parseNdjson(Buffer.from(decoded).toString('utf8'));
    } catch (error) {
      if (error instanceof SourceFailure) throw error;
      throw new SourceFailure('STORAGE_ERROR');
    }
  }
}

function orderedChunks(manifest: EvidenceManifest): EvidenceChunkRef[] {
  const chunks = [...manifest.chunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
  for (const [position, chunk] of chunks.entries()) {
    if (chunk.chunkIndex !== position) throw new SourceFailure('STORAGE_ERROR');
  }
  return chunks;
}

function parseNdjson(text: string): NormalizedLogRecord[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const records: NormalizedLogRecord[] = [];
  for (const line of lines) {
    if (line.length === 0) throw new SourceFailure('STORAGE_ERROR');
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new SourceFailure('STORAGE_ERROR');
    }
    records.push(validateStoredRecord(value));
  }
  return records;
}

function validateStoredRecord(value: unknown): NormalizedLogRecord {
  if (!isRecord(value) || typeof value.timestamp !== 'string' || Number.isNaN(Date.parse(value.timestamp))) {
    throw new SourceFailure('STORAGE_ERROR');
  }
  const service = storedString(value.service);
  const level = storedString(value.level);
  const message = storedString(value.message);
  const exception = storedString(value.exception);
  const traceId = storedString(value.traceId);
  if (value.fields !== undefined && !isJsonObject(value.fields)) throw new SourceFailure('STORAGE_ERROR');
  return {
    timestamp: value.timestamp,
    ...(service === undefined ? {} : { service }),
    ...(level === undefined ? {} : { level }),
    ...(message === undefined ? {} : { message }),
    ...(exception === undefined ? {} : { exception }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(value.fields === undefined ? {} : { fields: value.fields }),
  };
}

function toPublicRecord(record: NormalizedLogRecord): NormalizedLogRecord {
  return {
    timestamp: record.timestamp,
    ...(record.service === undefined ? {} : { service: record.service }),
    ...(record.level === undefined ? {} : { level: record.level }),
    ...(record.message === undefined ? {} : { message: record.message }),
    ...(record.exception === undefined ? {} : { exception: record.exception }),
    ...(record.traceId === undefined ? {} : { traceId: record.traceId }),
  };
}

function matches(record: NormalizedLogRecord, filter: LogEvidenceFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.service !== undefined && record.service !== filter.service) return false;
  if (filter.level !== undefined && record.level !== filter.level) return false;
  if (filter.exception !== undefined && record.exception !== filter.exception) return false;
  if (filter.traceId !== undefined && record.traceId !== filter.traceId) return false;
  if (filter.contains !== undefined && !(record.message ?? '').includes(filter.contains)) return false;
  return true;
}

function increment(map: Map<string, number>, value: string | undefined): void {
  if (value !== undefined) map.set(value, (map.get(value) ?? 0) + 1);
}

function topCounts(map: Map<string, number>, limit: number): { value: string; count: number }[] {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || compareStrings(left[0], right[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePositiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new SourceFailure('MCP_PROTOCOL_ERROR');
}

function encodeCursor(cursor: EvidenceCursor, secret: Buffer): string {
  const payload = canonicalJson(cursor);
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
  return encodedPayload + '.' + signature;
}

function decodeCursor(value: string | undefined, manifestId: string, chunkCount: number, secret: Buffer): EvidenceCursor {
  if (value === undefined) return { manifestId, chunkIndex: 0, recordIndex: 0 };
  if (value.length > 512) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  try {
    const parts = value.split('.');
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) throw new Error('invalid cursor');
    const payload = Buffer.from(parts[0], 'base64url').toString('utf8');
    const expected = createHmac('sha256', secret).update(payload, 'utf8').digest();
    const actual = Buffer.from(parts[1], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid cursor signature');
    const parsed = JSON.parse(payload) as unknown;
    const chunkIndex = isRecord(parsed) ? parsed.chunkIndex : undefined;
    const recordIndex = isRecord(parsed) ? parsed.recordIndex : undefined;
    if (!isRecord(parsed)
      || parsed.manifestId !== manifestId
      || typeof chunkIndex !== 'number'
      || typeof recordIndex !== 'number'
      || !Number.isSafeInteger(chunkIndex)
      || !Number.isSafeInteger(recordIndex)
      || chunkIndex < 0
      || recordIndex < 0
      || chunkIndex > chunkCount) {
      throw new Error('invalid cursor');
    }
    return {
      manifestId,
      chunkIndex,
      recordIndex,
    };
  } catch (error) {
    if (error instanceof SourceFailure) throw error;
    throw new SourceFailure('MCP_PROTOCOL_ERROR');
  }
}

function storedString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new SourceFailure('STORAGE_ERROR');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (!isRecord(value)) return false;
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SourceFailure('ABORTED');
}
