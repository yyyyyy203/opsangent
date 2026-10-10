import { z } from 'zod';
import type { Clock } from '../contracts/common.js';
import type { AgentContext } from '../contracts/context.js';
import type {
  DiagnosticMemoryCase, MemoryCaptureIntent, MemoryCaptureRequest, MemoryCaptureTicket,
  MemoryErrorCode, MemoryJobClaim, MemoryMaintenance, MemoryManualCaptureCommand, MemoryQueryStore,
  MemoryReviewCommand, MemoryScope, MemorySearch, MemorySelection, MemoryStatus, MemoryWriteUnitOfWork,
} from '../contracts/diagnostic-memory.js';
import { memoryScopeSchema, parseDiagnosticMemoryCase } from '../contracts/diagnostic-memory-schema.js';
import type { PendingAgentEventV2 } from '../contracts/event-store.js';
import { EventIdConflictError } from '../contracts/event-store.js';
import { parseAgentEventV2 } from '../contracts/event-v2/schema.js';
import type { DiagnosisSignal, GovernanceEffect } from '../contracts/hooks.js';
import type { DurableOutboxRecord, StoredRunCheckpoint, ToolExecutionRecord } from '../contracts/storage.js';
import { canonicalJson, checkpointChecksum } from '../contracts/stable-json.js';
import { MemoryError } from './memory-error.js';
import { memoryScopeKey } from './memory-scope.js';

export const MEMORY_INDEX_VERSION = 'episodic-tokens-v1';
export const MEMORY_JOB_VERSION = 'episodic-jobs-v1';
export const MEMORY_SIGNAL_VERSION = 'tool-outcome-v1';
export const MEMORY_DAY_MS = 86_400_000;
const id = z.string().min(1).max(256).refine((value) => value.trim().length > 0);
const timestamp = z.string().max(64).datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)));
const revision = z.number().int().positive().safe();
const requestSchema = z.object({
  candidateId: id, sourceRunId: id, scope: memoryScopeSchema, extractorVersion: z.literal('episodic-v1'),
  origin: z.enum(['automatic', 'manual']), requestId: id,
  sourceRunStatus: z.enum(['completed', 'failed', 'cancelled']), sourceContextVersion: revision,
  sourceCheckpointChecksum: z.string().regex(/^[a-f0-9]{64}$/iu),
  requiredSources: z.array(z.enum(['metric', 'log', 'trace', 'change'])).max(4), requestedAt: timestamp,
}).strict();
const manualSchema = z.object({ sourceRunId: id, scope: memoryScopeSchema,
  expectedCheckpointRevision: revision, requestId: id, actorId: id, requestedAt: timestamp }).strict();
const reviewSchema = z.object({ memoryId: id, scope: memoryScopeSchema, expectedRevision: revision,
  requestId: id, decision: z.enum(['approved', 'rejected']), claimCheck: z.enum(['supported', 'unsupported']),
  actorId: id, reviewedAt: timestamp }).strict();
const ticketSchema = z.object({ sourceRunId: id,
  state: z.enum(['not_saved', 'queued', 'running', 'saved', 'failed', 'unavailable']),
  sourceCheckpointRevision: revision.optional(), candidateId: id.optional(), memoryId: id.optional(),
  reasonCode: z.enum(['MEMORY_SCOPE_INVALID', 'MEMORY_DATA_INVALID', 'MEMORY_REVISION_CONFLICT',
    'MEMORY_REQUEST_CONFLICT', 'MEMORY_APPROVAL_DENIED', 'MEMORY_EVIDENCE_UNAVAILABLE',
    'MEMORY_SOURCE_CONFLICT', 'MEMORY_RUN_NOT_TERMINAL', 'MEMORY_POLICY_DENIED',
    'MEMORY_CAPACITY_EXCEEDED', 'MEMORY_LOOKUP_FAILED', 'MEMORY_CAPTURE_FAILED', 'MEMORY_DISABLED']).optional(),
}).strict();
const signalSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('tool_outcome'),
  candidateStatus: z.literal('observation'), runId: id, stepId: id, toolCallId: id, toolName: id,
  phase: z.enum(['admission', 'governance', 'execution', 'completion']),
  outcome: z.enum(['success', 'failed', 'interrupted', 'awaiting_external']),
  riskSeverity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), evidenceIds: z.array(id).max(20), observedAt: timestamp,
}).strict();

export interface MemoryJob {
  request: MemoryCaptureRequest;
  sourceCheckpointRevision: number;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  attempt: number;
  ownerId: string | null;
  leaseUntil: string | null;
  terminalFailureEvent: PendingAgentEventV2<'MEMORY_UPDATE_FAILED'>;
  memoryId?: string;
  reasonCode?: MemoryErrorCode;
}
export interface MemoryCaptureCommandRecord {
  command: MemoryManualCaptureCommand;
  digest: string;
  ticket: MemoryCaptureTicket;
}
export interface MemoryReviewRecord {
  command: MemoryReviewCommand;
  digest: string;
  result: DiagnosticMemoryCase;
}

