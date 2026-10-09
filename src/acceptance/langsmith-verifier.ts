import type { Client } from 'langsmith';
import type { TraceLink } from '../bootstrap/langsmith.js';
import type { AcceptanceSnapshot, TraceVerification } from './types.js';
import type { TraceVerificationDiagnostic } from './diagnostics.js';
import { containsSensitivePublicContent } from './privacy-audit.js';
import { LANGSMITH_RUN_READBACK_FIELDS } from './langsmith-query-transport.js';

const MAX_QUERIES = 3;
const MAX_DURATION_MS = 10_000;
const RETRY_DELAY_MS = 1_000;
const MAX_SPANS = 256;
const RUN_TERMINAL_EVENTS = new Set(['RUN_FINISHED', 'RUN_FAILED', 'RUN_CANCELLED', 'RUN_TIMED_OUT']);
const TERMINAL_SPAN_STATUSES = new Set([
  'success', 'error', 'completed', 'failed', 'cancelled', 'timed_out', 'paused', 'incomplete',
  'aborted', 'partial', 'unavailable',
]);
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_REMOTE_RUN_FIELDS = new Set<string>(LANGSMITH_RUN_READBACK_FIELDS);
const SAFE_REMOTE_INPUT_KEYS = new Set(['profile', 'purpose', 'stage']);
const SAFE_REMOTE_OUTPUT_KEYS = new Set([
  'status', 'outcome', 'stage', 'code', 'category', 'reasonCode', 'terminalStatus', 'finishReason',
  'usageCompleteness', 'durationMs', 'ttftMs', 'retryCount', 'cacheHit', 'evidenceIds',
  'missingEvidenceCodes', 'coverage', 'usage_metadata',
]);
const SAFE_REMOTE_METADATA_KEYS = new Set([
  'agentRunId', 'sessionId', 'replyId', 'streamId', 'spanKey', 'parentSpanKey', 'correlationId',
  'causationId', 'attemptId', 'toolCallId', 'stepId', 'profile', 'purpose', 'provider', 'model',
  'eventType', 'source', 'status', 'outcome', 'stage', 'subagentType', 'toolName', 'finishReason',
  'code', 'category', 'reasonCode', 'terminalStatus', 'usageCompleteness', 'attempt', 'durationMs',
  'ttftMs', 'retryCount', 'inputTokens', 'outputTokens', 'cacheHit', 'retryable', 'orphan',
  'continuedAfterPause', 'evidenceIds', 'missingEvidenceCodes', 'coverage', 'budget',
  'ls_provider', 'ls_model_name',
]);
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;

export type LangSmithRunPayloadSafetyIssue = 'remote_run_top_level_shape_invalid' | 'remote_run_extra_shape_invalid'
  | 'remote_run_inputs_shape_invalid' | 'remote_run_outputs_shape_invalid'
  | 'remote_run_metadata_shape_invalid' | 'remote_run_error_shape_invalid';
export type LangSmithRunTopLevelShape = 'not_object' | 'unselected_fields';
export interface LangSmithRunPayloadInspection {
  readonly issue: LangSmithRunPayloadSafetyIssue;
  readonly topLevelShape?: LangSmithRunTopLevelShape;
  readonly unexpectedTopLevelFieldCount?: number;
}

type RemoteRun = Awaited<ReturnType<Client['readRun']>>;
type SpanKind = 'execution' | 'invocation' | 'tool' | 'model';

class TraceQueryIntegrityError extends Error {}

interface ExpectedSpan {
  readonly spanKey: string;
  readonly agentRunId: string;
  readonly kind: SpanKind;
  readonly name: string;
  readonly parentSpanKey?: string;
  readonly attempt?: ModelAttempt;
}

interface ModelAttempt {
  readonly state: 'completed' | 'failed';
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly cachedInputTokens?: number };
  readonly finishReason?: string;
}

class LocalSnapshotError extends Error {
  constructor(readonly diagnosticReason: 'invalid_local_tree' | 'invalid_source_invocation') {
    super(diagnosticReason);
  }
}

interface SourceInvocation {
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly toolCallId: string;
  readonly subagentType: string;
  readonly lifecycleOwner: 'parent' | 'child';
  readonly streamId?: string;
  readonly baseSpanKey: string;
  readonly toolSpanKey: string;
}

export interface LangSmithVerifierDependencies {
  /** Monotonic clock in milliseconds. */
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam; production uses a timer-backed race against the remaining deadline. */
  readonly withDeadline?: <T>(operation: Promise<T>, timeoutMs: number) => Promise<T>;
  readonly onDiagnostic?: (diagnostic: TraceVerificationDiagnostic) => void;
}

/**
 * Verifies only the LangSmith spans linked to this local V2 run tree. It never
 * falls back to trace-wide or project-wide queries and does not expose remote
 * payloads in its result.
 */
