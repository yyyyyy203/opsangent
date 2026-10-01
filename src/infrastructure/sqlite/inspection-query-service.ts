import type {
  EvidenceManifestQueryStore,
  InspectionQueryService,
  PublicEvidencePage,
  PublicEvidenceView,
  PublicRunDetail,
  PublicRunPage,
  PublicRunSummary,
  RunListOptions,
  RunStatus,
  VersionedCheckpointStore,
} from '../../contracts/index.js';
import { publicEvidenceFromManifest, publicEvidenceFromRecord } from '../../contracts/read-model.js';
import type { EvidenceManifestStore, EvidenceRecord } from '../../contracts/storage.js';
import type { SqliteDatabase } from './database.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

interface RunRow {
  run_id: string;
  profile_id: string;
  status: string;
  stage: string;
  revision: number;
  context_version: number;
  created_at: string;
  updated_at: string;
}

interface InlineEvidenceRow {
  evidence_id: string;
  run_id: string;
  source: string;
  captured_at: string;
  summary_json: string;
  raw_sha256: string;
  business_trace_ids_json: string;
  schema_version: number;
}

interface SubagentRelationRow {
  parent_run_id: string | null;
  child_run_id: string | null;
}

/** SQLite read model. Queries select only control-plane and summary columns; raw_json is never selected. */
export class SqliteInspectionQueryService implements InspectionQueryService {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly checkpoints: VersionedCheckpointStore,
    private readonly manifests: EvidenceManifestStore & Partial<EvidenceManifestQueryStore>,
  ) {}

  public listRuns(options: RunListOptions = {}): Promise<PublicRunPage> {
    const limit = pageLimit(options.limit);
    const cursor = options.cursor === undefined ? undefined : decodeRunCursor(options.cursor);
    if (cursor !== undefined && (cursor.profileId !== options.profileId || cursor.status !== options.status)) throw new Error('run cursor does not match its filters');
    const conditions = ['1 = 1'];
    const values: unknown[] = [];
    if (options.profileId !== undefined) { conditions.push('profile_id = ?'); values.push(options.profileId); }
    if (options.status !== undefined) { conditions.push('status = ?'); values.push(options.status); }
    if (cursor !== undefined) {
      conditions.push('(updated_at < ? OR (updated_at = ? AND run_id < ?))');
      values.push(cursor.updatedAt, cursor.updatedAt, cursor.runId);
    }
    values.push(limit + 1);
    const rows = this.database.raw.prepare(`
      SELECT run_id, profile_id, status, stage, revision, context_version, created_at, updated_at
      FROM agent_checkpoints WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at DESC, run_id DESC LIMIT ?
    `).all(...values) as RunRow[];
    const items = rows.slice(0, limit).map(toRunSummary);
    const last = items.at(-1);
    return Promise.resolve({ items, ...(rows.length > limit && last !== undefined ? { nextCursor: encodeRunCursor(last, options) } : {}) });
  }

  public async getRun(runId: string): Promise<PublicRunDetail | null> {
    const loaded = await this.checkpoints.load(runId);
    if (loaded === null) return null;
    const relation = this.findRelation(runId);
    const context = loaded.context;
    return {
      ...toRunSummary({
        run_id: context.runId, profile_id: context.profileId, status: context.status, stage: context.stage,
        revision: loaded.revision, context_version: context.contextVersion, created_at: context.budget.startedAt, updated_at: loaded.savedAt,
      }),
      ...(relation.parentRunId === undefined ? {} : { parentRunId: relation.parentRunId }),
      evidenceIds: [...context.evidenceIds],
      missingEvidence: context.missingEvidence.map((item) => item.slice(0, 500)),
      childRunIds: relation.childRunIds,
      ...(context.failure === undefined ? {} : { failure: { code: context.failure.code, message: context.failure.message.slice(0, 500), retryable: context.failure.retryable } }),
    };
  }

  public async listEvidence(runId: string, options: { cursor?: string; limit?: number } = {}): Promise<PublicEvidencePage> {
    const limit = pageLimit(options.limit);
    const cursor = options.cursor === undefined ? undefined : decodeEvidenceCursor(options.cursor);
    if (cursor !== undefined && cursor.runId !== runId) throw new Error('evidence cursor does not belong to this Run');
    const rows = cursor === undefined
      ? this.database.raw.prepare(`
        SELECT evidence_id, run_id, source, captured_at, summary_json, raw_sha256, business_trace_ids_json, schema_version
        FROM evidence_records WHERE run_id = ? ORDER BY captured_at, evidence_id LIMIT ?
      `).all(runId, limit + 1) as InlineEvidenceRow[]
      : this.database.raw.prepare(`
        SELECT evidence_id, run_id, source, captured_at, summary_json, raw_sha256, business_trace_ids_json, schema_version
        FROM evidence_records WHERE run_id = ? AND (captured_at > ? OR (captured_at = ? AND evidence_id > ?))
        ORDER BY captured_at, evidence_id LIMIT ?
      `).all(runId, cursor.capturedAt, cursor.capturedAt, cursor.evidenceId, limit + 1) as InlineEvidenceRow[];
    const inline = rows.map(toPublicInlineEvidence);
    const manifestPage = this.manifests.listVisibleByRun === undefined
      ? { items: [] }
      : await this.manifests.listVisibleByRun(runId, { limit, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
    const manifests = manifestPage.items.map(publicEvidenceFromManifest);
    const merged = [...inline, ...manifests]
      .sort(compareEvidence);
    const items = merged.slice(0, limit);
    const last = items.at(-1);
    const hasMore = merged.length > limit || rows.length > limit || manifestPage.nextCursor !== undefined;
    return { items, ...(hasMore && last !== undefined ? { nextCursor: encodeEvidenceCursor(last) } : {}) };
  }

  public async getEvidence(runId: string, evidenceId: string): Promise<PublicEvidenceView | null> {
    const row = this.database.raw.prepare(`
      SELECT evidence_id, run_id, source, captured_at, summary_json, raw_sha256, business_trace_ids_json, schema_version
      FROM evidence_records WHERE evidence_id = ?
    `).get(evidenceId) as InlineEvidenceRow | undefined;
    if (row !== undefined) return row.run_id === runId ? toPublicInlineEvidence(row) : null;
    const manifest = await this.manifests.getVisible(evidenceId);
    return manifest === null || manifest.runId !== runId ? null : publicEvidenceFromManifest(manifest);
  }

  private findRelation(runId: string): { parentRunId?: string; childRunIds: string[] } {
    const childRunIds: string[] = [];
    let parentRunId: string | undefined;
    const rows = this.database.raw.prepare(`
      SELECT
        json_extract(event_json, '$.payload.parentRunId') AS parent_run_id,
        json_extract(event_json, '$.payload.childRunId') AS child_run_id
      FROM agent_events
      WHERE type = 'SUBAGENT_STARTED'
        AND (
          json_extract(event_json, '$.payload.parentRunId') = ?
          OR json_extract(event_json, '$.payload.childRunId') = ?
        )
    `).all(runId, runId) as SubagentRelationRow[];
    for (const row of rows) {
      if (row.child_run_id === runId && row.parent_run_id !== null) parentRunId = row.parent_run_id;
      if (row.parent_run_id === runId && row.child_run_id !== null) childRunIds.push(row.child_run_id);
    }
    return { ...(parentRunId === undefined ? {} : { parentRunId }), childRunIds: [...new Set(childRunIds)] };
  }
}

function toRunSummary(row: RunRow): PublicRunSummary {
  return {
    runId: row.run_id,
    profileId: row.profile_id,
    status: row.status as RunStatus,
    stage: row.stage as PublicRunSummary['stage'],
    revision: row.revision,
    contextVersion: row.context_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicInlineEvidence(row: InlineEvidenceRow): PublicEvidenceView {
  let summary: unknown;
  let traceIds: unknown;
  try {
    summary = JSON.parse(row.summary_json) as unknown;
    traceIds = JSON.parse(row.business_trace_ids_json) as unknown;
  } catch {
    summary = {};
    traceIds = [];
  }
  const record: EvidenceRecord = {
    evidenceId: row.evidence_id,
    runId: row.run_id,
    source: row.source as EvidenceRecord['source'],
    capturedAt: row.captured_at,
    summary: summary as Record<string, unknown>,
    raw: null,
    businessTraceIds: Array.isArray(traceIds) ? traceIds.filter((value): value is string => typeof value === 'string') : [],
    rawSha256: row.raw_sha256,
    schemaVersion: row.schema_version,
  };
  return publicEvidenceFromRecord(record);
}

function compareEvidence(left: PublicEvidenceView, right: PublicEvidenceView): number {
  return left.capturedAt.localeCompare(right.capturedAt) || left.evidenceId.localeCompare(right.evidenceId);
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PAGE_SIZE) throw new RangeError(`page limit must be between 1 and ${MAX_PAGE_SIZE}`);
  return value;
}

interface RunCursor { updatedAt: string; runId: string; profileId?: string; status?: string }
interface EvidenceCursor { runId: string; capturedAt: string; evidenceId: string }

function encodeRunCursor(item: PublicRunSummary, options: RunListOptions): string {
  return encode({ updatedAt: item.updatedAt, runId: item.runId, ...(options.profileId === undefined ? {} : { profileId: options.profileId }), ...(options.status === undefined ? {} : { status: options.status }) });
}

function decodeRunCursor(value: string): RunCursor {
  const parsed = decode(value);
  if (!isRecord(parsed) || typeof parsed.updatedAt !== 'string' || typeof parsed.runId !== 'string') throw new Error('run cursor is invalid');
  return { updatedAt: parsed.updatedAt, runId: parsed.runId, ...(typeof parsed.profileId === 'string' ? { profileId: parsed.profileId } : {}), ...(typeof parsed.status === 'string' ? { status: parsed.status } : {}) };
}

function encodeEvidenceCursor(item: PublicEvidenceView): string {
  return Buffer.from(JSON.stringify({ runId: item.runId, capturedAt: item.capturedAt, evidenceId: item.evidenceId }), 'utf8').toString('base64url');
}

function decodeEvidenceCursor(value: string): EvidenceCursor {
  const parsed = decode(value);
  if (!isRecord(parsed) || typeof parsed.runId !== 'string' || typeof parsed.capturedAt !== 'string' || typeof parsed.evidenceId !== 'string') throw new Error('evidence cursor is invalid');
  return parsed as unknown as EvidenceCursor;
}

function encode(value: object): string { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
function decode(value: string): unknown { try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown; } catch { throw new Error('cursor is invalid'); } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