/** All methods are synchronous and must use the caller's transaction working copy. */
export interface DiagnosticMemoryRepository {
  checkpoint(runId: string): StoredRunCheckpoint | null;
  isChild(runId: string): boolean;
  getCase(id: string, scopeKey: string): DiagnosticMemoryCase | null;
  listCases(scopeKey: string, status: MemoryStatus | undefined, afterId: string | undefined, limit: number): DiagnosticMemoryCase[];
  countCases(scopeKey: string, status: MemoryStatus): number;
  putCase(value: DiagnosticMemoryCase, expectedRevision?: number): void;
  jobForRun(runId: string): MemoryJob | null;
  job(id: string): MemoryJob | null;
  pendingJob(): MemoryJob | null;
  expiredJobs(now: string, limit: number): MemoryJob[];
  activeJobs(): number;
  putJob(job: MemoryJob, expected?: MemoryJob): void;
  captureCommand(requestId: string): MemoryCaptureCommandRecord | null;
  putCaptureCommand(record: MemoryCaptureCommandRecord): void;
  reviewCommand(requestId: string): MemoryReviewRecord | null;
  putReviewCommand(record: MemoryReviewRecord): void;
  putSignal(key: string, signal: DiagnosisSignal): void;
  prune(now: string, limit: number): { expiredObservations: number; signalsRemoved: number };
  enqueue(events: readonly PendingAgentEventV2[], now: string, expectedRunId: string): void;
}

export interface InMemoryDiagnosticRecords {
  cases: Map<string, { value: DiagnosticMemoryCase; checksum: string }>;
  indexes: Map<string, string>;
  jobs: Map<string, MemoryJob>;
  captureCommands: Map<string, MemoryCaptureCommandRecord>;
  reviews: Map<string, MemoryReviewRecord>;
  signals: Map<string, DiagnosisSignal>;
}

/** Durable state and sidecar share this *one* publishable transaction snapshot. */
export interface InMemoryDiagnosticTransaction {
  checkpointRecords: Map<string, StoredRunCheckpoint>;
  executionRecords: Map<string, ToolExecutionRecord>;
  outboxRecords: Map<string, DurableOutboxRecord>;
  memory: InMemoryDiagnosticRecords;
}
export function createInMemoryDiagnosticRecords(): InMemoryDiagnosticRecords {
  return { cases: new Map(), indexes: new Map(), jobs: new Map(), captureCommands: new Map(),
    reviews: new Map(), signals: new Map() };
}
export function cloneInMemoryDiagnosticRecords(source: InMemoryDiagnosticRecords): InMemoryDiagnosticRecords {
  return {
    cases: new Map([...source.cases].map(([key, value]) => [key, structuredClone(value)])),
    indexes: new Map(source.indexes),
    jobs: new Map([...source.jobs].map(([key, value]) => [key, structuredClone(value)])),
    captureCommands: new Map([...source.captureCommands].map(([key, value]) => [key, structuredClone(value)])),
    reviews: new Map([...source.reviews].map(([key, value]) => [key, structuredClone(value)])),
    signals: new Map([...source.signals].map(([key, value]) => [key, structuredClone(value)])),
  };
}