export async function verifyLangSmithTrace(
  input: { client: Client; links: readonly TraceLink[]; snapshot: AcceptanceSnapshot },
  dependencies: LangSmithVerifierDependencies = {},
): Promise<TraceVerification> {
  const startedAt = safeNow(dependencies.now);
  const deadlineAt = startedAt + MAX_DURATION_MS;
  const report = (
    status: TraceVerification['status'],
    checkedSpanCount: number,
    phase: TraceVerificationDiagnostic['phase'],
    reason: TraceVerificationDiagnostic['reason'],
    remoteQueriesSent: number,
  ): TraceVerification => {
    try {
      dependencies.onDiagnostic?.({ phase, reason, remoteQueriesSent });
    } catch { /* local diagnostics must not change the verification result */ }
    return verification(status, checkedSpanCount);
  };
  let expectedSpans: readonly ExpectedSpan[];

  try {
    expectedSpans = deriveExpectedSpans(input.snapshot);
  } catch (error) {
    const reason = error instanceof LocalSnapshotError ? error.diagnosticReason : 'invalid_local_tree';
    return report('failed', 0, 'local_snapshot', reason, 0);
  }

  if (expectedSpans.length === 0 || expectedSpans.length > MAX_SPANS) {
    return report('unavailable', 0, 'local_snapshot', 'invalid_local_tree', 0);
  }

  const spanLinks = new Map<string, TraceLink>();
  const remoteIds = new Set<string>();
  for (const span of expectedSpans) {
    const matches = input.links.filter((link) => link.spanKey === span.spanKey);
    if (matches.length > 1) return report('failed', 0, 'local_links', 'invalid_link', 0);
    const link = matches[0];
    if (link === undefined) return report('unavailable', 0, 'local_links', 'missing_link', 0);
    if (link.agentRunId !== span.agentRunId || !UUID_PATTERN.test(link.remoteRunId) || !UUID_PATTERN.test(link.traceId)) {
      return report('failed', 0, 'local_links', 'invalid_link', 0);
    }
    if (remoteIds.has(link.remoteRunId)) return report('failed', 0, 'local_links', 'invalid_link', 0);
    remoteIds.add(link.remoteRunId);
    spanLinks.set(span.spanKey, link);
  }

  const rootExecution = expectedSpans.find((span) => span.kind === 'execution'
    && span.agentRunId === input.snapshot.parent.runId && span.parentSpanKey === undefined);
  const rootLink = rootExecution === undefined ? undefined : spanLinks.get(rootExecution.spanKey);
  if (rootLink === undefined) return report('failed', 0, 'local_links', 'invalid_link', 0);

  for (const span of expectedSpans) {
    const link = spanLinks.get(span.spanKey);
    if (link === undefined) return report('unavailable', 0, 'local_links', 'missing_link', 0);
    if (span.parentSpanKey === undefined) {
      if (link.parentRemoteRunId !== undefined) return report('failed', 0, 'local_links', 'invalid_link', 0);
    } else {
      const parent = spanLinks.get(span.parentSpanKey);
      if (parent === undefined) return report('unavailable', 0, 'local_links', 'missing_link', 0);
      if (link.parentRemoteRunId !== parent.remoteRunId || link.traceId !== parent.traceId) {
        return report('failed', 0, 'local_links', 'invalid_link', 0);
      }
    }
  }

  const ids = [...remoteIds].sort();
  const observedRuns = new Map<string, RemoteRun>();
  const now = dependencies.now ?? defaultNow;
  const sleep = dependencies.sleep ?? defaultSleep;
  const withDeadline = dependencies.withDeadline ?? defaultWithDeadline;
  let remoteQueriesSent = 0;

  for (let queryNumber = 1; queryNumber <= MAX_QUERIES; queryNumber += 1) {
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) {
      return report('unavailable', observedRuns.size, 'remote_query', 'remote_unavailable', remoteQueriesSent);
    }

    try {
      remoteQueriesSent += 1;
      const pendingQuery = collectRuns(input.client, ids);
      const runs = await withDeadline(pendingQuery, remainingMs);
      const querySeen = new Set<string>();
      for (const run of runs) {
        if (!remoteIds.has(run.id)) {
          return report('failed', observedRuns.size, 'remote_compare', 'remote_mismatch', remoteQueriesSent);
        }
        if (querySeen.has(run.id)) {
          return report('failed', observedRuns.size, 'remote_compare', 'remote_mismatch', remoteQueriesSent);
        }
        querySeen.add(run.id);
        observedRuns.set(run.id, run);
      }
    } catch (error) {
      const status = httpStatus(error);
      if (error instanceof TraceQueryIntegrityError) {
        return report('failed', observedRuns.size, 'remote_compare', 'remote_mismatch', remoteQueriesSent);
      }
      if (status === 403 || status === 404 || isTimeoutError(error)
        || queryNumber === MAX_QUERIES || isDeadlineExpired(deadlineAt, now)) {
        return report('unavailable', observedRuns.size, 'remote_query', 'remote_unavailable', remoteQueriesSent);
      }
    }

    const assessment = assessRemoteRuns(expectedSpans, spanLinks, observedRuns, rootLink.traceId);
    if (assessment.status === 'verified') {
      return report('verified', assessment.checkedSpanCount, 'complete', 'verified', remoteQueriesSent);
    }
    if (assessment.status === 'failed') {
      return report('failed', assessment.checkedSpanCount, 'remote_compare', assessment.reason, remoteQueriesSent);
    }
    if (queryNumber === MAX_QUERIES) {
      return report('unavailable', assessment.checkedSpanCount, 'remote_query', assessment.reason, remoteQueriesSent);
    }

    const remainingBeforeSleep = deadlineAt - now();
    if (remainingBeforeSleep <= 0) {
      return report('unavailable', assessment.checkedSpanCount, 'remote_query', 'remote_unavailable', remoteQueriesSent);
    }
    try {
      await withDeadline(sleep(Math.min(RETRY_DELAY_MS, remainingBeforeSleep)), remainingBeforeSleep);
    } catch {
      return report('unavailable', assessment.checkedSpanCount, 'remote_query', 'remote_unavailable', remoteQueriesSent);
    }
  }

  return report('unavailable', observedRuns.size, 'remote_query', 'remote_unavailable', remoteQueriesSent);
}

