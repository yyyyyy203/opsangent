import type {
  HistoricalEvidenceRef, MemoryCaptureRequest, MemoryCaptureSource, MemoryOperation,
} from '../../contracts/diagnostic-memory.js';
import type { InspectionQueryService, PublicEvidenceView } from '../../contracts/read-model.js';
import type { AgentContext } from '../../contracts/context.js';
import { StoredDataCorruptionError } from '../../contracts/event-store.js';
import type { StoredRunCheckpoint } from '../../contracts/storage.js';
import { checkpointChecksum } from '../../contracts/stable-json.js';
import { parseAgentContext } from '../../storage/durable-codec.js';
import { MemoryError } from '../../memory/memory-error.js';
import { memoryInstant } from '../../memory/diagnostic-memory-state.js';
import type { SqliteDatabase } from './database.js';

const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const MAX_EVIDENCE_PAGE = 21;
const HASH = /^[a-f0-9]{64}$/iu;

interface CheckpointRow {
  run_id: string; revision: number; context_version: number; status: string; stage: string;
  profile_id: string; checkpoint_schema_version: number; checkpoint_json: string; checksum: string; updated_at: string;
}

/** Reads only a bounded checkpoint and public evidence metadata; never selects evidence raw_json. */
export class SqliteMemoryCaptureSource implements MemoryCaptureSource {
  public constructor(private readonly options: { database: SqliteDatabase; queries: InspectionQueryService }) {}

  public async inspect(runId: string, operation: MemoryOperation): Promise<{
    context: AgentContext; checkpointRevision: number; checkpointChecksum: string; isParent: boolean;
  } | null> {
    assertOperation(operation);
    const size = this.options.database.raw.prepare(`SELECT length(CAST(checkpoint_json AS BLOB)) AS bytes
      FROM agent_checkpoints WHERE run_id = ?`).get(runId) as { bytes: number } | undefined;
    if (size === undefined) return null;
    if (!Number.isSafeInteger(size.bytes) || size.bytes < 0) throw new MemoryError('MEMORY_DATA_INVALID');
    if (size.bytes > MAX_CHECKPOINT_BYTES) throw new MemoryError('MEMORY_CAPTURE_FAILED');
    const row = this.options.database.raw.prepare(`SELECT run_id, revision, context_version, status, stage, profile_id,
      checkpoint_schema_version, checkpoint_json, checksum, updated_at FROM agent_checkpoints WHERE run_id = ?`)
      .get(runId) as CheckpointRow | undefined;
    if (row === undefined) return null;
    const checkpoint = decodeCheckpoint(row);
    const run = await this.options.queries.getRun(runId);
    assertOperation(operation);
    if (run === null) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
    return { context: checkpoint.context, checkpointRevision: checkpoint.revision,
      checkpointChecksum: checkpoint.checksum, isParent: run.parentRunId === undefined };
  }

