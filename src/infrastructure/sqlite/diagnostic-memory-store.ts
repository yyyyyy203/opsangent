import type { Clock } from '../../contracts/common.js';
import type { DiagnosticMemoryCase, MemoryStatus } from '../../contracts/diagnostic-memory.js';
import { parseAgentContext } from '../../storage/durable-codec.js';
import { parseAgentEventV2 } from '../../contracts/event-v2/schema.js';
import type { PendingAgentEventV2 } from '../../contracts/event-store.js';
import type { StoredRunCheckpoint } from '../../contracts/storage.js';
import { canonicalJson, checkpointChecksum } from '../../contracts/stable-json.js';
import { memoryScopeKey } from '../../memory/memory-scope.js';
import type { DiagnosticMemoryRepository, MemoryJob } from '../../memory/diagnostic-memory-state.js';
import {
  boundedMemoryJson, DiagnosticMemoryStoreCore, memoryIndexText, memoryInstant, memoryLimit,
  parseMemoryCaptureCommand, parseMemoryCase, parseMemoryRequest, parseMemoryReviewCommand,
  parseMemorySignal, parseMemoryTicket,
} from '../../memory/diagnostic-memory-state.js';
import { MemoryError } from '../../memory/memory-error.js';
import type { SqliteDatabase } from './database.js';
import { enqueueOutboxEvents } from './event-outbox-store.js';

interface CheckpointRow {
  run_id: string; revision: number; context_version: number; status: string; stage: string;
  profile_id: string; checkpoint_schema_version: number; checkpoint_json: string; checksum: string;
  updated_at: string;
}
interface CaseRow { id: string; scope_key: string; case_json: string; case_checksum: string; index_version: string }
interface JobRow {
  candidate_id: string; source_run_id: string; scope_key: string; source_checkpoint_revision: number; state: MemoryJob['state'];
  attempt: number; owner_id: string | null; lease_until: string | null; request_json: string; request_checksum: string;
  terminal_failure_event_json: string; failure_event_checksum: string; memory_id: string | null;
  reason_code: string | null; index_version: string;
}
interface CaptureCommandRow {
  request_id: string; command_digest: string; command_json: string; command_checksum: string;
  original_ticket_json: string; ticket_checksum: string;
}
interface ReviewRow {
  request_id: string; command_digest: string; command_json: string; command_checksum: string;
  original_result_json: string; result_checksum: string;
}
/** SQLite implementation of the governed case, review, job, and signal repository. */
export class SqliteDiagnosticMemoryStore extends DiagnosticMemoryStoreCore {
  public constructor(private readonly database: SqliteDatabase, input: { clock: Clock }) { super(input.clock); }

  protected read<T>(operation: (repo: DiagnosticMemoryRepository) => T): Promise<T> {
    return Promise.resolve().then(() => operation(createSqliteDiagnosticMemoryRepository(this.database)));
  }

  protected transact<T>(operation: (repo: DiagnosticMemoryRepository) => T): Promise<T> {
    return Promise.resolve().then(() => this.database.raw.transaction(() =>
      operation(createSqliteDiagnosticMemoryRepository(this.database))).immediate());
  }
}