function deriveExpectedSpans(snapshot: AcceptanceSnapshot): ExpectedSpan[] {
  const parentId = snapshot.parent.runId;
  const childIds = snapshot.children.map((child) => child.runId);
  const localRunIds = new Set([parentId, ...childIds]);
  if (snapshot.parent.parentRunId !== undefined || childIds.length === 0
    || new Set(childIds).size !== childIds.length || childIds.includes(parentId)
    || snapshot.parent.childRunIds.length !== childIds.length
    || new Set(snapshot.parent.childRunIds).size !== childIds.length
    || !sameValues(snapshot.parent.childRunIds, childIds)
    || snapshot.children.some((child) => child.parentRunId !== parentId)) {
    throw new Error('INVALID_LOCAL_RUN_TREE');
  }

  const events = snapshot.events.filter((event) => localRunIds.has(event.runId));
  if (events.some((event) => !localRunIds.has(event.runId))) throw new Error('INVALID_LOCAL_RUN_TREE');
  for (const runId of localRunIds) {
    const runEvents = events.filter((event) => event.runId === runId);
    if (runEvents.filter((event) => event.type === 'RUN_STARTED').length !== 1
      || runEvents.filter((event) => RUN_TERMINAL_EVENTS.has(event.type)).length !== 1) {
      throw new Error('LOCAL_RUN_NOT_TERMINAL');
    }
    const publicRun = runId === parentId ? snapshot.parent : snapshot.children.find((child) => child.runId === runId);
    if (publicRun === undefined || !['completed', 'failed', 'cancelled', 'timed_out'].includes(publicRun.status)) {
      throw new Error('LOCAL_RUN_NOT_TERMINAL');
    }
  }

  const spans = new Map<string, ExpectedSpan>();
  const addSpan = (span: ExpectedSpan): void => {
    if (spans.has(span.spanKey)) throw new Error('DUPLICATE_LOCAL_SPAN');
    spans.set(span.spanKey, span);
  };
  const executionKeys = new Map<string, string>();
  const invocationByChild = new Map<string, SourceInvocation>();
  const invocationByResume = new Map<string, string>();
  const subagentStarts = events.filter((event) => event.type === 'SUBAGENT_STARTED');
  const subagentTerminals = events.filter((event) => event.type === 'SUBAGENT_COMPLETED' || event.type === 'SUBAGENT_FAILED');

  for (const start of subagentStarts) {
    if (start.type !== 'SUBAGENT_STARTED' || start.payload.parentRunId !== parentId
      || !childIds.includes(start.payload.childRunId) || typeof start.toolCallId !== 'string'
      || start.toolCallId.length === 0) {
      throw new LocalSnapshotError('invalid_source_invocation');
    }
    const lifecycleOwner = sourceLifecycleOwner(start, parentId, start.payload.childRunId);
    if (lifecycleOwner === undefined || invocationByChild.has(start.payload.childRunId)) {
      throw new LocalSnapshotError('invalid_source_invocation');
    }

    const sourceStreamId = start.streamId ?? 'initial';
    const toolStarts = events.filter((event) => event.type === 'TOOL_STARTED' && event.runId === parentId
      && (event.streamId ?? 'initial') === sourceStreamId && event.toolCallId === start.toolCallId);
    if (toolStarts.length !== 1 || toolStarts[0]?.type !== 'TOOL_STARTED'
      || toolStarts[0].payload.source !== 'subagent'
      || toolStarts[0].payload.toolName !== `${start.payload.subagentType}_subagent`) {
      throw new LocalSnapshotError('invalid_source_invocation');
    }
    const toolStart = toolStarts[0];
    if (toolStart.type !== 'TOOL_STARTED') throw new LocalSnapshotError('invalid_source_invocation');

    const toolAttempt = toolStart.attemptId ?? String(toolStart.payload.attempt);
    const toolSpanKey = `tool:${parentId}:${toolStart.streamId ?? 'initial'}:${start.toolCallId}:${toolAttempt}`;
    const toolParentKey = `run:${parentId}:${toolStart.streamId ?? 'initial'}`;
    addSpan({
      spanKey: toolSpanKey,
      agentRunId: parentId,
      kind: 'tool',
      name: `tool.${toolStart.payload.toolName}`,
      parentSpanKey: toolParentKey,
    });
    const toolTerminals = events.filter((event) => (event.type === 'TOOL_RESULT' || event.type === 'TOOL_FAILED')
      && event.runId === parentId && (event.streamId ?? 'initial') === sourceStreamId
      && event.toolCallId === start.toolCallId);
    if (toolTerminals.length !== 1) throw new LocalSnapshotError('invalid_source_invocation');

    const baseSpanKey = `source:${parentId}:${start.toolCallId}:${start.payload.childRunId}`;
    const invocation: SourceInvocation = {
      parentRunId: parentId,
      childRunId: start.payload.childRunId,
      toolCallId: start.toolCallId,
      subagentType: start.payload.subagentType,
      lifecycleOwner,
      ...(start.streamId === undefined ? {} : { streamId: start.streamId }),
      baseSpanKey,
      toolSpanKey,
    };
    invocationByChild.set(start.payload.childRunId, invocation);
    addSpan({
      spanKey: baseSpanKey,
      agentRunId: parentId,
      kind: 'invocation',
      name: `subagent.${start.payload.subagentType}`,
      parentSpanKey: toolSpanKey,
    });
    const invocationTerminals = subagentTerminals.filter((event) => event.payload.childRunId === start.payload.childRunId);
    if (invocationTerminals.length !== 1) throw new LocalSnapshotError('invalid_source_invocation');
    const terminal = invocationTerminals[0];
    if (terminal === undefined || terminal.toolCallId !== start.toolCallId
      || terminal.streamId !== start.streamId
      || sourceLifecycleOwner(terminal, parentId, start.payload.childRunId) !== lifecycleOwner) {
      throw new LocalSnapshotError('invalid_source_invocation');
    }
  }

  if (invocationByChild.size !== childIds.length || subagentTerminals.length !== childIds.length
    || subagentTerminals.some((event) => !invocationByChild.has(event.payload.childRunId))) {
    throw new LocalSnapshotError('invalid_source_invocation');
  }

  for (const childId of childIds) {
    const invocation = invocationByChild.get(childId);
    if (invocation === undefined) throw new Error('SOURCE_INVOCATION_MISSING');
    let resumeCount = 0;
    for (const event of events.filter((item) => item.runId === childId).sort((left, right) => left.sequence - right.sequence)) {
      if (event.type !== 'RUN_RESUMED') continue;
      resumeCount += 1;
      if (event.streamId !== event.payload.newStreamId) throw new Error('INVALID_RESUME_STREAM');
      const resumedKey = `${invocation.baseSpanKey}:resume:${event.payload.newStreamId}:${resumeCount}`;
      addSpan({
        spanKey: resumedKey,
        agentRunId: parentId,
        kind: 'invocation',
        name: `subagent.${invocation.subagentType}`,
        parentSpanKey: invocation.toolSpanKey,
      });
      invocationByResume.set(`${childId}\u0000${event.payload.newStreamId}`, resumedKey);
    }
  }

  for (const runId of localRunIds) {
    const runEvents = events.filter((event) => event.runId === runId).sort((left, right) => left.sequence - right.sequence);
    const childInvocation = invocationByChild.get(runId);
    for (const event of runEvents) {
      if (event.type === 'RUN_STARTED') {
        const streamId = event.streamId ?? 'initial';
        const parentSpanKey = childInvocation?.baseSpanKey;
        const spanKey = `run:${runId}:${streamId}`;
        addSpan({
          spanKey,
          agentRunId: runId,
          kind: 'execution',
          name: 'agent.run',
          ...(parentSpanKey === undefined ? {} : { parentSpanKey }),
        });
        executionKeys.set(`${runId}\u0000${streamId}`, spanKey);
      } else if (event.type === 'RUN_RESUMED') {
        const streamId = event.payload.newStreamId;
        if (event.streamId !== streamId) throw new Error('INVALID_RESUME_STREAM');
        const spanKey = `run:${runId}:${streamId}`;
        const parentSpanKey = childInvocation === undefined
          ? undefined
          : invocationByResume.get(`${runId}\u0000${streamId}`);
        if (childInvocation !== undefined && parentSpanKey === undefined) throw new Error('RESUMED_INVOCATION_MISSING');
        addSpan({
          spanKey,
          agentRunId: runId,
          kind: 'execution',
          name: 'agent.run',
          ...(parentSpanKey === undefined ? {} : { parentSpanKey }),
        });
        executionKeys.set(`${runId}\u0000${streamId}`, spanKey);
      }
    }
  }

  for (const event of events) {
    if (event.type !== 'MODEL_CALL_STARTED') continue;
    const streamId = event.streamId ?? 'initial';
    const attemptId = event.attemptId ?? String(event.payload.attempt);
    const spanKey = `model:${event.runId}:${streamId}:${attemptId}`;
    const parentSpanKey = executionKeys.get(`${event.runId}\u0000${streamId}`);
    if (parentSpanKey === undefined) throw new Error('MODEL_ATTEMPT_WITHOUT_EXECUTION');
    const terminalEvents = events.filter((candidate) => (candidate.type === 'MODEL_CALL_COMPLETED' || candidate.type === 'MODEL_CALL_FAILED')
      && candidate.runId === event.runId && (candidate.streamId ?? 'initial') === streamId
      && (candidate.attemptId ?? String(candidate.payload.attempt)) === attemptId);
    if (terminalEvents.length !== 1) throw new Error('MODEL_ATTEMPT_NOT_TERMINAL');
    const terminal = terminalEvents[0];
    if (terminal === undefined || (terminal.type !== 'MODEL_CALL_COMPLETED' && terminal.type !== 'MODEL_CALL_FAILED')) {
      throw new Error('MODEL_ATTEMPT_NOT_TERMINAL');
    }
    const usage = safeModelUsage(terminal.payload.usage);
    const finishReason = isSafeIdentifier(terminal.payload.finishReason)
      ? terminal.payload.finishReason
      : undefined;
    const attempt: ModelAttempt = terminal.type === 'MODEL_CALL_COMPLETED'
      ? {
        state: 'completed',
        ...(usage === undefined ? {} : { usage }),
        ...(finishReason === undefined ? {} : { finishReason }),
      }
      : {
        state: 'failed',
        ...(usage === undefined ? {} : { usage }),
        ...(finishReason === undefined ? {} : { finishReason }),
      };
    addSpan({
      spanKey,
      agentRunId: event.runId,
      kind: 'model',
      name: `model.${event.payload.model}`,
      parentSpanKey,
      attempt,
    });
  }

  const attemptTerminals = events.filter((event) => event.type === 'MODEL_CALL_COMPLETED' || event.type === 'MODEL_CALL_FAILED');
  for (const terminal of attemptTerminals) {
    const streamId = terminal.streamId ?? 'initial';
    const attemptId = terminal.attemptId ?? String(terminal.payload.attempt);
    const key = `model:${terminal.runId}:${streamId}:${attemptId}`;
    if (!spans.has(key)) throw new Error('MODEL_TERMINAL_WITHOUT_START');
  }

  if (![...spans.values()].some((span) => span.kind === 'model')) throw new Error('MODEL_ATTEMPT_MISSING');
  return [...spans.values()];
}

