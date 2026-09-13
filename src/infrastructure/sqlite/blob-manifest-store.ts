import type {
  CommitEvidenceManifestInput,
  CreateEvidenceManifestInput,
  EvidenceChunkRef,
  EvidenceManifest,
  EvidenceManifestSummary,
  EvidenceManifestStore,
  EvidenceSummary,
  FailEvidenceManifestInput,
  RecordEvidenceManifestChunkInput,
} from '../../contracts/storage.js';
import { canonicalJson } from '../../contracts/stable-json.js';
import type { SqliteDatabase } from './database.js';

const MANIFEST_COLUMNS = [
  'manifest_id',
  'evidence_id',
  'run_id',
  'step_id',
  'tool_call_id',
  'capture_key',
  'source',
  'query_digest',
  'source_snapshot_id',
  'range_start',
  'range_end',
  'state',
  'record_count',
  'source_bytes',
  'stored_bytes',
  'compression',
  'next_cursor',
  'truncated',
  'coverage',
  'raw_sha256',
  'summary_json',
  'missing_evidence_json',
  'failure_reason_code',
  'redaction_policy_version',
  'retention_until',
  'created_at',
  'updated_at',
  'committed_at',
].join(', ');
const MANIFEST_VALUES = Array.from({ length: MANIFEST_COLUMNS.split(', ').length }, () => '?').join(', ');

interface ManifestRow {
  manifest_id: string;
  evidence_id: string;
  run_id: string;
  step_id: string;
  tool_call_id: string;
  capture_key: string;
  source: string;
  query_digest: string;
  source_snapshot_id: string | null;
  range_start: string;
  range_end: string;
  state: string;
  record_count: number;
  source_bytes: number;
  stored_bytes: number;
  compression: string;
  next_cursor: string | null;
  truncated: number;
  coverage: number;
  raw_sha256: string;
  summary_json: string | null;
  missing_evidence_json: string;
  failure_reason_code: string | null;
  redaction_policy_version: string;
  retention_until: string | null;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
}

interface ChunkRow {
  manifest_id: string;
  chunk_index: number;
  storage_key: string;
  record_count: number;
  source_bytes: number;
  stored_bytes: number;
  sha256: string;
  first_captured_at: string | null;
  last_captured_at: string | null;
  committed_at: string;
}

export class SqliteEvidenceManifestStore implements EvidenceManifestStore {
  public constructor(private readonly database: SqliteDatabase) {}

