import { StoredDataCorruptionError } from '../../contracts/event-store.js';
import {
  type EvidencePage,
  type EvidenceQueryStore,
  type EvidenceRecord,
  type EvidenceStore,
} from '../../contracts/storage.js';
import {
  checkpointChecksum,
  parseEvidenceRecord,
} from '../../storage/durable-codec.js';
import type { SqliteDatabase } from './database.js';

const DEFAULT_MAX_RAW_BYTES = 1_048_576;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export interface SqliteEvidenceStoreOptions {
  maxRawBytes?: number;
}

interface EvidenceRow {
  evidence_id: string;
  run_id: string;
  tool_call_id: string | null;
  capture_key: string | null;
  source: string;
  captured_at: string;
  summary_json: string;
  raw_json: string;
  raw_sha256: string;
  business_trace_ids_json: string;
  schema_version: number;
}

interface PreparedEvidence {
  record: EvidenceRecord;
  summaryJson: string;
  rawJson: string;
  businessTraceIdsJson: string;
}

/** SQLite Evidence control-plane store for bounded inline records only. */
export class SqliteEvidenceStore implements EvidenceStore, EvidenceQueryStore {
  private readonly maxRawBytes: number;

  public constructor(
    private readonly database: SqliteDatabase,
    options: SqliteEvidenceStoreOptions = {},
  ) {
    this.maxRawBytes = options.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES;
    if (!Number.isSafeInteger(this.maxRawBytes) || this.maxRawBytes <= 0) {
      throw new RangeError('maxRawBytes must be a positive safe integer');
    }
  }