async function collectRuns(client: Client, ids: readonly string[]): Promise<RemoteRun[]> {
  const iterator = client.listRuns({
    id: [...ids],
    limit: ids.length,
    select: [...LANGSMITH_RUN_READBACK_FIELDS],
  })[Symbol.asyncIterator]();
  const runs: RemoteRun[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return runs;
    if (runs.length >= ids.length) throw new TraceQueryIntegrityError('TRACE_QUERY_RESULT_LIMIT_EXCEEDED');
    runs.push(next.value);
  }
}

function assessRemoteRuns(
  spans: readonly ExpectedSpan[],
  links: ReadonlyMap<string, TraceLink>,
  runsById: ReadonlyMap<string, RemoteRun>,
  rootTraceId: string,
): { status: TraceVerification['status']; checkedSpanCount: number; reason: TraceVerificationDiagnostic['reason'] } {
  let needsAnotherQuery = false;
  let unavailableReason: 'remote_unavailable' | 'usage_unavailable' = 'remote_unavailable';
  let checkedSpanCount = 0;
  for (const span of spans) {
    const link = links.get(span.spanKey);
    if (link === undefined) return { status: 'unavailable', checkedSpanCount, reason: 'missing_link' };
    const run = runsById.get(link.remoteRunId);
    if (run === undefined) {
      needsAnotherQuery = true;
      continue;
    }
    checkedSpanCount += 1;
    if (run.id !== link.remoteRunId || run.trace_id !== link.traceId || link.traceId !== rootTraceId
      || run.name !== span.name || run.run_type !== expectedRunType(span.kind)
      || remoteParentId(run) !== link.parentRemoteRunId || !isSafeLangSmithRunPayload(run)) {
      return { status: 'failed', checkedSpanCount, reason: 'remote_mismatch' };
    }
    if (!isRemoteTerminal(run)) {
      needsAnotherQuery = true;
      continue;
    }
    if (span.kind === 'model') {
      const comparison = compareModelAttempt(span, run);
      if (comparison.status === 'failed') {
        return { status: 'failed', checkedSpanCount, reason: comparison.reason };
      }
      if (comparison.status === 'unavailable') {
        needsAnotherQuery = true;
        unavailableReason = comparison.reason;
      }
    }
  }
  return needsAnotherQuery
    ? { status: 'unavailable', checkedSpanCount, reason: unavailableReason }
    : { status: 'verified', checkedSpanCount, reason: 'verified' };
}

