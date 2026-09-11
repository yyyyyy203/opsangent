import type { Clock } from '../../contracts/common.js';
import type { AgentContext } from '../../contracts/context.js';
import { StoredDataCorruptionError, type PendingAgentEventV2 } from '../../contracts/event-store.js';
import {
  CheckpointConflictError,
  type AgentStateUnitOfWork,
  type DurableExecutionTransition,
  type DurableTransitionUnitOfWork,
  type StoredRunCheckpoint,
  type ToolExecutionJournal,
  type ToolExecutionRecord,
  type VersionedCheckpointStore,
} from '../../contracts/storage.js';
import type { ToolExecutionResult } from '../../contracts/tool.js';
import {
  checkpointChecksum,
  parseAgentContext,
  parseToolExecutionRecord,
} from '../../storage/durable-codec.js';
import type { SqliteDatabase } from './database.js';
import { enqueueOutboxEvents } from './event-outbox-store.js';

const LEGACY_CHECKPOINT_SCHEMA_VERSION = 1;
const CHECKPOINT_SCHEMA_VERSION = 2;

interface CheckpointRow {
  run_id: string;
  revision: number;
  context_version: number;
  status: string;
  stage: string;
  profile_id: string;
  checkpoint_schema_version: number;
  checkpoint_json: string;
  checksum: string;
  created_at: string;
  updated_at: string;
}

interface ExecutionRow {
  tool_call_id: string;
  run_id: string;
  step_id: string;
  tool_name: string;
  tool_kind: string;
  input_digest: string;
  state: string;
  result_json: string | null;
  reason_code: string | null;
  prepared_at: string;
  finished_at: string | null;
}

/** SQLite control-plane implementation for checkpoint CAS and execution journal transitions. */
export class SqliteDurableStateStore implements VersionedCheckpointStore, ToolExecutionJournal, AgentStateUnitOfWork, DurableTransitionUnitOfWork {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  public load(runId: string): Promise<StoredRunCheckpoint | null> {
    return Promise.resolve().then(() => {
      const row = this.checkpointRow(runId);
      return row === undefined ? null : this.parseCheckpoint(row);
    });
  }