  public save(record: EvidenceRecord): Promise<void> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const prepared = prepareEvidence(record, this.maxRawBytes);
      const existingById = this.rowById(prepared.record.evidenceId);
      const existingByCapture = prepared.record.captureKey === undefined ? undefined : this.rowByCaptureKey(prepared.record.captureKey);
      const existing = existingById ?? existingByCapture;
      if (existing !== undefined) {
        const parsed = this.parseRow(existing);
        if (sameEvidenceIdentity(parsed, prepared.record)) return;
        throw new Error(`evidence identity collision: ${prepared.record.evidenceId}`);
      }
      this.database.raw.prepare(`
        INSERT INTO evidence_records(
          evidence_id, run_id, tool_call_id, capture_key, source, captured_at,
          summary_json, raw_json, raw_sha256, business_trace_ids_json, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        prepared.record.evidenceId,
        prepared.record.runId,
        prepared.record.toolCallId ?? null,
        prepared.record.captureKey ?? null,
        prepared.record.source,
        prepared.record.capturedAt,
        prepared.summaryJson,
        prepared.rawJson,
        prepared.record.rawSha256,
        prepared.businessTraceIdsJson,
        prepared.record.schemaVersion,
      );
    }).immediate());
  }

  public get(evidenceId: string): Promise<EvidenceRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.rowById(evidenceId);
      return row === undefined ? null : this.parseRow(row);
    });
  }

  public listByRun(runId: string, options: { cursor?: string; limit?: number } = {}): Promise<EvidencePage> {
    return Promise.resolve().then(() => {
      const limit = pageLimit(options.limit);
      const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
      if (cursor !== undefined && cursor.runId !== runId) throw new Error('evidence cursor does not belong to this Run');
      const rows = cursor === undefined
        ? this.database.raw.prepare(`
          SELECT evidence_id, run_id, tool_call_id, capture_key, source, captured_at,
                 summary_json, raw_json, raw_sha256, business_trace_ids_json, schema_version
          FROM evidence_records WHERE run_id = ?
          ORDER BY captured_at, evidence_id LIMIT ?
        `).all(runId, limit + 1) as EvidenceRow[]
        : this.database.raw.prepare(`
          SELECT evidence_id, run_id, tool_call_id, capture_key, source, captured_at,
                 summary_json, raw_json, raw_sha256, business_trace_ids_json, schema_version
          FROM evidence_records
          WHERE run_id = ? AND (captured_at > ? OR (captured_at = ? AND evidence_id > ?))
          ORDER BY captured_at, evidence_id LIMIT ?
        `).all(runId, cursor.capturedAt, cursor.capturedAt, cursor.evidenceId, limit + 1) as EvidenceRow[];
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => this.parseRow(row));
      const last = items.at(-1);
      return { items, ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(last) } : {}) };
    });
  }

  private rowById(evidenceId: string): EvidenceRow | undefined {
    return this.database.raw.prepare(`
      SELECT evidence_id, run_id, tool_call_id, capture_key, source, captured_at,
             summary_json, raw_json, raw_sha256, business_trace_ids_json, schema_version
      FROM evidence_records WHERE evidence_id = ?
    `).get(evidenceId) as EvidenceRow | undefined;
  }

  private rowByCaptureKey(captureKey: string): EvidenceRow | undefined {
    return this.database.raw.prepare(`
      SELECT evidence_id, run_id, tool_call_id, capture_key, source, captured_at,
             summary_json, raw_json, raw_sha256, business_trace_ids_json, schema_version
      FROM evidence_records WHERE capture_key = ?
    `).get(captureKey) as EvidenceRow | undefined;
  }

  private parseRow(row: EvidenceRow): EvidenceRecord {
    try {
      const summary: unknown = JSON.parse(row.summary_json) as unknown;
      const raw: unknown = JSON.parse(row.raw_json) as unknown;
      const businessTraceIds: unknown = JSON.parse(row.business_trace_ids_json) as unknown;
      const record = parseEvidenceRecord({
        evidenceId: row.evidence_id,
        runId: row.run_id,
        ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
        ...(row.capture_key === null ? {} : { captureKey: row.capture_key }),
        source: row.source,
        capturedAt: row.captured_at,
        summary,
        raw,
        businessTraceIds,
        rawSha256: row.raw_sha256,
        schemaVersion: row.schema_version,
      });
      if (checkpointChecksum(record.raw) !== row.raw_sha256) throw new Error('evidence raw checksum mismatch');
      return record;
    } catch {
      throw new StoredDataCorruptionError('evidence', row.evidence_id);
    }
  }
}

function prepareEvidence(record: EvidenceRecord, maxRawBytes: number): PreparedEvidence {
  const normalized = parseEvidenceRecord(record);
  checkpointChecksum({ summary: normalized.summary, businessTraceIds: normalized.businessTraceIds });
  const rawSha256 = checkpointChecksum(normalized.raw);
  if (normalized.rawSha256 !== undefined && normalized.rawSha256 !== rawSha256) {
    throw new Error(`evidence raw hash does not match: ${normalized.evidenceId}`);
  }
  const rawJson = JSON.stringify(normalized.raw);
  if (rawJson === undefined || Buffer.byteLength(rawJson, 'utf8') > maxRawBytes) {
    throw new Error(`evidence raw payload exceeds ${maxRawBytes} bytes`);
  }
  const summaryJson = JSON.stringify(normalized.summary);
  const businessTraceIdsJson = JSON.stringify(normalized.businessTraceIds);
  if (summaryJson === undefined || businessTraceIdsJson === undefined) throw new Error('evidence cannot be serialized');
  return {
    record: structuredClone({ ...normalized, rawSha256, schemaVersion: normalized.schemaVersion ?? 1 }),
    summaryJson,
    rawJson,
    businessTraceIdsJson,
  };
}

function sameEvidenceIdentity(left: EvidenceRecord, right: EvidenceRecord): boolean {
  return left.evidenceId === right.evidenceId
    && left.captureKey === right.captureKey
    && left.rawSha256 === right.rawSha256;
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PAGE_SIZE) {
    throw new RangeError(`evidence page limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return value;
}

interface EvidenceCursor {
  runId: string;
  capturedAt: string;
  evidenceId: string;
}

function encodeCursor(record: EvidenceRecord): string {
  return Buffer.from(JSON.stringify({ runId: record.runId, capturedAt: record.capturedAt, evidenceId: record.evidenceId }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): EvidenceCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('evidence cursor is invalid');
  }
  if (!isEvidenceCursor(parsed)) throw new Error('evidence cursor is invalid');
  return parsed;
}

function isEvidenceCursor(value: unknown): value is EvidenceCursor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<EvidenceCursor>;
  return typeof candidate.runId === 'string'
    && typeof candidate.capturedAt === 'string'
    && typeof candidate.evidenceId === 'string';
}