function compareModelAttempt(
  span: ExpectedSpan,
  run: RemoteRun,
):
  | { status: 'verified'; reason: 'verified' }
  | { status: 'failed'; reason: 'remote_mismatch' | 'usage_mismatch' }
  | { status: 'unavailable'; reason: 'remote_unavailable' | 'usage_unavailable' } {
  const attempt = span.attempt;
  if (attempt === undefined) return { status: 'unavailable', reason: 'usage_unavailable' };
  const remoteOutcome = remoteModelOutcome(run);
  if (remoteOutcome === 'unknown') return { status: 'unavailable', reason: 'remote_unavailable' };
  if (remoteOutcome !== attempt.state) return { status: 'failed', reason: 'remote_mismatch' };

  const localUsage = attempt.usage;
  if (localUsage === undefined) return { status: 'unavailable', reason: 'usage_unavailable' };

  const outputs = asRecord(run.outputs);
  const remoteUsage = asRecord(outputs?.usage_metadata);
  if (remoteUsage === undefined) return { status: 'unavailable', reason: 'usage_unavailable' };
  const tokenFields = [
    ['inputTokens', 'input_tokens'],
    ['outputTokens', 'output_tokens'],
  ] as const;
  for (const [localKey, remoteKey] of tokenFields) {
    const localValue = localUsage[localKey];
    if (localValue === undefined) continue;
    const remoteValue = remoteUsage[remoteKey];
    if (!isSafeToken(remoteValue)) return { status: 'unavailable', reason: 'usage_unavailable' };
    if (remoteValue !== localValue) return { status: 'failed', reason: 'usage_mismatch' };
  }
  const hasInputAndOutput = localUsage.inputTokens !== undefined && localUsage.outputTokens !== undefined;
  if (hasInputAndOutput) {
    const totalTokens = remoteUsage['total_tokens'];
    if (!isSafeToken(totalTokens)) return { status: 'unavailable', reason: 'usage_unavailable' };
    if (totalTokens !== localUsage.inputTokens + localUsage.outputTokens) {
      return { status: 'failed', reason: 'usage_mismatch' };
    }
  } else if (localUsage.inputTokens === undefined && localUsage.outputTokens === undefined) {
    return { status: 'unavailable', reason: 'usage_unavailable' };
  }

  if (localUsage.cachedInputTokens !== undefined) {
    const details = asRecord(remoteUsage.input_token_details);
    if (!isSafeToken(localUsage.cachedInputTokens) || !isSafeToken(details?.cache_read)) {
      return { status: 'unavailable', reason: 'usage_unavailable' };
    }
    if (details.cache_read !== localUsage.cachedInputTokens) return { status: 'failed', reason: 'usage_mismatch' };
  }
  if (attempt.finishReason !== undefined) {
    const remoteFinishReason = outputs?.['finishReason'];
    if (typeof remoteFinishReason !== 'string') return { status: 'unavailable', reason: 'usage_unavailable' };
    if (remoteFinishReason !== attempt.finishReason) return { status: 'failed', reason: 'usage_mismatch' };
  }
  return { status: 'verified', reason: 'verified' };
}

