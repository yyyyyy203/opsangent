import type { Client } from 'langsmith';
import type { TraceLink } from '../bootstrap/langsmith.js';
import type { AcceptanceSnapshot, TraceVerification } from './types.js';
import { containsSensitivePublicContent } from './privacy-audit.js';

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
const SELECTED_RUN_FIELDS = [
  'id', 'trace_id', 'parent_run_id', 'name', 'run_type', 'end_time', 'status', 'error', 'inputs', 'outputs', 'extra',
];
const SAFE_REMOTE_RUN_FIELDS = new Set(SELECTED_RUN_FIELDS);
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
}

interface SourceInvocation {
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly toolCallId: string;
  readonly subagentType: string;
  readonly baseSpanKey: string;
  readonly toolSpanKey: string;
}

export interface LangSmithVerifierDependencies {
  /** Monotonic clock in milliseconds. */
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam; production uses a timer-backed race against the remaining deadline. */
  readonly withDeadline?: <T>(operation: Promise<T>, timeoutMs: number) => Promise<T>;
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
  let expectedSpans: readonly ExpectedSpan[];

  try {
    expectedSpans = deriveExpectedSpans(input.snapshot);
  } catch {
    return verification('failed', 0);
  }

  if (expectedSpans.length === 0 || expectedSpans.length > MAX_SPANS) return verification('unavailable', 0);

  const spanLinks = new Map<string, TraceLink>();
  const remoteIds = new Set<string>();
  for (const span of expectedSpans) {
    const matches = input.links.filter((link) => link.spanKey === span.spanKey);
    if (matches.length > 1) return verification('failed', 0);
    const link = matches[0];
    if (link === undefined) return verification('unavailable', 0);
    if (link.agentRunId !== span.agentRunId || !UUID_PATTERN.test(link.remoteRunId) || !UUID_PATTERN.test(link.traceId)) {
      return verification('failed', 0);
    }
    if (remoteIds.has(link.remoteRunId)) return verification('failed', 0);
    remoteIds.add(link.remoteRunId);
    spanLinks.set(span.spanKey, link);
  }

  const rootExecution = expectedSpans.find((span) => span.kind === 'execution'
    && span.agentRunId === input.snapshot.parent.runId && span.parentSpanKey === undefined);
  const rootLink = rootExecution === undefined ? undefined : spanLinks.get(rootExecution.spanKey);
  if (rootLink === undefined) return verification('failed', 0);

  for (const span of expectedSpans) {
    const link = spanLinks.get(span.spanKey);
    if (link === undefined) return verification('unavailable', 0);
    if (span.parentSpanKey === undefined) {
      if (link.parentRemoteRunId !== undefined) return verification('failed', 0);
    } else {
      const parent = spanLinks.get(span.parentSpanKey);
      if (parent === undefined) return verification('unavailable', 0);
      if (link.parentRemoteRunId !== parent.remoteRunId || link.traceId !== parent.traceId) {
        return verification('failed', 0);
      }
    }
  }

  const ids = [...remoteIds].sort();
  const observedRuns = new Map<string, RemoteRun>();
  const now = dependencies.now ?? defaultNow;
  const sleep = dependencies.sleep ?? defaultSleep;
  const withDeadline = dependencies.withDeadline ?? defaultWithDeadline;

  for (let queryNumber = 1; queryNumber <= MAX_QUERIES; queryNumber += 1) {
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) return verification('unavailable', observedRuns.size);

    try {
      const pendingQuery = collectRuns(input.client, ids);
      const runs = await withDeadline(pendingQuery, remainingMs);
      const querySeen = new Set<string>();
      for (const run of runs) {
        if (!remoteIds.has(run.id)) return verification('failed', observedRuns.size);
        if (querySeen.has(run.id)) return verification('failed', observedRuns.size);
        querySeen.add(run.id);
        observedRuns.set(run.id, run);
      }
    } catch (error) {
      const status = httpStatus(error);
      if (error instanceof TraceQueryIntegrityError) return verification('failed', observedRuns.size);
      if (status === 403 || status === 404 || isTimeoutError(error)
        || queryNumber === MAX_QUERIES || isDeadlineExpired(deadlineAt, now)) {
        return verification('unavailable', observedRuns.size);
      }
    }

