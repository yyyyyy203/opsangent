import { systemClock, type Clock } from '../contracts/common.js';
import type { AgentContext } from '../contracts/context.js';
import { EventIdConflictError, type PendingAgentEventV2 } from '../contracts/event-store.js';
import { parseAgentEventV2 } from '../contracts/event-v2/schema.js';
import {
  CheckpointConflictError,
  type AgentStateUnitOfWork,
  type DurableEventOutbox,
  type DurableExecutionTransition,
  type DurableOutboxRecord,
  type DurableRunState,
  type DurableTransitionUnitOfWork,
  type EvidencePage,
  type EvidenceQueryStore,
  type EvidenceRecord,
  type EvidenceStore,
  type StoredRunCheckpoint,
  type ToolExecutionJournal,
  type ToolExecutionRecord,
  type VersionedCheckpointStore,
} from '../contracts/storage.js';
import type { ToolExecutionResult } from '../contracts/tool.js';
import { checkpointChecksum, parseAgentContext } from './durable-codec.js';

const DEFAULT_EVIDENCE_PAGE_SIZE = 50;
const MAX_EVIDENCE_PAGE_SIZE = 100;

/**
 * Deterministic in-memory implementation of the durable Run state contracts.
 * It is intentionally a test/default-runtime implementation, not a persistence fallback.
 */
export class InMemoryDurableState implements DurableRunState, VersionedCheckpointStore, ToolExecutionJournal, AgentStateUnitOfWork, DurableTransitionUnitOfWork, DurableEventOutbox {
  private readonly checkpointRecords = new Map<string, StoredRunCheckpoint>();
  private readonly executionRecords = new Map<string, ToolExecutionRecord>();
  private readonly outboxRecords = new Map<string, DurableOutboxRecord>();

  public readonly checkpoints: VersionedCheckpointStore = this;
  public readonly executions: ToolExecutionJournal = this;
  public readonly stateUnitOfWork: AgentStateUnitOfWork = this;
  public readonly transitions: DurableTransitionUnitOfWork = this;
  public readonly outbox: DurableEventOutbox = this;

  public readonly evidence = new InMemoryEvidenceRepository();

  public constructor(private readonly clock: Clock = systemClock) {}

  public load(runId: string): Promise<StoredRunCheckpoint | null> {
    const checkpoint = this.checkpointRecords.get(runId);
    return Promise.resolve(checkpoint === undefined ? null : clone(checkpoint));
  }

  public save(context: AgentContext, expectedRevision: number | null): Promise<StoredRunCheckpoint> {
    return Promise.resolve().then(() => {
      const checkpoint = this.nextCheckpoint(context, expectedRevision);
      this.checkpointRecords.set(context.runId, clone(checkpoint));
      return clone(checkpoint);
    });
  }

  public prepare(record: ToolExecutionRecord): Promise<ToolExecutionRecord> {
    return Promise.resolve().then(() => {
      validatePreparedExecution(record);
      const existing = this.executionRecords.get(record.toolCallId);
      if (existing !== undefined) {
        if (!sameExecutionIdentity(existing, record)) throw new Error(`tool execution identity collision: ${record.toolCallId}`);
        return clone(existing);
      }
      const stored = clone(record);
      this.executionRecords.set(record.toolCallId, stored);
      return clone(stored);
    });
  }

  public get(toolCallId: string): Promise<ToolExecutionRecord | null> {
    const execution = this.executionRecords.get(toolCallId);
    return Promise.resolve(execution === undefined ? null : clone(execution));
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
    return Promise.resolve().then(() => {
      const transition = input.execution;
      const nextContext = transition?.kind === 'completed'
        ? appendCompletedResult(input.context, transition.result)
        : clone(input.context);
      let existing: ToolExecutionRecord | undefined;
      let nextExecution: ToolExecutionRecord | undefined;
      // Preserve the legacy CAS-first error contract for completed results:
      // a stale checkpoint must be reported before a now-terminal execution.
      // Uncertain transitions retain their former execution-first behavior,
      // because the prepared state determines whether a no-op context must
      // still advance its revision.
      if (transition?.kind === 'uncertain') {
        existing = this.requireCompatibleExecution(transition.record);
        nextExecution = uncertainExecution(existing, transition.reasonCode, this.clock);
      }
      const checkpoint = this.nextCheckpoint(
        nextContext,
        input.expectedRevision,
        transition?.kind === 'uncertain' && existing?.state === 'prepared',
      );
      if (transition?.kind === 'completed') {
        existing = this.requireCompatibleExecution(transition.record);
        nextExecution = completedExecution(existing, transition.result, this.clock);
      }
      const outbox = this.planOutbox(input.outboxEvents, this.clock.now().toISOString(), nextContext.runId);

      if (nextExecution !== undefined) this.executionRecords.set(nextExecution.toolCallId, clone(nextExecution));
      this.checkpointRecords.set(nextContext.runId, clone(checkpoint));
      for (const record of outbox) this.outboxRecords.set(record.event.eventId, clone(record));
      return clone(checkpoint);
    });
  }