function remoteModelOutcome(run: RemoteRun): ModelAttempt['state'] | 'unknown' {
  if (typeof run.error === 'string' && run.error.length > 0) return 'failed';
  const outputStatus = asRecord(run.outputs)?.['status'];
  const status = typeof outputStatus === 'string' ? outputStatus : run.status;
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'completed' || status === 'success') return 'completed';
  if (status === undefined && run.end_time !== undefined && run.end_time !== null) return 'completed';
  return 'unknown';
}

/** Validates selected remote/readback Run fields, including LangSmith-generated run-depth metadata. */
export function isSafeLangSmithRunPayload(value: unknown): boolean {
  return inspectLangSmithRunPayload(value) === undefined;
}

/** Validates locally constructed export metadata with no LangSmith readback-only fields. */
export function isSafeLangSmithOutboundRunPayload(value: unknown): boolean {
  return inspectLangSmithRunPayloadDetails(value, { allowLangSmithRunDepth: false }) === undefined;
}

/** Returns a fixed privacy-safe rejection category without exposing keys or values. */
export function inspectLangSmithRunPayload(value: unknown): LangSmithRunPayloadSafetyIssue | undefined {
  return inspectLangSmithRunPayloadDetails(value)?.issue;
}

/** Adds only static shape information and a count; remote field names and values stay private. */
export function inspectLangSmithRunPayloadDetails(
  value: unknown,
  options: { readonly allowLangSmithRunDepth?: boolean } = {},
): LangSmithRunPayloadInspection | undefined {
  if (!isRecord(value)) return { issue: 'remote_run_top_level_shape_invalid', topLevelShape: 'not_object' };
  const unexpectedTopLevelFieldCount = Object.keys(value).filter((key) => !SAFE_REMOTE_RUN_FIELDS.has(key)).length;
  if (unexpectedTopLevelFieldCount > 0) {
    return { issue: 'remote_run_top_level_shape_invalid', topLevelShape: 'unselected_fields', unexpectedTopLevelFieldCount };
  }
  const extra = value['extra'];
  if (extra !== undefined && extra !== null && !isRecord(extra)) return { issue: 'remote_run_extra_shape_invalid' };
  if (isRecord(extra) && Object.keys(extra).some((key) => key !== 'metadata')) return { issue: 'remote_run_extra_shape_invalid' };
  const metadata = isRecord(extra) ? extra['metadata'] : undefined;
  if (!isSafeIdentifierMap(value['inputs'], SAFE_REMOTE_INPUT_KEYS)) return { issue: 'remote_run_inputs_shape_invalid' };
  if (!isSafeOutputMap(value['outputs'])) return { issue: 'remote_run_outputs_shape_invalid' };
  if (!isSafeMetadataMap(metadata, options.allowLangSmithRunDepth !== false)) {
    return { issue: 'remote_run_metadata_shape_invalid' };
  }
  if (value['error'] !== undefined && value['error'] !== null && value['error'] !== '' && value['error'] !== 'TRACE_ERROR') {
    return { issue: 'remote_run_error_shape_invalid' };
  }
  return undefined;
}