    const assessment = assessRemoteRuns(expectedSpans, spanLinks, observedRuns, rootLink.traceId);
    if (assessment.status === 'verified' || assessment.status === 'failed') {
      return verification(assessment.status, assessment.checkedSpanCount);
    }
    if (queryNumber === MAX_QUERIES) return verification('unavailable', assessment.checkedSpanCount);

    const remainingBeforeSleep = deadlineAt - now();
    if (remainingBeforeSleep <= 0) return verification('unavailable', assessment.checkedSpanCount);
    try {
      await withDeadline(sleep(Math.min(RETRY_DELAY_MS, remainingBeforeSleep)), remainingBeforeSleep);
    } catch {
      return verification('unavailable', assessment.checkedSpanCount);
    }
  }

  return verification('unavailable', observedRuns.size);
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

  for (const start of subagentStarts) {
    if (start.type !== 'SUBAGENT_STARTED' || start.runId !== parentId || start.payload.parentRunId !== parentId
      || !childIds.includes(start.payload.childRunId) || start.toolCallId === undefined) {
      throw new Error('INVALID_SOURCE_INVOCATION');
    }
    if (invocationByChild.has(start.payload.childRunId)) throw new Error('DUPLICATE_SOURCE_INVOCATION');

    const toolStarts = events.filter((event) => event.type === 'TOOL_STARTED' && event.runId === parentId
      && event.toolCallId === start.toolCallId && event.payload.source === 'subagent'
      && event.payload.toolName === `${start.payload.subagentType}_subagent`);
    if (toolStarts.length !== 1) throw new Error('SOURCE_TOOL_START_MISMATCH');
    const toolStart = toolStarts[0];
    if (toolStart?.type !== 'TOOL_STARTED') throw new Error('SOURCE_TOOL_START_MISMATCH');

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
      && event.runId === parentId && event.toolCallId === start.toolCallId);
    if (toolTerminals.length !== 1) throw new Error('SOURCE_TOOL_NOT_TERMINAL');

    const baseSpanKey = `source:${parentId}:${start.toolCallId}:${start.payload.childRunId}`;
    const invocation: SourceInvocation = {
      parentRunId: parentId,
      childRunId: start.payload.childRunId,
      toolCallId: start.toolCallId,
      subagentType: start.payload.subagentType,
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
    const invocationTerminals = events.filter((event) => (event.type === 'SUBAGENT_COMPLETED' || event.type === 'SUBAGENT_FAILED')
      && event.runId === parentId && event.payload.childRunId === start.payload.childRunId);
    if (invocationTerminals.length !== 1) throw new Error('SOURCE_INVOCATION_NOT_TERMINAL');
  }

  if (invocationByChild.size !== childIds.length) throw new Error('SOURCE_INVOCATION_MISSING');

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
    const attempt: ModelAttempt = terminal?.type === 'MODEL_CALL_COMPLETED'
      ? { state: 'completed', ...(terminal.payload.usage === undefined ? {} : { usage: terminal.payload.usage }) }
      : { state: 'failed' };
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
    select: SELECTED_RUN_FIELDS,
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
): { status: TraceVerification['status']; checkedSpanCount: number } {
  let needsAnotherQuery = false;
  let checkedSpanCount = 0;
  for (const span of spans) {
    const link = links.get(span.spanKey);
    if (link === undefined) return { status: 'unavailable', checkedSpanCount };
    const run = runsById.get(link.remoteRunId);
    if (run === undefined) {
      needsAnotherQuery = true;
      continue;
    }
    checkedSpanCount += 1;
    if (run.id !== link.remoteRunId || run.trace_id !== link.traceId || link.traceId !== rootTraceId
      || run.name !== span.name || run.run_type !== expectedRunType(span.kind)
      || remoteParentId(run) !== link.parentRemoteRunId || !isSafeLangSmithRunPayload(run)) {
      return { status: 'failed', checkedSpanCount };
    }
    if (!isRemoteTerminal(run)) {
      needsAnotherQuery = true;
      continue;
    }
    if (span.kind === 'model') {
      const usageStatus = compareModelUsage(span, run);
      if (usageStatus === 'failed') return { status: 'failed', checkedSpanCount };
      if (usageStatus === 'unavailable') needsAnotherQuery = true;
    }
  }
  return needsAnotherQuery
    ? { status: 'unavailable', checkedSpanCount }
    : { status: 'verified', checkedSpanCount };
}