export function memoryInstant(value: string): string {
  if (!timestamp.safeParse(value).success) throw new MemoryError('MEMORY_DATA_INVALID');
  return new Date(value).toISOString();
}
export function memoryLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new MemoryError('MEMORY_DATA_INVALID');
  return value;
}
export function boundedMemoryJson(value: unknown, maximum = 16 * 1024): string {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, 'utf8') > maximum) throw new MemoryError('MEMORY_DATA_INVALID');
  return json;
}
export function parseMemoryRequest(value: unknown): MemoryCaptureRequest {
  const result = requestSchema.safeParse(value);
  if (!result.success) throw new MemoryError('MEMORY_DATA_INVALID');
  if (new Set(result.data.requiredSources).size !== result.data.requiredSources.length) throw new MemoryError('MEMORY_DATA_INVALID');
  boundedMemoryJson(result.data);
  return { ...result.data, requestedAt: memoryInstant(result.data.requestedAt) };
}
export function parseMemoryCaptureCommand(value: unknown): MemoryManualCaptureCommand {
  const result = manualSchema.safeParse(value);
  if (!result.success) throw new MemoryError('MEMORY_DATA_INVALID');
  return { ...result.data, requestedAt: memoryInstant(result.data.requestedAt) };
}
export function parseMemoryReviewCommand(value: unknown): MemoryReviewCommand {
  const result = reviewSchema.safeParse(value);
  if (!result.success) throw new MemoryError('MEMORY_DATA_INVALID');
  return { ...result.data, reviewedAt: memoryInstant(result.data.reviewedAt) };
}
export function parseMemoryTicket(value: unknown): MemoryCaptureTicket {
  const result = ticketSchema.safeParse(value);
  if (!result.success) throw new MemoryError('MEMORY_DATA_INVALID');
  return { sourceRunId: result.data.sourceRunId, state: result.data.state,
    ...(result.data.sourceCheckpointRevision === undefined ? {} : { sourceCheckpointRevision: result.data.sourceCheckpointRevision }),
    ...(result.data.candidateId === undefined ? {} : { candidateId: result.data.candidateId }),
    ...(result.data.memoryId === undefined ? {} : { memoryId: result.data.memoryId }),
    ...(result.data.reasonCode === undefined ? {} : { reasonCode: result.data.reasonCode }) };
}
export function parseMemorySignal(value: unknown): DiagnosisSignal {
  const result = signalSchema.safeParse(value);
  if (!result.success) throw new MemoryError('MEMORY_DATA_INVALID');
  return result.data;
}
export function parseMemoryCase(value: unknown): DiagnosticMemoryCase {
  try {
    const result = parseDiagnosticMemoryCase(value);
    return { ...result, capturedAt: memoryInstant(result.capturedAt), validUntil: memoryInstant(result.validUntil) };
  } catch { throw new MemoryError('MEMORY_DATA_INVALID'); }
}
export function memoryCaptureDigest(command: MemoryManualCaptureCommand): string {
  const result = parseMemoryCaptureCommand(command);
  const { requestedAt, ...identity } = result;
  void requestedAt;
  return checkpointChecksum(identity);
}
export function memoryReviewDigest(command: MemoryReviewCommand): string {
  const result = parseMemoryReviewCommand(command);
  const { reviewedAt, ...identity } = result;
  void reviewedAt;
  return checkpointChecksum(identity);
}
export function memoryIndexText(value: DiagnosticMemoryCase): string {
  // Stable persisted token version; ranking and safe MATCH construction belong to T5.
  const text = [value.summary, ...value.symptomCodes].join(' ').normalize('NFKC').toLowerCase();
  const tokens: string[] = [...(text.match(/[a-z0-9_]+/gu) ?? [])];
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    for (let index = 0; index + 1 < chars.length; index += 1) tokens.push(chars.slice(index, index + 2).join(''));
  }
  return tokens.slice(0, 2048).join(' ');
}
export function memoryTicket(job: MemoryJob): MemoryCaptureTicket {
  return { sourceRunId: job.request.sourceRunId, sourceCheckpointRevision: job.sourceCheckpointRevision,
    candidateId: job.request.candidateId,
    state: job.state === 'pending' ? 'queued' : job.state === 'completed' ? 'saved' : job.state === 'skipped' ? 'not_saved' : job.state,
    ...(job.memoryId === undefined ? {} : { memoryId: job.memoryId }),
    ...(job.reasonCode === undefined ? {} : { reasonCode: job.reasonCode }) };
}

function checkIntent(intent: MemoryCaptureIntent): MemoryCaptureRequest {
  const request = parseMemoryRequest(intent.request);
  for (const event of [intent.scheduledEvent, intent.rejectedEvent, intent.failedEvent]) {
    parseAgentEventV2({ ...event, sequence: 1 });
    boundedMemoryJson(event);
    if (event.runId !== request.sourceRunId || event.visibility !== 'audit' || event.durability !== 'durable'
      || event.parentRunId !== undefined) throw new MemoryError('MEMORY_DATA_INVALID');
  }
  if (intent.scheduledEvent.type !== 'MEMORY_UPDATE_SCHEDULED'
    || intent.scheduledEvent.payload.candidateType !== 'episodic'
    || intent.scheduledEvent.payload.sourceRunId !== request.sourceRunId
    || intent.rejectedEvent.type !== 'MEMORY_UPDATE_FAILED' || intent.failedEvent.type !== 'MEMORY_UPDATE_FAILED'
    || intent.rejectedEvent.payload.candidateId !== request.candidateId
    || intent.failedEvent.payload.candidateId !== request.candidateId
    || intent.rejectedEvent.payload.error.details?.category !== 'MEMORY_CAPACITY_EXCEEDED'
    || intent.failedEvent.payload.error.details?.category !== 'MEMORY_CAPTURE_FAILED') throw new MemoryError('MEMORY_DATA_INVALID');
  return request;
}

export function validateMemorySource(repo: DiagnosticMemoryRepository, request: MemoryCaptureRequest): StoredRunCheckpoint {
  const source = repo.checkpoint(request.sourceRunId);
  if (source === null) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
  const control = source.context.memoryControl;
  if (control === undefined || repo.isChild(request.sourceRunId)) throw new MemoryError('MEMORY_POLICY_DENIED');
  if (source.context.profileId !== control.scope.profileId || memoryScopeKey(control.scope) !== memoryScopeKey(request.scope)) {
    throw new MemoryError('MEMORY_SCOPE_INVALID');
  }
  if (!['completed', 'failed', 'cancelled'].includes(source.context.status)) throw new MemoryError('MEMORY_RUN_NOT_TERMINAL');
  if (source.context.contextVersion !== request.sourceContextVersion || source.checksum !== request.sourceCheckpointChecksum
    || source.context.status !== request.sourceRunStatus) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
  return source;
}