  public enqueue(input: { events: readonly PendingAgentEventV2[]; createdAt: string }): Promise<readonly DurableOutboxRecord[]> {
    return Promise.resolve().then(() => {
      const records = this.planOutbox(input.events, input.createdAt);
      for (const record of records) this.outboxRecords.set(record.event.eventId, clone(record));
      return records.map((record) => clone(record));
    });
  }

  public listPending(input: { runId?: string; limit: number }): Promise<readonly DurableOutboxRecord[]> {
    return Promise.resolve().then(() => {
      assertOutboxLimit(input.limit);
      return [...this.outboxRecords.values()]
        .filter((record) => record.publishedAt === undefined && (input.runId === undefined || record.event.runId === input.runId))
        .slice(0, input.limit)
        .map((record) => clone(record));
    });
  }

  public markPublished(input: { eventId: string; publishedAt: string }): Promise<void> {
    return Promise.resolve().then(() => {
      assertTimestamp(input.publishedAt, 'publishedAt');
      const existing = this.outboxRecords.get(input.eventId);
      if (existing === undefined) throw new Error(`Outbox event not found: ${input.eventId}`);
      if (existing.publishedAt === undefined) {
        this.outboxRecords.set(input.eventId, { ...clone(existing), publishedAt: input.publishedAt });
      }
    });
  }

  private requireCompatibleExecution(incoming: ToolExecutionRecord): ToolExecutionRecord {
    const existing = this.executionRecords.get(incoming.toolCallId);
    if (existing === undefined) throw new Error(`prepared tool execution not found: ${incoming.toolCallId}`);
    if (!sameExecutionIdentity(existing, incoming)) throw new Error(`tool execution identity collision: ${incoming.toolCallId}`);
    return existing;
  }

  private nextCheckpoint(
    context: AgentContext,
    expectedRevision: number | null,
    forceRevisionAdvance = false,
  ): StoredRunCheckpoint {
    const normalized = parseAgentContext(context);
    const current = this.checkpointRecords.get(normalized.runId);
    const checksum = checkpointChecksum(normalized);
    const actualRevision = current?.revision ?? null;
    const validCreate = current === undefined && expectedRevision === null;
    const validUpdate = current !== undefined && expectedRevision === actualRevision;
    if (!validCreate && !validUpdate) {
      throw new CheckpointConflictError(normalized.runId, expectedRevision, actualRevision);
    }
    if (current !== undefined && current.checksum === checksum && !forceRevisionAdvance) return clone(current);

    return {
      context: clone(normalized),
      revision: (actualRevision ?? 0) + 1,
      savedAt: this.clock.now().toISOString(),
      checksum,
    };
  }

  private planOutbox(
    events: readonly PendingAgentEventV2[],
    createdAt: string,
    expectedRunId?: string,
  ): DurableOutboxRecord[] {
    assertTimestamp(createdAt, 'createdAt');
    const eventIds = new Set<string>();
    return events.map((event) => {
      const normalized = parsePendingEvent(event);
      if (expectedRunId !== undefined && normalized.runId !== expectedRunId) {
        throw new Error(`Outbox event runId mismatch: expected ${expectedRunId}, received ${normalized.runId}`);
      }
      if (normalized.durability !== 'durable') throw new Error('Outbox accepts durable events only');
      if (eventIds.has(normalized.eventId)) throw new EventIdConflictError(normalized.eventId);
      eventIds.add(normalized.eventId);
      const existing = this.outboxRecords.get(normalized.eventId);
      if (existing !== undefined) {
        if (!samePendingEvent(existing.event, normalized)) throw new EventIdConflictError(normalized.eventId);
        return clone(existing);
      }
      return { event: normalized, enqueuedAt: createdAt };
    });
  }
}

/** In-memory Evidence repository with the same duplicate and pagination behavior as SQLite. */
export class InMemoryEvidenceRepository implements EvidenceStore, EvidenceQueryStore {
  private readonly records = new Map<string, EvidenceRecord>();
  private readonly captureKeys = new Map<string, string>();

  public save(record: EvidenceRecord): Promise<void> {
    return Promise.resolve().then(() => {
      const normalized = normalizeEvidence(record);
      const existingById = this.records.get(normalized.evidenceId);
      const existingByCapture = normalized.captureKey === undefined
        ? undefined
        : this.records.get(this.captureKeys.get(normalized.captureKey) ?? '');
      const existing = existingById ?? existingByCapture;

      if (existing !== undefined) {
        if (sameEvidenceIdentity(existing, normalized)) return;
        throw new Error(`evidence identity collision: ${normalized.evidenceId}`);
      }
      this.records.set(normalized.evidenceId, clone(normalized));
      if (normalized.captureKey !== undefined) this.captureKeys.set(normalized.captureKey, normalized.evidenceId);
    });
  }

  public get(evidenceId: string): Promise<EvidenceRecord | null> {
    const record = this.records.get(evidenceId);
    return Promise.resolve(record === undefined ? null : clone(record));
  }