function isSafeIdentifierMap(value: unknown, allowedKeys: ReadonlySet<string>): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => allowedKeys.has(key) && isSafeIdentifier(item));
}

function isSafeOutputMap(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (!SAFE_REMOTE_OUTPUT_KEYS.has(key)) return false;
    if (['status', 'outcome', 'stage', 'code', 'category', 'reasonCode', 'terminalStatus', 'finishReason', 'usageCompleteness'].includes(key)) {
      return isSafeIdentifier(item);
    }
    if (['durationMs', 'ttftMs', 'retryCount'].includes(key)) return isSafeToken(item);
    if (key === 'cacheHit') return typeof item === 'boolean';
    if (key === 'evidenceIds' || key === 'missingEvidenceCodes') {
      return Array.isArray(item) && item.length <= 100 && item.every(isSafeIdentifier);
    }
    if (key === 'coverage') return isSafeNumericBooleanMap(item);
    return key === 'usage_metadata' && isSafeUsageMetadata(item);
  });
}

function isSafeMetadataMap(value: unknown, allowLangSmithRunDepth: boolean): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (!SAFE_REMOTE_METADATA_KEYS.has(key) && !(allowLangSmithRunDepth && key === 'ls_run_depth')) return false;
    if (key === 'eventType') return typeof item === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(item);
    if (['agentRunId', 'sessionId', 'replyId', 'streamId', 'spanKey', 'parentSpanKey', 'correlationId',
      'causationId', 'attemptId', 'toolCallId', 'stepId', 'profile', 'purpose', 'provider', 'model',
      'source', 'status', 'outcome', 'stage', 'subagentType', 'toolName', 'finishReason', 'code',
      'category', 'reasonCode', 'terminalStatus', 'usageCompleteness', 'ls_provider', 'ls_model_name'].includes(key)) {
      return isSafeIdentifier(item);
    }
    // LangSmith adds this numeric metadata during remote readback; outbound metadata remains separately allowlisted.
    if (key === 'ls_run_depth') return allowLangSmithRunDepth && isSafeToken(item);
    if (['attempt', 'durationMs', 'ttftMs', 'retryCount', 'inputTokens', 'outputTokens'].includes(key)) {
      return isSafeToken(item);
    }
    if (['cacheHit', 'retryable', 'orphan', 'continuedAfterPause'].includes(key)) return typeof item === 'boolean';
    if (key === 'evidenceIds' || key === 'missingEvidenceCodes') {
      return Array.isArray(item) && item.length <= 100 && item.every(isSafeIdentifier);
    }
    if (key === 'coverage') return isSafeNumericBooleanMap(item);
    if (key === 'budget') {
      return isRecord(item) && Object.keys(item).every((field) => ['type', 'limit', 'used'].includes(field))
        && isSafeIdentifier(item['type']) && isSafeToken(item['limit']) && isSafeToken(item['used']);
    }
    return false;
  });
}