  public createPending(input: CreateEvidenceManifestInput): Promise<EvidenceManifest> {
    validateCreateInput(input);
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const existingById = this.rowByEvidenceId(input.evidenceId);
      const existingByCapture = this.rowByCaptureKey(input.captureKey);
      const existing = existingById ?? existingByCapture;
      if (existing !== undefined) {
        if (sameCreateIdentity(existing, input)) return this.readManifest(existing);
        throw new Error('Evidence Manifest identity collision: ' + input.evidenceId);
      }
      this.database.raw.prepare(
        'INSERT INTO evidence_blob_manifests (' + MANIFEST_COLUMNS + ') VALUES (' + MANIFEST_VALUES + ')',
      ).run(
        input.manifestId,
        input.evidenceId,
        input.runId,
        input.stepId,
        input.toolCallId,
        input.captureKey,
        input.source,
        input.queryDigest,
        null,
        input.timeRange.start,
        input.timeRange.end,
        'pending',
        0,
        0,
        0,
        input.compression,
        null,
        0,
        0,
        '',
        null,
        '[]',
        null,
        input.redactionPolicyVersion,
        input.retentionUntil ?? null,
        input.createdAt,
        input.createdAt,
        null,
      );
      return this.requireManifest(input.evidenceId);
    })());
  }

  public recordChunk(input: RecordEvidenceManifestChunkInput): Promise<EvidenceManifest> {
    validateChunk(input.chunk);
    if (input.evidenceId !== input.chunk.evidenceId) throw new Error('Manifest chunk evidence ID does not match');
    validateTimestamp(input.updatedAt, 'updatedAt');
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const manifest = this.requireManifestRow(input.evidenceId);
      if (input.chunk.manifestId !== manifest.manifest_id) throw new Error('Manifest chunk ID does not match');
      const existing = this.chunkByIndex(manifest.manifest_id, input.chunk.chunkIndex);
      if (existing !== undefined) {
        if (!sameChunk(existing, input.chunk)) throw new Error('Evidence chunk identity collision');
        return this.readManifest(manifest);
      }
      if (manifest.state !== 'pending') throw new Error('Only pending Evidence Manifests accept chunks');
      this.database.raw.prepare(
        'INSERT INTO evidence_blob_chunks (manifest_id, chunk_index, storage_key, record_count, source_bytes, stored_bytes, sha256, first_captured_at, last_captured_at, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        input.chunk.manifestId,
        input.chunk.chunkIndex,
        input.chunk.storageKey,
        input.chunk.recordCount,
        input.chunk.sourceBytes,
        input.chunk.storedBytes,
        input.chunk.sha256,
        input.chunk.firstCapturedAt ?? null,
        input.chunk.lastCapturedAt ?? null,
        input.chunk.committedAt,
      );
      const currentCursor = input.nextCursor === undefined ? manifest.next_cursor : input.nextCursor;
      const currentSnapshot = input.sourceSnapshotId === undefined ? manifest.source_snapshot_id : input.sourceSnapshotId;
      this.database.raw.prepare(
        'UPDATE evidence_blob_manifests SET record_count = record_count + ?, source_bytes = source_bytes + ?, stored_bytes = stored_bytes + ?, next_cursor = ?, source_snapshot_id = ?, updated_at = ? WHERE evidence_id = ?',
      ).run(
        input.chunk.recordCount,
        input.chunk.sourceBytes,
        input.chunk.storedBytes,
        currentCursor,
        currentSnapshot,
        input.updatedAt,
        input.evidenceId,
      );
      return this.requireManifest(input.evidenceId);
    })());
  }

  public commit(input: CommitEvidenceManifestInput): Promise<EvidenceManifest> {
    validateCommitInput(input);
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const manifest = this.requireManifestRow(input.evidenceId);
      const desiredState: 'committed' | 'partial' = input.truncated || input.coverage < 1 || input.missingEvidence.length > 0
        ? 'partial'
        : 'committed';
      if (manifest.state === 'committed' || manifest.state === 'partial') {
        if (sameCommit(manifest, input, desiredState, this.chunkRows(manifest.manifest_id))) return this.requireManifest(input.evidenceId);
        throw new Error('Evidence Manifest is already terminal');
      }
      if (manifest.state !== 'pending') throw new Error('Only pending Evidence Manifests can be committed');
      if (!descriptorMatches(manifest, input.descriptor, this.chunkRows(manifest.manifest_id))) {
        throw new Error('Evidence Blob descriptor does not match Manifest');
      }
      if (input.summary.recordCount !== manifest.record_count
        || input.summary.sourceBytes !== manifest.source_bytes
        || input.descriptor.sourceBytes !== manifest.source_bytes
        || input.descriptor.storedBytes !== manifest.stored_bytes) {
        throw new Error('Evidence Manifest counters do not match committed Blob');
      }
      this.database.raw.prepare(
        'UPDATE evidence_blob_manifests SET state = ?, coverage = ?, truncated = ?, raw_sha256 = ?, summary_json = ?, missing_evidence_json = ?, failure_reason_code = NULL, updated_at = ?, committed_at = ? WHERE evidence_id = ?',
      ).run(
        desiredState,
        input.coverage,
        input.truncated ? 1 : 0,
        input.descriptor.rawSha256,
        canonicalJson(input.summary),
        canonicalJson([...input.missingEvidence]),
        input.updatedAt,
        input.committedAt,
        input.evidenceId,
      );
      return this.requireManifest(input.evidenceId);
    })());
  }

  public markFailed(input: FailEvidenceManifestInput): Promise<EvidenceManifest> {
    if (input.evidenceId.length === 0 || input.reasonCode.length === 0) throw new Error('Failed Manifest requires identity and reason');
    validateTimestamp(input.updatedAt, 'updatedAt');
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const manifest = this.requireManifestRow(input.evidenceId);
      if (manifest.state === 'failed') {
        if (manifest.failure_reason_code === input.reasonCode) return this.readManifest(manifest);
        throw new Error('Evidence Manifest failure reason conflicts');
      }
      if (manifest.state !== 'pending') throw new Error('Terminal Evidence Manifest cannot be failed');
      this.database.raw.prepare(
        'UPDATE evidence_blob_manifests SET state = ?, failure_reason_code = ?, updated_at = ? WHERE evidence_id = ?',
      ).run('failed', input.reasonCode, input.updatedAt, input.evidenceId);
      return this.requireManifest(input.evidenceId);
    })());
  }

  public get(evidenceId: string): Promise<EvidenceManifest | null> {
    return Promise.resolve().then(() => {
      const row = this.rowByEvidenceId(evidenceId);
      return row === undefined ? null : this.readManifest(row);
    });
  }

  public async getVisible(evidenceId: string): Promise<EvidenceManifestSummary | null> {
    const manifest = await this.get(evidenceId);
    if (manifest === null || (manifest.state !== 'committed' && manifest.state !== 'partial')) return null;
    return toVisibleSummary(manifest);
  }

  private requireManifest(evidenceId: string): EvidenceManifest {
    return this.readManifest(this.requireManifestRow(evidenceId));
  }

  private requireManifestRow(evidenceId: string): ManifestRow {
    const row = this.rowByEvidenceId(evidenceId);
    if (row === undefined) throw new Error('Evidence Manifest not found: ' + evidenceId);
    return row;
  }

  private rowByEvidenceId(evidenceId: string): ManifestRow | undefined {
    return this.database.raw.prepare(
      'SELECT ' + MANIFEST_COLUMNS + ' FROM evidence_blob_manifests WHERE evidence_id = ?',
    ).get(evidenceId) as ManifestRow | undefined;
  }

  private rowByCaptureKey(captureKey: string): ManifestRow | undefined {
    return this.database.raw.prepare(
      'SELECT ' + MANIFEST_COLUMNS + ' FROM evidence_blob_manifests WHERE capture_key = ?',
    ).get(captureKey) as ManifestRow | undefined;
  }

  private chunkRows(manifestId: string): ChunkRow[] {
    return this.database.raw.prepare(
      'SELECT manifest_id, chunk_index, storage_key, record_count, source_bytes, stored_bytes, sha256, first_captured_at, last_captured_at, committed_at FROM evidence_blob_chunks WHERE manifest_id = ? ORDER BY chunk_index',
    ).all(manifestId) as ChunkRow[];
  }

  private chunkByIndex(manifestId: string, chunkIndex: number): ChunkRow | undefined {
    return this.database.raw.prepare(
      'SELECT manifest_id, chunk_index, storage_key, record_count, source_bytes, stored_bytes, sha256, first_captured_at, last_captured_at, committed_at FROM evidence_blob_chunks WHERE manifest_id = ? AND chunk_index = ?',
    ).get(manifestId, chunkIndex) as ChunkRow | undefined;
  }

  private readManifest(row: ManifestRow): EvidenceManifest {
    const summary = row.summary_json === null ? undefined : JSON.parse(row.summary_json) as EvidenceSummary;
    const missingEvidence = JSON.parse(row.missing_evidence_json) as string[];
    const chunks = this.chunkRows(row.manifest_id).map((chunk) => chunkFromRow(chunk, row.evidence_id));
    return {
      manifestId: row.manifest_id,
      evidenceId: row.evidence_id,
      runId: row.run_id,
      stepId: row.step_id,
      toolCallId: row.tool_call_id,
      captureKey: row.capture_key,
      source: row.source as 'log' | 'trace',
      state: row.state as EvidenceManifest['state'],
      queryDigest: row.query_digest,
      timeRange: { start: row.range_start, end: row.range_end },
      recordCount: row.record_count,
      sourceBytes: row.source_bytes,
      storedBytes: row.stored_bytes,
      chunkCount: chunks.length,
      rawSha256: row.raw_sha256,
      compression: 'gzip_ndjson',
      coverage: row.coverage,
      truncated: row.truncated === 1,
      missingEvidence,
      redactionPolicyVersion: row.redaction_policy_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      chunks,
      ...(row.source_snapshot_id === null ? {} : { sourceSnapshotId: row.source_snapshot_id }),
      ...(row.next_cursor === null ? {} : { nextCursor: row.next_cursor }),
      ...(row.retention_until === null ? {} : { retentionUntil: row.retention_until }),
      ...(row.committed_at === null ? {} : { committedAt: row.committed_at }),
      ...(summary === undefined ? {} : { summary }),
      ...(row.failure_reason_code === null ? {} : { failureReasonCode: row.failure_reason_code }),
    };
  }
}