/** No transaction of its own: callers must already hold the durable transition/command transaction. */
export function stageMemoryCapture(repo: DiagnosticMemoryRepository, intent: MemoryCaptureIntent): MemoryCaptureTicket {
  const request = checkIntent(intent);
  const source = validateMemorySource(repo, request);
  if (request.origin === 'automatic' && source.context.memoryControl?.capture !== 'automatic') {
    throw new MemoryError('MEMORY_POLICY_DENIED');
  }
  const existing = repo.jobForRun(request.sourceRunId);
  if (existing !== null) {
    if (memoryScopeKey(existing.request.scope) !== memoryScopeKey(request.scope)
      || existing.request.sourceCheckpointChecksum !== request.sourceCheckpointChecksum
      || existing.request.sourceContextVersion !== request.sourceContextVersion) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
    return memoryTicket(existing);
  }
  if (repo.activeJobs() >= 1000) {
    repo.enqueue([intent.rejectedEvent], request.requestedAt, request.sourceRunId);
    return { sourceRunId: request.sourceRunId, sourceCheckpointRevision: source.revision,
      state: 'unavailable', reasonCode: 'MEMORY_CAPACITY_EXCEEDED' };
  }
  repo.putJob({ request, sourceCheckpointRevision: source.revision, state: 'pending', attempt: 0,
    ownerId: null, leaseUntil: null, terminalFailureEvent: structuredClone(intent.failedEvent) });
  repo.enqueue([intent.scheduledEvent], request.requestedAt, request.sourceRunId);
  const job = repo.jobForRun(request.sourceRunId);
  if (job === null) throw new MemoryError('MEMORY_CAPTURE_FAILED');
  return memoryTicket(job);
}

export function stageAutomaticMemoryCapture(repo: DiagnosticMemoryRepository, intent: MemoryCaptureIntent): void {
  const source = repo.checkpoint(intent.request.sourceRunId);
  if (source?.context.status !== 'completed' || source.context.memoryControl?.capture !== 'automatic'
    || repo.isChild(intent.request.sourceRunId)) return;
  if (intent.request.origin !== 'automatic') throw new MemoryError('MEMORY_DATA_INVALID');
  stageMemoryCapture(repo, intent);
}

export function stageMemorySignals(repo: DiagnosticMemoryRepository, context: AgentContext, effects: readonly GovernanceEffect[]): void {
  if (context.memoryControl === undefined || context.memoryControl.capture === 'skip'
    || repo.isChild(context.runId)) return;
  const scope = memoryScopeSchema.safeParse(context.memoryControl.scope);
  if (!scope.success) return;
  for (const effect of effects) {
    if (effect.type !== 'memory_signal') continue;
    const parsed = signalSchema.safeParse(effect.signal);
    if (!parsed.success || parsed.data.runId !== context.runId) continue;
    const signal: DiagnosisSignal = { ...parsed.data, observedAt: memoryInstant(parsed.data.observedAt) };
    const key = checkpointChecksum({ runId: signal.runId, toolCallId: signal.toolCallId,
      phase: signal.phase, outcome: signal.outcome, observedAt: signal.observedAt });
    boundedMemoryJson(signal);
    repo.putSignal(key, signal);
  }
}