  public listByRun(runId: string, options: { cursor?: string; limit?: number } = {}): Promise<EvidencePage> {
    return Promise.resolve().then(() => {
      const limit = pageLimit(options.limit);
      const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
      if (cursor !== undefined && cursor.runId !== runId) throw new Error('evidence cursor does not belong to this Run');
      const matching = [...this.records.values()]
        .filter((record) => record.runId === runId)
        .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.evidenceId.localeCompare(right.evidenceId));
      const afterCursor = cursor === undefined
        ? matching
        : matching.filter((record) => compareEvidencePosition(record, cursor) > 0);
      const items = afterCursor.slice(0, limit).map((record) => clone(record));
      const last = items.at(-1);
      return {
        items,
        ...(last === undefined || afterCursor.length <= items.length ? {} : { nextCursor: encodeCursor(last) }),
      };
    });
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
    if (existing.state === state && existing.result !== undefined && sameJson(existing.result, result)) return clone(existing);
    throw new Error(`tool execution is already terminal: ${result.toolCallId}`);
  }
  return {
    ...clone(existing),
    state,
    result: clone(result),
    finishedAt: result.finishedAt ?? clock.now().toISOString(),
  };
}

function uncertainExecution(existing: ToolExecutionRecord, reasonCode: string, clock: Clock): ToolExecutionRecord {
  if (reasonCode.length === 0) throw new Error('uncertain tool execution requires a reason code');
  if (existing.state === 'uncertain') {
    if (existing.reasonCode === reasonCode) return clone(existing);
    throw new Error(`tool execution uncertainty conflicts: ${existing.toolCallId}`);
  }
  if (existing.state !== 'prepared') throw new Error(`tool execution is already terminal: ${existing.toolCallId}`);
  return { ...clone(existing), state: 'uncertain', reasonCode, finishedAt: clock.now().toISOString() };
}

function appendCompletedResult(context: AgentContext, result: ToolExecutionResult): AgentContext {
  const batch = context.pendingToolBatch;
  if (batch === undefined) throw new Error(`pending batch is required for tool result: ${result.toolCallId}`);
  const call = batch.calls.find((candidate) => candidate.id === result.toolCallId);
  if (call === undefined || call.name !== result.toolName) throw new Error(`tool result does not belong to pending batch: ${result.toolCallId}`);
  const existing = batch.completedResults.find((candidate) => candidate.toolCallId === result.toolCallId);
  if (existing !== undefined) {
    if (!sameJson(existing, result)) throw new Error(`pending batch result conflicts: ${result.toolCallId}`);
    return clone(context);
  }
  return {
    ...clone(context),
    pendingToolBatch: {
      ...clone(batch),
      completedResults: [...batch.completedResults.map((item) => clone(item)), clone(result)],
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

function normalizeEvidence(record: EvidenceRecord): EvidenceRecord {
  if (record.evidenceId.length === 0 || record.runId.length === 0) throw new Error('evidence requires an ID and Run ID');
  if (!['metric', 'log', 'trace', 'change'].includes(record.source)) throw new Error('evidence source is invalid');
  if (!Number.isFinite(Date.parse(record.capturedAt))) throw new Error('evidence capture time is invalid');
  if (record.captureKey !== undefined && record.captureKey.length === 0) throw new Error('evidence capture key cannot be empty');
  checkpointChecksum({ summary: record.summary, businessTraceIds: record.businessTraceIds });
  const calculatedRawSha256 = checkpointChecksum(record.raw);
  if (record.rawSha256 !== undefined && record.rawSha256 !== calculatedRawSha256) {
    throw new Error(`evidence raw hash does not match: ${record.evidenceId}`);
  }
  return clone({ ...record, rawSha256: calculatedRawSha256 });
}

function sameEvidenceIdentity(left: EvidenceRecord, right: EvidenceRecord): boolean {
  return left.evidenceId === right.evidenceId
    && left.captureKey === right.captureKey
    && left.rawSha256 === right.rawSha256;
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EVIDENCE_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_EVIDENCE_PAGE_SIZE) {
    throw new RangeError(`evidence page limit must be between 1 and ${MAX_EVIDENCE_PAGE_SIZE}`);
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

function compareEvidencePosition(record: EvidenceRecord, cursor: EvidenceCursor): number {
  return record.capturedAt.localeCompare(cursor.capturedAt) || record.evidenceId.localeCompare(cursor.evidenceId);
}

function sameJson(left: unknown, right: unknown): boolean {
  return checkpointChecksum(left) === checkpointChecksum(right);
}

function parsePendingEvent(event: PendingAgentEventV2): PendingAgentEventV2 {
  const parsed = parseAgentEventV2({ ...clone(event), sequence: 1 });
  const { sequence, ...pending } = parsed;
  void sequence;
  return pending;
}

function samePendingEvent(left: PendingAgentEventV2, right: PendingAgentEventV2): boolean {
  return checkpointChecksum(left) === checkpointChecksum(right);
}

function assertOutboxLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('Outbox limit must be a positive safe integer');
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