function toVisibleSummary(manifest: EvidenceManifest): EvidenceManifestSummary {
  if (manifest.state !== 'committed' && manifest.state !== 'partial') throw new Error('Manifest is not visible');
  return {
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
  };
}

function chunkFromRow(row: ChunkRow, evidenceId: string): EvidenceChunkRef {
  return {
    manifestId: row.manifest_id,
    evidenceId,
    chunkIndex: row.chunk_index,
    storageKey: row.storage_key,
    recordCount: row.record_count,
    sourceBytes: row.source_bytes,
    storedBytes: row.stored_bytes,
    sha256: row.sha256,
    ...(row.first_captured_at === null ? {} : { firstCapturedAt: row.first_captured_at }),
    ...(row.last_captured_at === null ? {} : { lastCapturedAt: row.last_captured_at }),
    committedAt: row.committed_at,
  };
}

function validateCreateInput(input: CreateEvidenceManifestInput): void {
  for (const [name, value] of [
    ['manifestId', input.manifestId],
    ['evidenceId', input.evidenceId],
    ['runId', input.runId],
    ['stepId', input.stepId],
    ['toolCallId', input.toolCallId],
    ['captureKey', input.captureKey],
    ['queryDigest', input.queryDigest],
    ['redactionPolicyVersion', input.redactionPolicyVersion],
  ] as const) if (value.length === 0) throw new Error(name + ' cannot be empty');
  if (input.source !== 'log' && input.source !== 'trace') throw new Error('Manifest source is invalid');
  if (input.compression !== 'gzip_ndjson') throw new Error('Manifest compression is invalid');
  validateTimestamp(input.createdAt, 'createdAt');
  validateRange(input.timeRange);
  if (input.retentionUntil !== undefined) validateTimestamp(input.retentionUntil, 'retentionUntil');
}