function isSafeNumericBooleanMap(value: unknown): boolean {
  return isRecord(value) && Object.entries(value).length <= 32
    && Object.entries(value).every(([key, item]) => isSafeIdentifier(key)
      && (typeof item === 'boolean' || isSafeToken(item)));
}

function isSafeUsageMetadata(value: unknown): boolean {
  if (!isRecord(value) || !Object.keys(value).every((key) =>
    ['input_tokens', 'output_tokens', 'total_tokens', 'input_token_details'].includes(key))) return false;
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (value[key] !== undefined && !isSafeToken(value[key])) return false;
  }
  if (value['input_token_details'] !== undefined) {
    const details = value['input_token_details'];
    if (!isRecord(details) || !Object.keys(details).every((key) => key === 'cache_read')
      || (details['cache_read'] !== undefined && !isSafeToken(details['cache_read']))) return false;
  }
  return true;
}

function isRemoteTerminal(run: RemoteRun): boolean {
  const endTime = run.end_time;
  if (endTime === undefined || endTime === null) return false;
  const parsedEndTime = typeof endTime === 'number' ? endTime : Date.parse(endTime);
  if (!Number.isFinite(parsedEndTime)) return false;
  const outputStatus = asRecord(run.outputs)?.status;
  const status = typeof outputStatus === 'string' ? outputStatus : run.status;
  return status === undefined || TERMINAL_SPAN_STATUSES.has(status.toLowerCase());
}

function expectedRunType(kind: SpanKind): string {
  switch (kind) {
    case 'execution':
    case 'invocation':
      return 'chain';
    case 'tool':
      return 'tool';
    case 'model':
      return 'llm';
  }
}

function remoteParentId(run: RemoteRun): string | undefined {
  return run.parent_run_id ?? undefined;
}

type SourceLifecycleEvent = Extract<AcceptanceSnapshot['events'][number], {
  type: 'SUBAGENT_STARTED' | 'SUBAGENT_COMPLETED' | 'SUBAGENT_FAILED';
}>;

function sourceLifecycleOwner(
  event: SourceLifecycleEvent,
  parentRunId: string,
  childRunId: string,
): 'parent' | 'child' | undefined {
  if (event.runId === childRunId && event.parentRunId === parentRunId) return 'child';
  if (event.runId === parentRunId && (event.parentRunId === undefined || event.parentRunId === parentRunId)) return 'parent';
  return undefined;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeModelUsage(value: {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
} | undefined): ModelAttempt['usage'] | undefined {
  if (value === undefined) return undefined;
  const usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {};
  if (isSafeToken(value.inputTokens)) usage.inputTokens = value.inputTokens;
  if (isSafeToken(value.outputTokens)) usage.outputTokens = value.outputTokens;
  if (isSafeToken(value.cachedInputTokens)) usage.cachedInputTokens = value.cachedInputTokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function isSafeToken(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SAFE_IDENTIFIER_PATTERN.test(value)
    && !containsSensitivePublicContent(value);
}

function verification(status: TraceVerification['status'], checkedSpanCount: number): TraceVerification {
  return { status, checkedSpanCount: isSafeToken(checkedSpanCount) ? checkedSpanCount : 0 };
}

function safeNow(now: (() => number) | undefined): number {
  const value = (now ?? defaultNow)();
  return Number.isFinite(value) ? value : defaultNow();
}

function defaultNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function defaultWithDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('TRACE_VERIFICATION_DEADLINE')), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isDeadlineExpired(deadlineAt: number, now: () => number): boolean {
  return deadlineAt - now() <= 0;
}

function isTimeoutError(error: unknown): boolean {
  const record = asRecord(error);
  return record?.name === 'TimeoutError' || record?.name === 'AbortError';
}

function httpStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const status = record?.status ?? record?.statusCode ?? response?.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}