/** Repository mutations have no transaction of their own; callers own the SQLite transaction. */
export function createSqliteDiagnosticMemoryRepository(database: SqliteDatabase): DiagnosticMemoryRepository {
  const raw = database.raw;
  return {
    checkpoint: (runId) => readCheckpoint(runId),
    isChild: (runId) => {
      const row = raw.prepare(`SELECT 1 AS found FROM (
        SELECT run_id, event_json, type FROM agent_events
        UNION ALL
        SELECT run_id, event_json, json_extract(event_json, '$.type') AS type FROM durable_event_outbox
      ) WHERE (type = 'SUBAGENT_STARTED' AND json_extract(event_json, '$.payload.childRunId') = ?)
        OR (run_id = ? AND json_extract(event_json, '$.parentRunId') IS NOT NULL) LIMIT 1`).get(runId, runId);
      return row !== undefined;
    },
    getCase: (id, scopeKey) => {
      const row = raw.prepare(`SELECT id, scope_key, case_json, case_checksum, index_version
        FROM diagnostic_memory_cases WHERE id = ? AND scope_key = ?`).get(id, scopeKey) as CaseRow | undefined;
      return row === undefined ? null : readCase(row);
    },
    listCases: (scopeKey, status, afterId, limit) => {
      const size = memoryLimit(limit, 100);
      const rows = status === undefined
        ? raw.prepare(`SELECT id, scope_key, case_json, case_checksum, index_version FROM diagnostic_memory_cases
          WHERE scope_key = ? AND (? IS NULL OR id > ?) ORDER BY id COLLATE BINARY LIMIT ?`)
          .all(scopeKey, afterId ?? null, afterId ?? null, size) as CaseRow[]
        : raw.prepare(`SELECT id, scope_key, case_json, case_checksum, index_version FROM diagnostic_memory_cases
          WHERE scope_key = ? AND status = ? AND (? IS NULL OR id > ?) ORDER BY id COLLATE BINARY LIMIT ?`)
          .all(scopeKey, status, afterId ?? null, afterId ?? null, size) as CaseRow[];
      return rows.map(readCase);
    },
    countCases: (scopeKey, status) => {
      const row = raw.prepare('SELECT COUNT(*) AS count FROM diagnostic_memory_cases WHERE scope_key = ? AND status = ?')
        .get(scopeKey, status) as { count: number };
      return row.count;
    },
    putCase: (input, expectedRevision) => {
      const value = parseMemoryCase(input);
      const scopeKey = memoryScopeKey(value.scope);
      const json = boundedMemoryJson(value);
      const checksum = checkpointChecksum(value);
      const existing = raw.prepare('SELECT revision, scope_key, status FROM diagnostic_memory_cases WHERE id = ?')
        .get(value.id) as { revision: number; scope_key: string; status: MemoryStatus } | undefined;
      if (expectedRevision !== undefined) {
        if (existing === undefined || existing.revision !== expectedRevision || existing.scope_key !== scopeKey) {
          throw new MemoryError('MEMORY_REVISION_CONFLICT');
        }
      } else {
        if (existing !== undefined || value.status !== 'observation'
          || raw.prepare('SELECT 1 FROM diagnostic_memory_cases WHERE source_run_id = ? AND extractor_version = ?')
            .get(value.sourceRunId, value.extractorVersion) !== undefined) {
          throw new MemoryError('MEMORY_REQUEST_CONFLICT');
        }
      }
      if (existing !== undefined) {
        const oldRow = raw.prepare(`SELECT id, scope_key, case_json, case_checksum, index_version
          FROM diagnostic_memory_cases WHERE id = ?`).get(value.id) as CaseRow;
        if (!sameReviewedCaseContent(readCase(oldRow), value)) throw new MemoryError('MEMORY_DATA_INVALID');
      }
      if (existing?.status !== value.status && value.status === 'observation'
        && countCases(scopeKey, 'observation') >= 100) throw new MemoryError('MEMORY_CAPACITY_EXCEEDED');
      if (existing?.status !== value.status && value.status === 'approved'
        && countCases(scopeKey, 'approved') >= 1000) throw new MemoryError('MEMORY_CAPACITY_EXCEEDED');
      if (existing === undefined) {
        raw.prepare(`INSERT INTO diagnostic_memory_cases(id, scope_key, profile_id, profile_revision, service_id,
          fault_type, target_fingerprint, environment, data_class, dataset_id, source_run_id, extractor_version,
          source_run_status, captured_at, valid_until, revision, status, quality, case_json, case_checksum, index_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(value.id, scopeKey, value.scope.profileId, value.scope.profileRevision, value.scope.serviceId,
            value.scope.faultType, value.scope.targetFingerprint, value.scope.environment, value.scope.dataClass,
            value.scope.dataClass === 'simulated' ? value.scope.datasetId : null, value.sourceRunId,
            value.extractorVersion, value.sourceRunStatus, value.capturedAt, value.validUntil, value.revision,
            value.status, value.quality, json, checksum, 'episodic-tokens-v1');
      } else {
        const update = raw.prepare(`UPDATE diagnostic_memory_cases SET revision = ?, status = ?, quality = ?,
          valid_until = ?, case_json = ?, case_checksum = ?
          WHERE id = ? AND scope_key = ? AND revision = ?`)
          .run(value.revision, value.status, value.quality, value.validUntil, json, checksum,
            value.id, scopeKey, expectedRevision);
        if (update.changes !== 1) throw new MemoryError('MEMORY_REVISION_CONFLICT');
      }
      raw.prepare('DELETE FROM diagnostic_memory_case_fts WHERE memory_id = ?').run(value.id);
      if (value.status === 'approved') {
        raw.prepare('INSERT INTO diagnostic_memory_case_fts(tokens, memory_id) VALUES (?, ?)').run(memoryIndexText(value), value.id);
      }
    },
    jobForRun: (runId) => {
      const row = raw.prepare(`SELECT candidate_id, source_run_id, scope_key, source_checkpoint_revision, state, attempt,
        owner_id, lease_until, request_json, request_checksum, terminal_failure_event_json,
        failure_event_checksum, memory_id, reason_code, index_version FROM diagnostic_memory_capture_jobs
        WHERE source_run_id = ?`).get(runId) as JobRow | undefined;
      return row === undefined ? null : readJob(row);
    },
    job: (candidateId) => {
      const row = raw.prepare(`SELECT candidate_id, source_run_id, scope_key, source_checkpoint_revision, state, attempt,
        owner_id, lease_until, request_json, request_checksum, terminal_failure_event_json,
        failure_event_checksum, memory_id, reason_code, index_version FROM diagnostic_memory_capture_jobs
        WHERE candidate_id = ?`).get(candidateId) as JobRow | undefined;
      return row === undefined ? null : readJob(row);
    },
    pendingJob: () => {
      const row = raw.prepare(`SELECT candidate_id, source_run_id, scope_key, source_checkpoint_revision, state, attempt,
        owner_id, lease_until, request_json, request_checksum, terminal_failure_event_json,
        failure_event_checksum, memory_id, reason_code, index_version FROM diagnostic_memory_capture_jobs
        WHERE state = 'pending' ORDER BY candidate_id COLLATE BINARY LIMIT 1`).get() as JobRow | undefined;
      return row === undefined ? null : readJob(row);
    },
    expiredJobs: (now, limit) => {
      const rows = raw.prepare(`SELECT candidate_id, source_run_id, scope_key, source_checkpoint_revision, state, attempt,
        owner_id, lease_until, request_json, request_checksum, terminal_failure_event_json,
        failure_event_checksum, memory_id, reason_code, index_version FROM diagnostic_memory_capture_jobs
        WHERE state = 'running' AND lease_until <= ? ORDER BY lease_until, candidate_id COLLATE BINARY LIMIT ?`)
        .all(memoryInstant(now), memoryLimit(limit, 50)) as JobRow[];
      return rows.map(readJob);
    },
    activeJobs: () => (raw.prepare("SELECT COUNT(*) AS count FROM diagnostic_memory_capture_jobs WHERE state IN ('pending', 'running')")
      .get() as { count: number }).count,
    putJob: (job, expected) => {
      const request = parseMemoryRequest(job.request);
      const requestJson = boundedMemoryJson(request);
      const failureJson = boundedMemoryJson(job.terminalFailureEvent);
      const normalizedEvent = parseFailureEvent(job.terminalFailureEvent);
      if (normalizedEvent.runId !== request.sourceRunId || normalizedEvent.type !== 'MEMORY_UPDATE_FAILED'
        || normalizedEvent.payload.candidateId !== request.candidateId) throw new MemoryError('MEMORY_DATA_INVALID');
      if (expected === undefined) {
        if (countActiveJobs() >= 1000) throw new MemoryError('MEMORY_CAPACITY_EXCEEDED');
        raw.prepare(`INSERT INTO diagnostic_memory_capture_jobs(candidate_id, source_run_id, extractor_version,
          scope_key, source_checkpoint_revision, state, attempt, owner_id, lease_until, request_json,
          request_checksum, terminal_failure_event_json, failure_event_checksum, memory_id, reason_code, index_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(request.candidateId, request.sourceRunId, request.extractorVersion, memoryScopeKey(request.scope),
            job.sourceCheckpointRevision, job.state, job.attempt, job.ownerId, job.leaseUntil, requestJson,
            checkpointChecksum(request), failureJson, checkpointChecksum(normalizedEvent), job.memoryId ?? null,
            job.reasonCode ?? null, 'episodic-jobs-v1');
        return;
      }
      const current = getJob(job.request.candidateId);
      if (current === null || checkpointChecksum(current) !== checkpointChecksum(expected)) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
      const update = raw.prepare(`UPDATE diagnostic_memory_capture_jobs SET state = ?, attempt = ?, owner_id = ?,
        lease_until = ?, memory_id = ?, reason_code = ? WHERE candidate_id = ? AND attempt = ? AND state = ?`)
        .run(job.state, job.attempt, job.ownerId, job.leaseUntil, job.memoryId ?? null, job.reasonCode ?? null,
          job.request.candidateId, expected.attempt, expected.state);
      if (update.changes !== 1) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
    },
    captureCommand: (requestId) => {
      const row = raw.prepare(`SELECT request_id, command_digest, command_json, command_checksum,
        original_ticket_json, ticket_checksum FROM diagnostic_memory_capture_commands WHERE request_id = ?`)
        .get(requestId) as CaptureCommandRow | undefined;
      if (row === undefined) return null;
      const command = parseMemoryCaptureCommand(verifiedJson(row.command_json, row.command_checksum));
      const ticket = parseMemoryTicket(verifiedJson(row.original_ticket_json, row.ticket_checksum));
      if (command.requestId !== row.request_id) throw new MemoryError('MEMORY_DATA_INVALID');
      return { command, digest: row.command_digest, ticket };
    },
    putCaptureCommand: (record) => {
      const command = parseMemoryCaptureCommand(record.command);
      const ticket = parseMemoryTicket(record.ticket);
      const commandJson = boundedMemoryJson(command);
      const ticketJson = boundedMemoryJson(ticket);
      raw.prepare(`INSERT INTO diagnostic_memory_capture_commands(request_id, source_run_id, scope_key, actor_id,
        expected_checkpoint_revision, command_digest, command_json, command_checksum, original_ticket_json, ticket_checksum)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(command.requestId, command.sourceRunId, memoryScopeKey(command.scope),
          command.actorId, command.expectedCheckpointRevision, record.digest, commandJson,
          checkpointChecksum(command), ticketJson, checkpointChecksum(ticket));
    },
    reviewCommand: (requestId) => {
      const row = raw.prepare(`SELECT request_id, command_digest, command_json, command_checksum,
        original_result_json, result_checksum FROM diagnostic_memory_reviews WHERE request_id = ?`)
        .get(requestId) as ReviewRow | undefined;
      if (row === undefined) return null;
      const command = parseMemoryReviewCommand(verifiedJson(row.command_json, row.command_checksum));
      const result = parseMemoryCase(verifiedJson(row.original_result_json, row.result_checksum));
      if (command.requestId !== row.request_id) throw new MemoryError('MEMORY_DATA_INVALID');
      return { command, digest: row.command_digest, result };
    },
    putReviewCommand: (record) => {
      const command = parseMemoryReviewCommand(record.command);
      const result = parseMemoryCase(record.result);
      const commandJson = boundedMemoryJson(command);
      const resultJson = boundedMemoryJson(result);
      raw.prepare(`INSERT INTO diagnostic_memory_reviews(request_id, memory_id, scope_key, actor_id, decision,
        claim_check, expected_revision, command_digest, command_json, command_checksum, original_result_json,
        result_checksum, result_revision, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(command.requestId, command.memoryId, memoryScopeKey(command.scope), command.actorId,
          command.decision, command.claimCheck, command.expectedRevision, record.digest,
          commandJson, checkpointChecksum(command), resultJson, checkpointChecksum(result),
          result.revision, command.reviewedAt);
    },
    putSignal: (key, signal) => {
      const normalized = parseMemorySignal(signal);
      const json = boundedMemoryJson(normalized);
      const existing = raw.prepare('SELECT signal_checksum FROM diagnostic_memory_signals WHERE signal_key = ?')
        .get(key) as { signal_checksum: string } | undefined;
      const checksum = checkpointChecksum(normalized);
      if (existing !== undefined) {
        if (existing.signal_checksum !== checksum) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
        return;
      }
      raw.prepare(`INSERT OR IGNORE INTO diagnostic_memory_signals(signal_key, run_id, tool_call_id, phase,
        observed_at, signal_json, signal_checksum, index_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(key, normalized.runId, normalized.toolCallId, normalized.phase, memoryInstant(normalized.observedAt), json,
          checksum, 'tool-outcome-v1');
    },
    prune: (now, limit) => {
      const instant = memoryInstant(now);
      const size = memoryLimit(limit, 50);
      const cases = raw.prepare(`SELECT id FROM diagnostic_memory_cases WHERE status = 'observation' AND valid_until <= ?
        ORDER BY valid_until, id COLLATE BINARY LIMIT ?`).all(instant, size) as { id: string }[];
      const removeIndex = raw.prepare('DELETE FROM diagnostic_memory_case_fts WHERE memory_id = ?');
      const removeCase = raw.prepare("DELETE FROM diagnostic_memory_cases WHERE id = ? AND status = 'observation'");
      for (const row of cases) { removeIndex.run(row.id); removeCase.run(row.id); }
      const remaining = size - cases.length;
      const signals = raw.prepare(`SELECT signal_key FROM diagnostic_memory_signals WHERE observed_at <= ?
        ORDER BY observed_at, signal_key COLLATE BINARY LIMIT ?`)
        .all(new Date(Date.parse(instant) - 7 * 86_400_000).toISOString(), remaining) as { signal_key: string }[];
      const removeSignal = raw.prepare('DELETE FROM diagnostic_memory_signals WHERE signal_key = ?');
      for (const row of signals) removeSignal.run(row.signal_key);
      return { expiredObservations: cases.length, signalsRemoved: signals.length };
    },
    enqueue: (events, now, expectedRunId) => {
      enqueueOutboxEvents(database, { events, createdAt: memoryInstant(now) }, { expectedRunId });
    },
  };

  function readCheckpoint(runId: string): StoredRunCheckpoint | null {
    const row = raw.prepare(`SELECT run_id, revision, context_version, status, stage, profile_id,
      checkpoint_schema_version, checkpoint_json, checksum, updated_at FROM agent_checkpoints WHERE run_id = ?`)
      .get(runId) as CheckpointRow | undefined;
    if (row === undefined) return null;
    try {
      const decoded: unknown = JSON.parse(row.checkpoint_json) as unknown;
      if (checkpointChecksum(decoded) !== row.checksum) throw new Error('checksum mismatch');
      if (row.checkpoint_schema_version !== 1 && row.checkpoint_schema_version !== 2 && row.checkpoint_schema_version !== 3) {
        throw new Error('unsupported checkpoint schema');
      }
      const context = parseAgentContext(decoded, row.checkpoint_schema_version);
      if (context.runId !== row.run_id || context.status !== row.status || context.contextVersion !== row.context_version
        || context.profileId !== row.profile_id || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('row mismatch');
      return { context, revision: row.revision, checksum: row.checksum, savedAt: row.updated_at };
    } catch { throw new MemoryError('MEMORY_DATA_INVALID'); }
  }

  function readCase(row: CaseRow): DiagnosticMemoryCase {
    try {
      const parsed: unknown = JSON.parse(row.case_json) as unknown;
      if (checkpointChecksum(parsed) !== row.case_checksum || canonicalJson(parsed) !== row.case_json
        || row.index_version !== 'episodic-tokens-v1') throw new Error('case checksum mismatch');
      const value = parseMemoryCase(parsed);
      if (value.id !== row.id || memoryScopeKey(value.scope) !== row.scope_key) throw new Error('case identity mismatch');
      const columns = raw.prepare(`SELECT revision, status, quality, source_run_id, captured_at,
        valid_until, extractor_version FROM diagnostic_memory_cases WHERE id = ?`)
        .get(row.id) as { revision: number; status: string; quality: string; source_run_id: string;
          captured_at: string; valid_until: string; extractor_version: string } | undefined;
      if (columns === undefined || columns.revision !== value.revision || columns.status !== value.status
        || columns.quality !== value.quality || columns.source_run_id !== value.sourceRunId
        || columns.captured_at !== value.capturedAt || columns.valid_until !== value.validUntil
        || columns.extractor_version !== value.extractorVersion) throw new Error('case columns do not match');
      const index = raw.prepare('SELECT tokens FROM diagnostic_memory_case_fts WHERE memory_id = ?').get(row.id) as { tokens: string } | undefined;
      if ((value.status === 'approved' && index?.tokens !== memoryIndexText(value))
        || (value.status !== 'approved' && index !== undefined)) throw new Error('case index mismatch');
      return value;
    } catch { throw new MemoryError('MEMORY_DATA_INVALID'); }
  }

  function getJob(candidateId: string): MemoryJob | null {
    const row = raw.prepare(`SELECT candidate_id, source_run_id, scope_key, source_checkpoint_revision, state, attempt,
      owner_id, lease_until, request_json, request_checksum, terminal_failure_event_json,
      failure_event_checksum, memory_id, reason_code, index_version FROM diagnostic_memory_capture_jobs
      WHERE candidate_id = ?`).get(candidateId) as JobRow | undefined;
    return row === undefined ? null : readJob(row);
  }

  function readJob(row: JobRow): MemoryJob {
    try {
      const request = parseMemoryRequest(verifiedJson(row.request_json, row.request_checksum));
      const event = parseFailureEvent(verifiedJson(row.terminal_failure_event_json, row.failure_event_checksum));
      if (row.index_version !== 'episodic-jobs-v1' || request.candidateId !== row.candidate_id
        || request.sourceRunId !== row.source_run_id || memoryScopeKey(request.scope) !== row.scope_key
        || event.runId !== request.sourceRunId || event.payload.candidateId !== request.candidateId
        || !Number.isSafeInteger(row.attempt) || row.attempt < 0 || row.attempt > 2
        || !Number.isSafeInteger(row.source_checkpoint_revision) || row.source_checkpoint_revision < 1
        || !['pending', 'running', 'completed', 'failed', 'skipped'].includes(row.state)
        || (row.state === 'running') !== (row.owner_id !== null && row.lease_until !== null)
        || (row.state === 'completed') !== (row.memory_id !== null)
        || (row.state === 'failed') !== (row.reason_code !== null)) throw new Error('job identity mismatch');
      return { request, sourceCheckpointRevision: row.source_checkpoint_revision, state: row.state, attempt: row.attempt,
        ownerId: row.owner_id, leaseUntil: row.lease_until, terminalFailureEvent: event,
        ...(row.memory_id === null ? {} : { memoryId: row.memory_id }),
        ...(row.reason_code === null ? {} : { reasonCode: row.reason_code as NonNullable<MemoryJob['reasonCode']> }) };
    } catch { throw new MemoryError('MEMORY_DATA_INVALID'); }
  }

  function countCases(scopeKey: string, status: MemoryStatus): number {
    const row = raw.prepare('SELECT COUNT(*) AS count FROM diagnostic_memory_cases WHERE scope_key = ? AND status = ?')
      .get(scopeKey, status) as { count: number };
    return row.count;
  }

  function countActiveJobs(): number {
    return (raw.prepare("SELECT COUNT(*) AS count FROM diagnostic_memory_capture_jobs WHERE state IN ('pending', 'running')")
      .get() as { count: number }).count;
  }
}

function sameReviewedCaseContent(left: DiagnosticMemoryCase, right: DiagnosticMemoryCase): boolean {
  const project = (value: DiagnosticMemoryCase) => {
    const { revision, status, eligibleForPromotion, ...content } = value;
    void revision;
    void status;
    void eligibleForPromotion;
    return content;
  };
  return canonicalJson(project(left)) === canonicalJson(project(right));
}

function verifiedJson<T>(json: string, checksum: string): T {
  try {
    const value: unknown = JSON.parse(json) as unknown;
    if (checkpointChecksum(value) !== checksum || canonicalJson(value) !== json) throw new Error('checksum mismatch');
    return value as T;
  } catch { throw new MemoryError('MEMORY_DATA_INVALID'); }
}

function parseFailureEvent(value: unknown): PendingAgentEventV2<'MEMORY_UPDATE_FAILED'> {
  const parsed = parseAgentEventV2(typeof value === 'object' && value !== null
    ? { ...value, sequence: 1 } : value);
  if (parsed.type !== 'MEMORY_UPDATE_FAILED') throw new MemoryError('MEMORY_DATA_INVALID');
  const { sequence: _sequence, ...pending } = parsed;
  void _sequence;
  return pending;
}