function validateChunk(chunk: EvidenceChunkRef): void {
  if (chunk.manifestId.length === 0 || chunk.evidenceId.length === 0 || chunk.storageKey.length === 0) throw new Error('Evidence chunk identity is required');
  if (!Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0) throw new RangeError('chunkIndex must be non-negative');
  for (const [name, value] of [['recordCount', chunk.recordCount], ['sourceBytes', chunk.sourceBytes], ['storedBytes', chunk.storedBytes]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(name + ' must be non-negative');
  }
  if (!/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error('Evidence chunk hash is invalid');
  validateTimestamp(chunk.committedAt, 'committedAt');
  if (chunk.firstCapturedAt !== undefined) validateTimestamp(chunk.firstCapturedAt, 'firstCapturedAt');
  if (chunk.lastCapturedAt !== undefined) validateTimestamp(chunk.lastCapturedAt, 'lastCapturedAt');
}

function validateCommitInput(input: CommitEvidenceManifestInput): void {
  if (input.evidenceId.length === 0) throw new Error('evidenceId cannot be empty');
  if (!Number.isFinite(input.coverage) || input.coverage < 0 || input.coverage > 1) throw new RangeError('coverage must be between zero and one');
  if (input.descriptor.rawSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(input.descriptor.rawSha256)) throw new Error('Evidence Blob hash is invalid');
  validateTimestamp(input.updatedAt, 'updatedAt');
  validateTimestamp(input.committedAt, 'committedAt');
  for (const chunk of input.descriptor.chunks) validateChunk(chunk);
}

function validateTimestamp(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(name + ' is not a valid timestamp');
}

function validateRange(range: { start: string; end: string }): void {
  validateTimestamp(range.start, 'range.start');
  validateTimestamp(range.end, 'range.end');
  if (Date.parse(range.end) < Date.parse(range.start)) throw new RangeError('Evidence range ends before it starts');
}

function sameCreateIdentity(row: ManifestRow, input: CreateEvidenceManifestInput): boolean {
  return row.manifest_id === input.manifestId
    && row.evidence_id === input.evidenceId
    && row.run_id === input.runId
    && row.step_id === input.stepId
    && row.tool_call_id === input.toolCallId
    && row.capture_key === input.captureKey
    && row.source === input.source
    && row.query_digest === input.queryDigest
    && row.range_start === input.timeRange.start
    && row.range_end === input.timeRange.end
    && row.compression === input.compression
    && row.redaction_policy_version === input.redactionPolicyVersion
    && row.retention_until === (input.retentionUntil ?? null);
}

function sameChunk(row: ChunkRow, chunk: EvidenceChunkRef): boolean {
  return row.manifest_id === chunk.manifestId
    && row.chunk_index === chunk.chunkIndex
    && row.storage_key === chunk.storageKey
    && row.record_count === chunk.recordCount
    && row.source_bytes === chunk.sourceBytes
    && row.stored_bytes === chunk.storedBytes
    && row.sha256 === chunk.sha256
    && row.first_captured_at === (chunk.firstCapturedAt ?? null)
    && row.last_captured_at === (chunk.lastCapturedAt ?? null)
    && row.committed_at === chunk.committedAt;
}

function descriptorMatches(manifest: ManifestRow, descriptor: CommitEvidenceManifestInput['descriptor'], rows: ChunkRow[]): boolean {
  if (descriptor.manifestId !== manifest.manifest_id
    || descriptor.evidenceId !== manifest.evidence_id
    || descriptor.captureKey !== manifest.capture_key
    || descriptor.compression !== manifest.compression
    || descriptor.chunks.length !== rows.length) return false;
  return descriptor.chunks.every((chunk, index) => {
    const row = rows[index];
    return row !== undefined && sameChunk(row, chunk) && chunk.evidenceId === manifest.evidence_id;
  });
}

function sameCommit(
  manifest: ManifestRow,
  input: CommitEvidenceManifestInput,
  desiredState: 'committed' | 'partial',
  rows: ChunkRow[],
): boolean {
  return manifest.state === desiredState
    && manifest.coverage === input.coverage
    && manifest.truncated === (input.truncated ? 1 : 0)
    && manifest.raw_sha256 === input.descriptor.rawSha256
    && manifest.summary_json === canonicalJson(input.summary)
    && manifest.missing_evidence_json === canonicalJson([...input.missingEvidence])
    && descriptorMatches(manifest, input.descriptor, rows);
}