  public save(context: AgentContext, expectedRevision: number | null): Promise<StoredRunCheckpoint> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => (
      this.writeCheckpoint(context, expectedRevision)
    )).immediate());
  }

  public prepare(record: ToolExecutionRecord): Promise<ToolExecutionRecord> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const normalized = parseToolExecutionRecord(record);
      validatePreparedExecution(normalized);
      const row = this.executionRow(normalized.toolCallId);
      if (row !== undefined) {
        const existing = this.parseExecution(row);
        if (!sameExecutionIdentity(existing, normalized)) throw new Error(`tool execution identity collision: ${normalized.toolCallId}`);
        return existing;
      }
      this.insertExecution(normalized);
      return structuredClone(normalized);
    }).immediate());
  }

  public get(toolCallId: string): Promise<ToolExecutionRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.executionRow(toolCallId);
      return row === undefined ? null : this.parseExecution(row);
    });
  }

  public commitToolResult(input: {
    expectedRevision: number;
    context: AgentContext;
    execution: ToolExecutionRecord;
    result: ToolExecutionResult;
  }): Promise<StoredRunCheckpoint> {
    return this.commit({
      expectedRevision: input.expectedRevision,
      context: input.context,
      execution: { kind: 'completed', record: input.execution, result: input.result },
      outboxEvents: [],
    });
  }

  public markToolUncertain(input: {
    expectedRevision: number;
    context: AgentContext;
    execution: ToolExecutionRecord;
    reasonCode: string;
  }): Promise<StoredRunCheckpoint> {
    return this.commit({
      expectedRevision: input.expectedRevision,
      context: input.context,
      execution: { kind: 'uncertain', record: input.execution, reasonCode: input.reasonCode },
      outboxEvents: [],
    });
  }

  public commit(input: {
    expectedRevision: number | null;
    context: AgentContext;
    execution?: DurableExecutionTransition;
    outboxEvents: readonly PendingAgentEventV2[];
  }): Promise<StoredRunCheckpoint> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const transition = input.execution;
      const context = transition?.kind === 'completed'
        ? appendCompletedResult(input.context, transition.result)
        : structuredClone(input.context);
      let existing: ToolExecutionRecord | undefined;
      let execution: ToolExecutionRecord | undefined;
      // Keep the established CAS-first result contract.  The checkpoint write
      // remains inside this transaction, so an execution or outbox failure
      // below rolls the write back without weakening atomicity.
      if (transition?.kind === 'uncertain') {
        existing = this.requireExecution(transition.record);
        execution = uncertainExecution(existing, transition.reasonCode, this.clock);
      }
      const checkpoint = this.writeCheckpoint(
        context,
        input.expectedRevision,
        transition?.kind === 'uncertain' && existing?.state === 'prepared',
      );
      if (transition?.kind === 'completed') {
        existing = this.requireExecution(transition.record);
        execution = completedExecution(existing, transition.result, this.clock);
      }
      if (execution !== undefined) this.updateExecution(execution);
      enqueueOutboxEvents(
        this.database,
        { events: input.outboxEvents, createdAt: this.clock.now().toISOString() },
        { expectedRunId: checkpoint.context.runId },
      );
      return checkpoint;
    }).immediate());
  }

  private requireExecution(incoming: ToolExecutionRecord): ToolExecutionRecord {
    const row = this.executionRow(incoming.toolCallId);
    if (row === undefined) throw new Error(`prepared tool execution not found: ${incoming.toolCallId}`);
    const existing = this.parseExecution(row);
    if (!sameExecutionIdentity(existing, incoming)) throw new Error(`tool execution identity collision: ${incoming.toolCallId}`);
    return existing;
  }

  private writeCheckpoint(
    context: AgentContext,
    expectedRevision: number | null,
    forceRevisionAdvance = false,
  ): StoredRunCheckpoint {
    const normalized = parseAgentContext(context);
    const row = this.checkpointRow(normalized.runId);
    const current = row === undefined ? undefined : this.parseCheckpoint(row);
    const checksum = checkpointChecksum(normalized);
    const actualRevision = current?.revision ?? null;
    const validCreate = current === undefined && expectedRevision === null;
    const validUpdate = current !== undefined && expectedRevision === actualRevision;
    if (!validCreate && !validUpdate) {
      throw new CheckpointConflictError(normalized.runId, expectedRevision, actualRevision);
    }
    if (current !== undefined && current.checksum === checksum && !forceRevisionAdvance) return current;

    const savedAt = this.clock.now().toISOString();
    const checkpoint: StoredRunCheckpoint = {
      context: structuredClone(normalized),
      revision: (actualRevision ?? 0) + 1,
      savedAt,
      checksum,
    };
    const checkpointJson = JSON.stringify(checkpoint.context);
    if (current === undefined) {
      this.database.raw.prepare(`
        INSERT INTO agent_checkpoints(
          run_id, revision, context_version, status, stage, profile_id, checkpoint_schema_version,
          checkpoint_json, checksum, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.runId, checkpoint.revision, normalized.contextVersion, normalized.status, normalized.stage, normalized.profileId,
        CHECKPOINT_SCHEMA_VERSION, checkpointJson, checksum, savedAt, savedAt,
      );
    } else {
      const update = this.database.raw.prepare(`
        UPDATE agent_checkpoints
        SET revision = ?, context_version = ?, status = ?, stage = ?, profile_id = ?,
            checkpoint_schema_version = ?, checkpoint_json = ?, checksum = ?, updated_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(
        checkpoint.revision, normalized.contextVersion, normalized.status, normalized.stage, normalized.profileId,
        CHECKPOINT_SCHEMA_VERSION, checkpointJson, checksum, savedAt,
        normalized.runId, current.revision,
      );
      if (update.changes !== 1) {
        const latest = this.checkpointRow(normalized.runId);
        throw new CheckpointConflictError(normalized.runId, expectedRevision, latest?.revision ?? null);
      }
    }
    return structuredClone(checkpoint);
  }

  private checkpointRow(runId: string): CheckpointRow | undefined {
    return this.database.raw.prepare(`
      SELECT run_id, revision, context_version, status, stage, profile_id, checkpoint_schema_version,
             checkpoint_json, checksum, created_at, updated_at
      FROM agent_checkpoints WHERE run_id = ?
    `).get(runId) as CheckpointRow | undefined;
  }

  private executionRow(toolCallId: string): ExecutionRow | undefined {
    return this.database.raw.prepare(`
      SELECT tool_call_id, run_id, step_id, tool_name, tool_kind, input_digest, state,
             result_json, reason_code, prepared_at, finished_at
      FROM tool_executions WHERE tool_call_id = ?
    `).get(toolCallId) as ExecutionRow | undefined;
  }

  private insertExecution(record: ToolExecutionRecord): void {
    this.database.raw.prepare(`
      INSERT INTO tool_executions(
        tool_call_id, run_id, step_id, tool_name, tool_kind, input_digest, state,
        result_json, reason_code, prepared_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.toolCallId, record.runId, record.stepId, record.toolName, record.toolKind, record.inputDigest,
      record.state, null, null, record.preparedAt, null,
    );
  }

  private updateExecution(record: ToolExecutionRecord): void {
    const resultJson = record.result === undefined ? null : JSON.stringify(record.result);
    const update = this.database.raw.prepare(`
      UPDATE tool_executions
      SET state = ?, result_json = ?, reason_code = ?, finished_at = ?
      WHERE tool_call_id = ?
    `).run(record.state, resultJson, record.reasonCode ?? null, record.finishedAt ?? null, record.toolCallId);
    if (update.changes !== 1) throw new Error(`tool execution disappeared during update: ${record.toolCallId}`);
  }

  private parseCheckpoint(row: CheckpointRow): StoredRunCheckpoint {
    try {
      const decoded: unknown = JSON.parse(row.checkpoint_json) as unknown;
      const storedChecksum = checkpointChecksum(decoded);
      const context = parseAgentContext(decoded);
      const checksum = row.checkpoint_schema_version === LEGACY_CHECKPOINT_SCHEMA_VERSION
        ? storedChecksum
        : checkpointChecksum(context);
      if (!Number.isSafeInteger(row.revision) || row.revision <= 0
        || (row.checkpoint_schema_version !== LEGACY_CHECKPOINT_SCHEMA_VERSION
          && row.checkpoint_schema_version !== CHECKPOINT_SCHEMA_VERSION)
        || context.runId !== row.run_id
        || context.contextVersion !== row.context_version
        || context.status !== row.status
        || context.stage !== row.stage
        || context.profileId !== row.profile_id
        || checksum !== row.checksum) {
        throw new Error('checkpoint row integrity mismatch');
      }
      return { context, revision: row.revision, savedAt: row.updated_at, checksum: row.checksum };
    } catch {
      throw new StoredDataCorruptionError('checkpoint', row.run_id);
    }
  }

  private parseExecution(row: ExecutionRow): ToolExecutionRecord {
    try {
      const result: unknown = row.result_json === null ? undefined : JSON.parse(row.result_json) as unknown;
      return parseToolExecutionRecord({
        toolCallId: row.tool_call_id,
        runId: row.run_id,
        stepId: row.step_id,
        toolName: row.tool_name,
        toolKind: row.tool_kind,
        inputDigest: row.input_digest,
        state: row.state,
        ...(result === undefined ? {} : { result }),
        ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
        preparedAt: row.prepared_at,
        ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      });
    } catch {
      throw new StoredDataCorruptionError('tool_execution', row.tool_call_id);
    }
  }
}

function completedExecution(existing: ToolExecutionRecord, result: ToolExecutionResult, clock: Clock): ToolExecutionRecord {
  if (existing.toolCallId !== result.toolCallId || existing.toolName !== result.toolName) {
    throw new Error(`tool result does not match execution: ${result.toolCallId}`);
  }
  if (result.status === 'interrupted' || result.status === 'awaiting_external') {
    throw new Error(`tool result is not terminal: ${result.toolCallId}`);
  }
  const state = result.status === 'success' ? 'succeeded' : 'failed';
  if (existing.state !== 'prepared') {
    if (existing.state === state && existing.result !== undefined && sameJson(existing.result, result)) return structuredClone(existing);
    throw new Error(`tool execution is already terminal: ${result.toolCallId}`);
  }
  return {
    ...structuredClone(existing),
    state,
    result: structuredClone(result),
    finishedAt: result.finishedAt ?? clock.now().toISOString(),
  };
}

function uncertainExecution(existing: ToolExecutionRecord, reasonCode: string, clock: Clock): ToolExecutionRecord {
  if (reasonCode.length === 0) throw new Error('uncertain tool execution requires a reason code');
  if (existing.state === 'uncertain') {
    if (existing.reasonCode === reasonCode) return structuredClone(existing);
    throw new Error(`tool execution uncertainty conflicts: ${existing.toolCallId}`);
  }
  if (existing.state !== 'prepared') throw new Error(`tool execution is already terminal: ${existing.toolCallId}`);
  return { ...structuredClone(existing), state: 'uncertain', reasonCode, finishedAt: clock.now().toISOString() };
}

function appendCompletedResult(context: AgentContext, result: ToolExecutionResult): AgentContext {
  const batch = context.pendingToolBatch;
  if (batch === undefined) throw new Error(`pending batch is required for tool result: ${result.toolCallId}`);
  const call = batch.calls.find((candidate) => candidate.id === result.toolCallId);
  if (call === undefined || call.name !== result.toolName) throw new Error(`tool result does not belong to pending batch: ${result.toolCallId}`);
  const existing = batch.completedResults.find((candidate) => candidate.toolCallId === result.toolCallId);
  if (existing !== undefined) {
    if (!sameJson(existing, result)) throw new Error(`pending batch result conflicts: ${result.toolCallId}`);
    return structuredClone(context);
  }
  return {
    ...structuredClone(context),
    pendingToolBatch: {
      ...structuredClone(batch),
      completedResults: [...batch.completedResults.map((item) => structuredClone(item)), structuredClone(result)],
    },
  };
}

function validatePreparedExecution(record: ToolExecutionRecord): void {
  if (record.toolCallId.length === 0 || record.runId.length === 0 || record.stepId.length === 0 || record.toolName.length === 0 || record.inputDigest.length === 0) {
    throw new Error('prepared tool execution requires stable identity fields');
  }
  if (record.state !== 'prepared' || record.result !== undefined || record.finishedAt !== undefined || record.reasonCode !== undefined) {
    throw new Error('journal prepare only accepts a new prepared execution');
  }
}

function sameExecutionIdentity(left: ToolExecutionRecord, right: ToolExecutionRecord): boolean {
  return left.toolCallId === right.toolCallId
    && left.runId === right.runId
    && left.stepId === right.stepId
    && left.toolName === right.toolName
    && left.toolKind === right.toolKind
    && left.inputDigest === right.inputDigest;
}

function sameJson(left: unknown, right: unknown): boolean {
  return checkpointChecksum(left) === checkpointChecksum(right);
}