export function createInMemoryDiagnosticRepository(state: InMemoryDiagnosticTransaction): DiagnosticMemoryRepository {
  const memory = state.memory;
  const readCase = (entry: { value: DiagnosticMemoryCase; checksum: string }): DiagnosticMemoryCase => {
    if (checkpointChecksum(entry.value) !== entry.checksum) throw new MemoryError('MEMORY_DATA_INVALID');
    const value = parseMemoryCase(entry.value);
    const expected = value.status === 'approved' ? memoryIndexText(value) : undefined;
    if (memory.indexes.get(value.id) !== expected) throw new MemoryError('MEMORY_DATA_INVALID');
    return value;
  };
  return {
    checkpoint: (runId) => structuredClone(state.checkpointRecords.get(runId) ?? null),
    isChild: (runId) => [...state.outboxRecords.values()].some(({ event }) =>
      (event.runId === runId && event.parentRunId !== undefined)
      || (event.type === 'SUBAGENT_STARTED' && event.payload.childRunId === runId)),
    getCase: (caseId, scopeKey) => {
      const entry = memory.cases.get(caseId);
      return entry === undefined || memoryScopeKey(entry.value.scope) !== scopeKey ? null : readCase(entry);
    },
    listCases: (scopeKey, status, afterId, limit) => [...memory.cases.values()]
      .filter(({ value }) => memoryScopeKey(value.scope) === scopeKey && (status === undefined || value.status === status)
        && (afterId === undefined || Buffer.compare(Buffer.from(value.id), Buffer.from(afterId)) > 0))
      .sort((left, right) => Buffer.compare(Buffer.from(left.value.id), Buffer.from(right.value.id)))
      .slice(0, limit).map(readCase),
    countCases: (scopeKey, status) => [...memory.cases.values()].filter(({ value }) =>
      memoryScopeKey(value.scope) === scopeKey && value.status === status).length,
    putCase: (value, expectedRevision) => {
      const normalized = parseMemoryCase(value);
      const existing = memory.cases.get(value.id);
      if (expectedRevision !== undefined && (existing?.value.revision !== expectedRevision
        || existing === undefined || memoryScopeKey(existing.value.scope) !== memoryScopeKey(normalized.scope))) throw new MemoryError('MEMORY_REVISION_CONFLICT');
      if (expectedRevision === undefined && (existing !== undefined || normalized.status !== 'observation'
        || [...memory.cases.values()].some((entry) => entry.value.sourceRunId === normalized.sourceRunId
          && entry.value.extractorVersion === normalized.extractorVersion))) throw new MemoryError('MEMORY_REQUEST_CONFLICT');
      if (existing !== undefined && !sameReviewedCaseContent(existing.value, normalized)) throw new MemoryError('MEMORY_DATA_INVALID');
      const scopeKey = memoryScopeKey(normalized.scope);
      if (existing?.value.status !== normalized.status && normalized.status === 'observation'
        && memoryCount(memory, scopeKey, 'observation') >= 100) throw new MemoryError('MEMORY_CAPACITY_EXCEEDED');
      if (existing?.value.status !== normalized.status && normalized.status === 'approved'
        && memoryCount(memory, scopeKey, 'approved') >= 1000) throw new MemoryError('MEMORY_CAPACITY_EXCEEDED');
      memory.cases.set(normalized.id, { value: structuredClone(normalized), checksum: checkpointChecksum(normalized) });
      memory.indexes.delete(normalized.id);
      if (normalized.status === 'approved') memory.indexes.set(normalized.id, memoryIndexText(normalized));
    },
    jobForRun: (runId) => structuredClone([...memory.jobs.values()].find((job) => job.request.sourceRunId === runId) ?? null),
    job: (candidateId) => structuredClone(memory.jobs.get(candidateId) ?? null),
    pendingJob: () => structuredClone([...memory.jobs.values()].filter((job) => job.state === 'pending')
      .sort((left, right) => Buffer.compare(Buffer.from(left.request.candidateId), Buffer.from(right.request.candidateId)))[0] ?? null),
    expiredJobs: (now, limit) => [...memory.jobs.values()].filter((job) => job.state === 'running'
      && job.leaseUntil !== null && Date.parse(job.leaseUntil) <= Date.parse(now))
      .sort((left, right) => Date.parse(left.leaseUntil ?? '') - Date.parse(right.leaseUntil ?? '')
        || Buffer.compare(Buffer.from(left.request.candidateId), Buffer.from(right.request.candidateId)))
      .slice(0, limit).map((job) => structuredClone(job)),
    activeJobs: () => [...memory.jobs.values()].filter((job) => job.state === 'pending' || job.state === 'running').length,
    putJob: (job, expected) => {
      const current = memory.jobs.get(job.request.candidateId);
      if (expected !== undefined && (current === undefined
        || checkpointChecksum(current) !== checkpointChecksum(expected))) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
      if (expected === undefined && (current !== undefined || [...memory.jobs.values()].some((item) =>
        item.request.sourceRunId === job.request.sourceRunId))) throw new MemoryError('MEMORY_REQUEST_CONFLICT');
      memory.jobs.set(job.request.candidateId, structuredClone(job));
    },
    captureCommand: (requestId) => structuredClone(memory.captureCommands.get(requestId) ?? null),
    putCaptureCommand: (record) => { memory.captureCommands.set(record.command.requestId, structuredClone(record)); },
    reviewCommand: (requestId) => structuredClone(memory.reviews.get(requestId) ?? null),
    putReviewCommand: (record) => { memory.reviews.set(record.command.requestId, structuredClone(record)); },
    putSignal: (key, signal) => {
      const normalized = parseMemorySignal(signal);
      const existing = memory.signals.get(key);
      if (existing !== undefined && checkpointChecksum(existing) !== checkpointChecksum(normalized)) {
        throw new MemoryError('MEMORY_SOURCE_CONFLICT');
      }
      if (existing === undefined) memory.signals.set(key, structuredClone(normalized));
    },
    prune: (now, limit) => {
      let expiredObservations = 0;
      let signalsRemoved = 0;
      for (const [caseId, { value }] of memory.cases) {
        if (expiredObservations >= limit) break;
        if (value.status === 'observation' && Date.parse(value.validUntil) <= Date.parse(now)) {
          memory.cases.delete(caseId); memory.indexes.delete(caseId); expiredObservations += 1;
        }
      }
      for (const [key, signal] of memory.signals) {
        if (expiredObservations + signalsRemoved >= limit) break;
        if (Date.parse(signal.observedAt) <= Date.parse(now) - 7 * MEMORY_DAY_MS) { memory.signals.delete(key); signalsRemoved += 1; }
      }
      return { expiredObservations, signalsRemoved };
    },
    enqueue: (events, now, runId) => {
      const seen = new Set<string>();
      for (const event of events) {
        const { sequence, ...pending } = parseAgentEventV2({ ...event, sequence: 1 });
        void sequence;
        if (pending.runId !== runId || pending.durability !== 'durable') throw new MemoryError('MEMORY_DATA_INVALID');
        if (seen.has(pending.eventId)) throw new EventIdConflictError(pending.eventId);
        seen.add(pending.eventId);
        const existing = state.outboxRecords.get(pending.eventId);
        if (existing !== undefined && canonicalJson(existing.event) !== canonicalJson(pending)) throw new EventIdConflictError(pending.eventId);
        if (existing === undefined) state.outboxRecords.set(pending.eventId, { event: structuredClone(pending), enqueuedAt: now });
      }
    },
  };
}