function compareModelUsage(span: ExpectedSpan, run: RemoteRun): 'verified' | 'failed' | 'unavailable' {
  const attempt = span.attempt;
  if (attempt === undefined || attempt.state === 'failed') return 'unavailable';
  const localUsage = attempt.usage;
  if (localUsage === undefined || !isSafeToken(localUsage.inputTokens) || !isSafeToken(localUsage.outputTokens)) {
    return 'unavailable';
  }
  if (run.error !== undefined && run.error !== null && run.error.length > 0) return 'failed';

  const outputs = asRecord(run.outputs);
  const remoteUsage = asRecord(outputs?.usage_metadata);
  const inputTokens = remoteUsage?.input_tokens;
  const outputTokens = remoteUsage?.output_tokens;
  const totalTokens = remoteUsage?.total_tokens;
  if (remoteUsage === undefined || !isSafeToken(inputTokens) || !isSafeToken(outputTokens) || !isSafeToken(totalTokens)) {
    return 'unavailable';
  }
  if (inputTokens !== localUsage.inputTokens || outputTokens !== localUsage.outputTokens
    || totalTokens !== localUsage.inputTokens + localUsage.outputTokens) return 'failed';

  if (localUsage.cachedInputTokens !== undefined) {
    const details = asRecord(remoteUsage.input_token_details);
    if (!isSafeToken(localUsage.cachedInputTokens) || !isSafeToken(details?.cache_read)) return 'unavailable';
    if (details.cache_read !== localUsage.cachedInputTokens) return 'failed';
  }
  return 'verified';
}

export function isSafeLangSmithRunPayload(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => !SAFE_REMOTE_RUN_FIELDS.has(key))) return false;
  const extra = value['extra'];
  if (extra !== undefined && extra !== null && !isRecord(extra)) return false;
  if (isRecord(extra) && Object.keys(extra).some((key) => key !== 'metadata')) return false;
  const metadata = isRecord(extra) ? extra['metadata'] : undefined;
  return isSafeIdentifierMap(value['inputs'], SAFE_REMOTE_INPUT_KEYS)
    && isSafeOutputMap(value['outputs'])
    && isSafeMetadataMap(metadata)
    && (value['error'] === undefined || value['error'] === null || value['error'] === '' || value['error'] === 'TRACE_ERROR');
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

function isSafeMetadataMap(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (!SAFE_REMOTE_METADATA_KEYS.has(key)) return false;
    if (key === 'eventType') return typeof item === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(item);
    if (['agentRunId', 'sessionId', 'replyId', 'streamId', 'spanKey', 'parentSpanKey', 'correlationId',
      'causationId', 'attemptId', 'toolCallId', 'stepId', 'profile', 'purpose', 'provider', 'model',
      'source', 'status', 'outcome', 'stage', 'subagentType', 'toolName', 'finishReason', 'code',
      'category', 'reasonCode', 'terminalStatus', 'usageCompleteness', 'ls_provider', 'ls_model_name'].includes(key)) {
      return isSafeIdentifier(item);
    }
    if (['attempt', 'durationMs', 'ttftMs', 'retryCount', 'inputTokens', 'outputTokens'].includes(key)) return isSafeToken(item);
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