  public async load(request: MemoryCaptureRequest, operation: MemoryOperation): Promise<{
    context: AgentContext; evidenceRefs: readonly HistoricalEvidenceRef[];
    requiredEvidenceComplete: boolean; limitations: readonly string[];
  }> {
    const snapshot = await this.inspect(request.sourceRunId, operation);
    if (snapshot === null || snapshot.context.contextVersion !== request.sourceContextVersion
      || snapshot.checkpointChecksum !== request.sourceCheckpointChecksum || !snapshot.isParent
      || snapshot.context.status !== request.sourceRunStatus) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
    const run = await this.options.queries.getRun(request.sourceRunId);
    assertOperation(operation);
    if (run === null) throw new MemoryError('MEMORY_SOURCE_CONFLICT');

    const page = await this.options.queries.listEvidence(request.sourceRunId, { limit: MAX_EVIDENCE_PAGE });
    assertOperation(operation);
    const referencedIds = new Set(snapshot.context.evidenceIds);
    const allowedOwners = new Set([request.sourceRunId, ...run.childRunIds]);
    const refs: HistoricalEvidenceRef[] = [];
    const sourceIncomplete = new Set<HistoricalEvidenceRef['source']>();
    const limitations = new Set<string>();
    for (const evidence of page.items) {
      if (!referencedIds.has(evidence.evidenceId)) { limitations.add('EVIDENCE_NOT_REFERENCED_BY_RUN'); continue; }
      if (!allowedOwners.has(evidence.runId)) { limitations.add('EVIDENCE_OWNER_INVALID'); continue; }
      if (evidence.rawSha256 === undefined || !HASH.test(evidence.rawSha256)) {
        sourceIncomplete.add(evidence.source);
        limitations.add('EVIDENCE_HASH_INVALID');
        continue;
      }
      if (evidence.state === 'partial' || evidence.truncated === true
        || (evidence.coverage !== undefined && evidence.coverage < 1)) {
        sourceIncomplete.add(evidence.source);
        limitations.add('EVIDENCE_PARTIAL');
      }
      if (!hasValidWindow(evidence)) {
        sourceIncomplete.add(evidence.source);
        limitations.add('EVIDENCE_WINDOW_UNVERIFIABLE');
      }
      refs.push({ evidenceId: evidence.evidenceId, ownerRunId: evidence.runId,
        source: evidence.source, capturedAt: evidence.capturedAt, rawSha256: evidence.rawSha256 });
    }
    if (page.nextCursor !== undefined) {
      limitations.add('EVIDENCE_REFERENCE_LIMIT_EXCEEDED');
      for (const required of request.requiredSources) sourceIncomplete.add(required);
    }
    for (const code of run.missingEvidence.slice(0, 20)) limitations.add(safeCode(code));

    const refsBySource = new Set(refs.map((reference) => reference.source));
    const requiredEvidenceComplete = request.requiredSources.every((required) =>
      refsBySource.has(required) && !sourceIncomplete.has(required)) && run.missingEvidence.length === 0
      && page.nextCursor === undefined;
    return { context: snapshot.context, evidenceRefs: refs.slice(0, 20),
      requiredEvidenceComplete, limitations: [...limitations].slice(0, 20) };
  }
}

function decodeCheckpoint(row: CheckpointRow): StoredRunCheckpoint {
  try {
    if (Buffer.byteLength(row.checkpoint_json, 'utf8') > MAX_CHECKPOINT_BYTES) {
      throw new MemoryError('MEMORY_CAPTURE_FAILED');
    }
    const decoded: unknown = JSON.parse(row.checkpoint_json) as unknown;
    if (checkpointChecksum(decoded) !== row.checksum) throw new Error('checkpoint checksum mismatch');
    let context: AgentContext;
    switch (row.checkpoint_schema_version) {
      case 1: context = parseAgentContext(decoded, 1); break;
      case 2: context = parseAgentContext(decoded, 2); break;
      case 3: context = parseAgentContext(decoded, 3); break;
      default: throw new Error('unsupported checkpoint schema');
    }
    if (context.runId !== row.run_id || context.contextVersion !== row.context_version
      || context.status !== row.status || context.stage !== row.stage || context.profileId !== row.profile_id
      || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('checkpoint row mismatch');
    return { context, revision: row.revision, savedAt: row.updated_at, checksum: row.checksum };
  } catch { throw new StoredDataCorruptionError('checkpoint', row.run_id); }
}

function hasValidWindow(evidence: PublicEvidenceView): boolean {
  const range = evidence.timeRange ?? summaryRange(evidence.summary);
  if (range === undefined) return false;
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
}

function summaryRange(summary: Record<string, unknown>): { start: string; end: string } | undefined {
  const start = summary.start ?? summary.firstTimestamp;
  const end = summary.end ?? summary.lastTimestamp;
  const toIso = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const millis = value > 10_000_000_000 ? value : value * 1000;
      const parsed = new Date(millis).getTime();
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
    }
    return undefined;
  };
  const startIso = toIso(start);
  const endIso = toIso(end);
  return startIso === undefined || endIso === undefined ? undefined : { start: startIso, end: endIso };
}

function safeCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(normalized) ? normalized : 'SOURCE_EVIDENCE_INCOMPLETE';
}

function assertOperation(operation: MemoryOperation): void {
  operation.signal?.throwIfAborted();
  memoryInstant(operation.now);
  if (!Number.isFinite(operation.deadlineMs)) throw new MemoryError('MEMORY_DATA_INVALID');
  const nowMs = operation.clock?.now().getTime() ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs >= operation.deadlineMs) {
    throw new DOMException('Memory source deadline exceeded.', 'TimeoutError');
  }
}