function memoryCount(memory: InMemoryDiagnosticRecords, scopeKey: string, status: MemoryStatus): number {
  return [...memory.cases.values()].filter(({ value }) =>
    value.status === status && memoryScopeKey(value.scope) === scopeKey).length;
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

/** Shared ports; mutation callbacks always receive a fresh atomic repository. */
export abstract class DiagnosticMemoryStoreCore implements MemoryQueryStore, MemoryWriteUnitOfWork, MemoryMaintenance {
  protected constructor(protected readonly clock: Clock) {}
  protected abstract read<T>(operation: (repo: DiagnosticMemoryRepository) => T): Promise<T>;
  protected abstract transact<T>(operation: (repo: DiagnosticMemoryRepository) => T): Promise<T>;
  public get(id: string, scope: MemoryScope): Promise<DiagnosticMemoryCase | null> {
    return this.read((repo) => repo.getCase(id, memoryScopeKey(scope)));
  }
  public list(input: { scope: MemoryScope; status?: MemoryStatus; afterId?: string; limit: number }): Promise<readonly DiagnosticMemoryCase[]> {
    return this.read((repo) => repo.listCases(memoryScopeKey(input.scope), input.status, input.afterId, memoryLimit(input.limit, 100)));
  }
  public search(input: MemorySearch): Promise<readonly DiagnosticMemoryCase[]> {
    // T5 owns ranking. This bounded fail-closed placeholder never returns candidates.
    return this.read(() => { memoryScopeKey(input.scope); memoryLimit(input.limit, 10); memoryInstant(input.now); return []; });
  }
  public getCapture(input: { runId: string; scope: MemoryScope }): Promise<MemoryCaptureTicket | null> {
    return this.read((repo) => {
      const scope = memoryScopeKey(input.scope);
      const source = repo.checkpoint(input.runId);
      if (source?.context.memoryControl === undefined || repo.isChild(input.runId)
        || memoryScopeKey(source.context.memoryControl.scope) !== scope) return null;
      const job = repo.jobForRun(input.runId);
      return job === null ? { sourceRunId: input.runId, sourceCheckpointRevision: source.revision, state: 'not_saved' }
        : memoryScopeKey(job.request.scope) === scope ? memoryTicket(job) : null;
    });
  }
  public findCaptureResult(command: MemoryManualCaptureCommand): Promise<MemoryCaptureTicket | null> {
    return this.read((repo) => {
      const digest = memoryCaptureDigest(command);
      const record = repo.captureCommand(command.requestId);
      if (record === null) return null;
      if (record.digest !== digest) throw new MemoryError('MEMORY_REQUEST_CONFLICT');
      return structuredClone(record.ticket);
    });
  }
  public findReviewResult(command: MemoryReviewCommand): Promise<DiagnosticMemoryCase | null> {
    return this.read((repo) => {
      const digest = memoryReviewDigest(command);
      const record = repo.reviewCommand(command.requestId);
      if (record === null) return null;
      if (record.digest !== digest) throw new MemoryError('MEMORY_REQUEST_CONFLICT');
      return parseMemoryCase(record.result);
    });
  }
  public enqueueManualCapture(input: { command: MemoryManualCaptureCommand; intent: MemoryCaptureIntent }): Promise<MemoryCaptureTicket> {
    return this.transact((repo) => {
      const digest = memoryCaptureDigest(input.command);
      const prior = repo.captureCommand(input.command.requestId);
      if (prior !== null) {
        if (prior.digest !== digest) throw new MemoryError('MEMORY_REQUEST_CONFLICT');
        return structuredClone(prior.ticket);
      }
      const request = parseMemoryRequest(input.intent.request);
      if (request.origin !== 'manual' || request.requestId !== input.command.requestId
        || request.sourceRunId !== input.command.sourceRunId
        || memoryScopeKey(request.scope) !== memoryScopeKey(input.command.scope)) {
        throw new MemoryError('MEMORY_DATA_INVALID');
      }
      const source = repo.checkpoint(input.command.sourceRunId);
      if (source === null) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
      if (source.revision !== input.command.expectedCheckpointRevision) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
      const ticket = stageMemoryCapture(repo, input.intent);
      repo.putCaptureCommand({ command: structuredClone(input.command), digest, ticket: structuredClone(ticket) });
      return structuredClone(ticket);
    });
  }
  public claimNext(input: { ownerId: string; now: string; leaseUntil: string; maxAttempts: number }): Promise<MemoryJobClaim | null> {
    return this.transact((repo) => {
      const now = memoryInstant(input.now);
      const leaseUntil = memoryInstant(input.leaseUntil);
      if (leaseUntil <= now || input.ownerId.trim().length === 0 || input.maxAttempts < 1 || input.maxAttempts > 2) {
        throw new MemoryError('MEMORY_DATA_INVALID');
      }
      if (Date.parse(leaseUntil) - Date.parse(now) > 30_000) throw new MemoryError('MEMORY_DATA_INVALID');
      for (const expired of repo.expiredJobs(now, 50)) {
        if (expired.attempt >= input.maxAttempts) {
          const failed: MemoryJob = { ...expired, state: 'failed', ownerId: null, leaseUntil: null,
            reasonCode: 'MEMORY_CAPTURE_FAILED' };
          repo.putJob(failed, expired);
          repo.enqueue([expired.terminalFailureEvent], now, expired.request.sourceRunId);
        } else {
          repo.putJob({ ...expired, state: 'pending', ownerId: null, leaseUntil: null }, expired);
        }
      }
      const pending = repo.pendingJob();
      if (pending === null) return null;
      if (pending.attempt >= input.maxAttempts) {
        const failed: MemoryJob = { ...pending, state: 'failed', reasonCode: 'MEMORY_CAPTURE_FAILED' };
        repo.putJob(failed, pending);
        repo.enqueue([pending.terminalFailureEvent], now, pending.request.sourceRunId);
        return null;
      }
      const claimed: MemoryJob = { ...pending, state: 'running', attempt: pending.attempt + 1,
        ownerId: input.ownerId, leaseUntil };
      repo.putJob(claimed, pending);
      return { request: structuredClone(claimed.request), attempt: claimed.attempt,
        ownerId: input.ownerId, leaseUntil };
    });
  }
  public completeCapture(input: { claim: MemoryJobClaim; candidate: DiagnosticMemoryCase; now: string; events: readonly PendingAgentEventV2[] }): Promise<DiagnosticMemoryCase> {
    return this.transact((repo) => {
      const now = memoryInstant(input.now);
      const job = repo.job(input.claim.request.candidateId);
      assertClaim(job, input.claim, now);
      const candidate = parseMemoryCase(input.candidate);
      if (candidate.id !== job.request.candidateId || candidate.revision !== 1
        || candidate.status !== 'observation' || candidate.eligibleForPromotion
        || candidate.sourceRunId !== job.request.sourceRunId
        || candidate.sourceRunStatus !== job.request.sourceRunStatus
        || memoryScopeKey(candidate.scope) !== memoryScopeKey(job.request.scope)) {
        throw new MemoryError('MEMORY_DATA_INVALID');
      }
      validateMemorySource(repo, job.request);
      validateMemoryEvents(input.events, candidate.sourceRunId, ['MEMORY_UPDATE_COMPLETED', 'EXPERIENCE_CANDIDATE_CREATED']);
      const completed = input.events.find((event) => event.type === 'MEMORY_UPDATE_COMPLETED');
      const created = input.events.find((event) => event.type === 'EXPERIENCE_CANDIDATE_CREATED');
      if (completed === undefined || completed.payload.memoryId !== candidate.id || completed.payload.status !== candidate.status
        || created === undefined || created.payload.candidateId !== candidate.id
        || created.payload.qualityStatus !== candidate.quality
        || canonicalJson([...created.payload.evidenceIds].sort()) !== canonicalJson(candidate.evidenceRefs.map((ref) => ref.evidenceId).sort())) {
        throw new MemoryError('MEMORY_DATA_INVALID');
      }
      repo.putCase(candidate);
      repo.putJob({ ...job, state: 'completed', ownerId: null, leaseUntil: null, memoryId: candidate.id }, job);
      repo.enqueue(input.events, now, candidate.sourceRunId);
      return structuredClone(candidate);
    });
  }
  public failCapture(input: { claim: MemoryJobClaim; now: string; code: MemoryErrorCode; events: readonly PendingAgentEventV2[] }): Promise<void> {
    return this.transact((repo) => {
      const now = memoryInstant(input.now);
      const job = repo.job(input.claim.request.candidateId);
      assertClaim(job, input.claim, now);
      const retry = job.attempt < 2;
      const updated: MemoryJob = { ...job, state: retry ? 'pending' : 'failed', ownerId: null, leaseUntil: null,
        ...(retry ? {} : { reasonCode: input.code }) };
      repo.putJob(updated, job);
      if (!retry) {
        if (input.events.length > 0) validateMemoryEvents(input.events, job.request.sourceRunId, ['MEMORY_UPDATE_FAILED']);
        repo.enqueue(input.events.length > 0 ? input.events : [job.terminalFailureEvent], now, job.request.sourceRunId);
      } else if (input.events.length > 0) {
        validateMemoryEvents(input.events, job.request.sourceRunId, ['MEMORY_UPDATE_FAILED']);
        repo.enqueue(input.events, now, job.request.sourceRunId);
      }
    });
  }
  public review(input: { command: MemoryReviewCommand; now: string;
    events: readonly PendingAgentEventV2[] }): Promise<DiagnosticMemoryCase> {
    return this.transact((repo) => {
      const now = memoryInstant(input.now);
      const digest = memoryReviewDigest(input.command);
      const previous = repo.reviewCommand(input.command.requestId);
      if (previous !== null) {
        if (previous.digest !== digest) throw new MemoryError('MEMORY_REQUEST_CONFLICT');
        return structuredClone(previous.result);
      }
      const scopeKey = memoryScopeKey(input.command.scope);
      const existing = repo.getCase(input.command.memoryId, scopeKey);
      if (existing === null) throw new MemoryError('MEMORY_SCOPE_INVALID');
      if (existing.revision !== input.command.expectedRevision) throw new MemoryError('MEMORY_REVISION_CONFLICT');
      if (existing.status === 'rejected' || (existing.status === 'approved' && input.command.decision === 'approved')) {
        throw new MemoryError('MEMORY_APPROVAL_DENIED');
      }
      if (input.command.decision === 'approved'
        && (existing.sourceRunStatus !== 'completed' || existing.quality !== 'sufficient'
          || existing.eligibleForPromotion || input.command.claimCheck !== 'supported'
          || Date.parse(existing.validUntil) <= Date.parse(now))) {
        throw new MemoryError('MEMORY_APPROVAL_DENIED');
      }
      const next = parseMemoryCase({ ...existing, revision: existing.revision + 1,
        status: input.command.decision,
        eligibleForPromotion: input.command.decision === 'approved' && existing.scope.dataClass === 'live' });
      validateMemoryEvents(input.events, existing.sourceRunId, ['MEMORY_UPDATE_COMPLETED', 'EXPERIENCE_REVIEWED']);
      const completed = input.events.find((event) => event.type === 'MEMORY_UPDATE_COMPLETED');
      const reviewed = input.events.find((event) => event.type === 'EXPERIENCE_REVIEWED');
      if (completed === undefined || completed.payload.memoryId !== existing.id || completed.payload.status !== next.status
        || completed.payload.eligibility !== (next.eligibleForPromotion ? 'eligible' : 'not_eligible')
        || reviewed === undefined || reviewed.payload.candidateId !== existing.id
        || reviewed.payload.decision !== input.command.decision || reviewed.payload.reviewer !== input.command.actorId) {
        throw new MemoryError('MEMORY_DATA_INVALID');
      }
      repo.putCase(next, existing.revision);
      repo.putReviewCommand({ command: structuredClone(input.command), digest, result: structuredClone(next) });
      repo.enqueue(input.events, now, existing.sourceRunId);
      return structuredClone(next);
    });
  }
  public revalidate(input: { scope: MemoryScope; selections: readonly MemorySelection[]; now: string }): Promise<readonly DiagnosticMemoryCase[]> {
    return this.read((repo) => {
      const now = memoryInstant(input.now);
      const scopeKey = memoryScopeKey(input.scope);
      return input.selections.flatMap((selection) => {
        const value = repo.getCase(selection.memoryId, scopeKey);
        return value !== null && value.revision === selection.revision && value.digest === selection.digest
          && value.status === 'approved' && value.quality === 'sufficient' && value.sourceRunStatus === 'completed'
          && Date.parse(value.validUntil) > Date.parse(now) ? [value] : [];
      });
    });
  }
  public prune(input: { now: string; limit: number }): Promise<{ expiredObservations: number; signalsRemoved: number }> {
    return this.transact((repo) => repo.prune(memoryInstant(input.now), memoryLimit(input.limit, 50)));
  }
}

function assertClaim(job: MemoryJob | null, claim: MemoryJobClaim, now: string): asserts job is MemoryJob {
  if (job === null || job.state !== 'running' || job.ownerId !== claim.ownerId
    || job.attempt !== claim.attempt || job.leaseUntil !== claim.leaseUntil
    || checkpointChecksum(job.request) !== checkpointChecksum(claim.request)
    || Date.parse(job.leaseUntil) <= Date.parse(now)) throw new MemoryError('MEMORY_SOURCE_CONFLICT');
}

function validateMemoryEvents(events: readonly PendingAgentEventV2[], runId: string,
  allowed: readonly PendingAgentEventV2['type'][]): void {
  if (events.length === 0) throw new MemoryError('MEMORY_DATA_INVALID');
  for (const event of events) {
    if (event.runId !== runId || !allowed.includes(event.type)) throw new MemoryError('MEMORY_DATA_INVALID');
  }
}
