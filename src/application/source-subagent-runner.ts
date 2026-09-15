import type { AgentEvent, Tool, ToolResponse } from '../contracts/index.js';
import type { AgentContext } from '../contracts/context.js';
import type { DiagnosisRunResult } from '../agent/types.js';
import type {
  Clock,
  CheckpointStore,
  SourceSubagentExecution,
  SourceSubagentRequest,
  SourceSubagentResult,
  SourceSubagentRunner,
  SourceSubagentType,
  ToolResponseChunk,
} from '../contracts/index.js';
import { DefaultSourceReportCollector, type SourceReportCandidate, type SourceReportCollector } from './source-report-collector.js';

export type { AgentContext } from '../contracts/context.js';
export type { DiagnosisRunResult } from '../agent/types.js';
export type {
  AgentEvent,
  SourceSubagentExecution,
  SourceSubagentRequest,
  Tool,
  ToolResponse,
} from '../contracts/index.js';

export interface SourceChildAgent {
  replyStream(options: {
    runId: string;
    profileId: string;
    message: string;
    sessionId?: string;
    replyId?: string;
    signal: AbortSignal;
    toolCallBudget?: { remaining: number };
    maxToolCalls: number;
    maxDurationMs: number;
    networkAttemptBudget?: { remaining: number };
  }): AsyncGenerator<AgentEvent, DiagnosisRunResult>;
  resumeStream(runId: string, signal?: AbortSignal, toolCallBudget?: { remaining: number }): AsyncGenerator<AgentEvent, DiagnosisRunResult>;
}

export interface SourceChildAgentFactory {
  create(input: {
    childRunId: string;
    source: SourceSubagentType;
    tools: readonly Tool[];
    maxToolCalls: number;
    maxDurationMs: number;
    profileId: string;
    profileRevision?: string;
    toolCallBudget?: { remaining: number };
    networkAttemptBudget?: { remaining: number };
  }): SourceChildAgent;
}

export interface SourceChildToolsFactory {
  create(input: {
    request: SourceSubagentRequest;
    execution: SourceSubagentExecution;
    collector: SourceReportCollector;
  }): readonly Tool[];
}

export interface SourceSubagentRunnerOptions {
  source: SourceSubagentType;
  childAgentFactory: SourceChildAgentFactory;
  childTools: SourceChildToolsFactory;
  checkpoints?: CheckpointStore;
  clock?: Clock;
  collector?: () => SourceReportCollector;
}

export class DefaultSourceSubagentRunner implements SourceSubagentRunner {
  private readonly clock: Clock;

  public constructor(private readonly options: SourceSubagentRunnerOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
  }

  public async *run(
    request: SourceSubagentRequest,
    execution: SourceSubagentExecution,
  ): AsyncGenerator<ToolResponseChunk, SourceSubagentResult> {
    yield* [] as ToolResponseChunk[];
    const startedAt = this.clock.now().getTime();
    throwIfAborted(execution.signal);
    const ledgerRemaining = execution.toolCallBudget?.remaining;
    const remainingToolCalls = Math.min(execution.remainingToolCalls ?? 8, ledgerRemaining ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(remainingToolCalls) || remainingToolCalls <= 0) {
      throw new SourceSubagentFailure('BUDGET_EXCEEDED', 'Parent Tool-call budget is exhausted.', false);
    }
    const parentRemainingMs = execution.deadline === undefined
      ? 30_000
      : Math.max(0, execution.deadline - startedAt);
    if (parentRemainingMs <= 0) throw new SourceSubagentFailure('TIMEOUT', 'Parent deadline has elapsed.', true);
    const maxToolCalls = Math.min(8, remainingToolCalls);
    const maxDurationMs = Math.min(30_000, parentRemainingMs);
    const existingCheckpoint = await this.options.checkpoints?.load(execution.childRunId);
    const checkpointEvidenceIds = existingCheckpoint?.evidenceIds ?? [];
    const collector = this.options.collector?.() ?? new DefaultSourceReportCollector({
      knownEvidenceIds: [...new Set([...request.evidenceIds, ...checkpointEvidenceIds])],
    });
    if (existingCheckpoint !== null && existingCheckpoint !== undefined) restoreCheckpoint(existingCheckpoint, collector);
    const finalize = (): SourceSubagentResult => collector.finalize({
      source: this.options.source,
      startedAt,
      finishedAt: this.clock.now().getTime(),
      parentRunId: execution.parentRunId,
      childRunId: execution.childRunId,
    });
    if (existingCheckpoint?.status === 'completed') {
      return finalize();
    }
    const childTools = this.options.childTools.create({ request, execution, collector });
    assertChildTools(childTools, this.options.source);
    const child = this.options.childAgentFactory.create({
      childRunId: execution.childRunId,
      source: this.options.source,
      tools: Object.freeze([...childTools]),
      maxToolCalls,
      maxDurationMs,
      profileId: execution.profileId,
      ...(execution.profileRevision === undefined ? {} : { profileRevision: execution.profileRevision }),
      ...(execution.toolCallBudget === undefined ? {} : { toolCallBudget: execution.toolCallBudget }),
      ...(execution.networkAttemptBudget === undefined ? {} : { networkAttemptBudget: execution.networkAttemptBudget }),
    });
    const prompt = renderSourcePrompt(request);
    const childStream = existingCheckpoint === null || existingCheckpoint === undefined
      ? child.replyStream({
        runId: execution.childRunId,
        profileId: execution.profileId,
        message: prompt,
        ...(execution.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
        ...(execution.replyId === undefined ? {} : { replyId: execution.replyId }),
        signal: execution.signal,
        maxToolCalls,
        maxDurationMs,
        ...(execution.toolCallBudget === undefined ? {} : { toolCallBudget: execution.toolCallBudget }),
        ...(execution.networkAttemptBudget === undefined ? {} : { networkAttemptBudget: execution.networkAttemptBudget }),
      })
      : child.resumeStream(execution.childRunId, execution.signal, execution.toolCallBudget);
    let childResult: DiagnosisRunResult;
    try {
      childResult = await consumeChildStream(childStream, collector, execution.signal);
    } catch (error) {
      if (error instanceof SourceSubagentFailure) throw error;
      const partial = reducedScope(finalize(), 'child_run_failed');
      if (partial.evidenceIds.length > 0) {
        throw new SourceSubagentFailure('MCP_SERVER_ERROR', 'Child source run failed.', true, partial);
      }
      throw new SourceSubagentFailure('MCP_SERVER_ERROR', 'Child source run failed.', true);
    }
    if (childResult.status === 'failed' || childResult.status === 'cancelled') {
      const partial = reducedScope(finalize(), childResult.status === 'cancelled' ? 'child_run_cancelled' : 'child_run_failed');
      if (partial.evidenceIds.length > 0) {
        throw new SourceSubagentFailure('MCP_SERVER_ERROR', 'Child source run failed.', true, partial);
      }
      throw new SourceSubagentFailure('MCP_SERVER_ERROR', 'Child source run failed.', true);
    }
    if (childResult.status === 'paused' || childResult.status === 'awaiting_confirmation') {
      const partial = reducedScope(finalize(), 'child_run_interrupted');
      if (partial.evidenceIds.length > 0) {
        throw new SourceSubagentFailure('BUDGET_EXCEEDED', 'Child source run did not reach a terminal report.', false, partial);
      }
      throw new SourceSubagentFailure('BUDGET_EXCEEDED', 'Child source run did not reach a terminal report.', false);
    }
    return finalize();
  }
}

export class SourceSubagentFailure extends Error {
  public constructor(
    public readonly code: SourceSubagentFailureCode,
    message: string,
    public readonly retryable: boolean,
    public readonly partialResult?: SourceSubagentResult,
  ) {
    super(message);
    this.name = 'SourceSubagentFailure';
  }
}

async function consumeChildStream(
  stream: AsyncGenerator<AgentEvent, DiagnosisRunResult>,
  collector: SourceReportCollector,
  signal: AbortSignal,
): Promise<DiagnosisRunResult> {
  let completed = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const item = await stream.next();
      if (item.done) {
        completed = true;
        return item.value;
      }
      if (item.value.type !== 'TOOL_RESULT') continue;
      const payload = item.value.payload;
      if (!isToolExecutionResult(payload) || payload.response === undefined) continue;
      collector.observeToolResult(payload.toolName, payload.response);
      if (payload.toolName === 'source_report') observeReportResponse(collector, payload.response);
    }
  } finally {
    if (!completed) await stream.return(undefined as never).catch(() => undefined);
  }
}

function isToolExecutionResult(value: unknown): value is { toolName: string; response?: ToolResponse; status: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { toolName?: unknown; response?: unknown; status?: unknown };
  return typeof candidate.toolName === 'string' && typeof candidate.status === 'string'
    && (candidate.response === undefined || isToolResponse(candidate.response));
}

function isToolResponse(value: unknown): value is ToolResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { blocks?: unknown };
  return Array.isArray(candidate.blocks);
}

function observeReportResponse(collector: SourceReportCollector, response: ToolResponse): void {
  const block = response.blocks.find((candidate) => candidate.type === 'json');
  if (block?.type !== 'json' || !isRecord(block.value)) return;
  if (typeof block.value.summary !== 'string' || !Array.isArray(block.value.findings)
    || !Array.isArray(block.value.businessTraceIds) || !Array.isArray(block.value.missingEvidence)) return;
  collector.acceptReport(block.value as unknown as SourceReportCandidate);
}

function restoreCheckpoint(
  context: AgentContext,
  collector: SourceReportCollector,
): void {
  for (const message of context.messages ?? []) {
    for (const block of message.blocks) {
      if (block.type === 'tool_call' && block.call.name === 'source_report') {
        const input = block.call.input;
        if (isRecord(input) && typeof input.summary === 'string' && Array.isArray(input.findings)
          && Array.isArray(input.businessTraceIds) && Array.isArray(input.missingEvidence)) {
          collector.acceptReport(input as unknown as SourceReportCandidate);
        }
      }
      if (block.type === 'tool_result' && block.result.response !== undefined) {
        collector.observeToolResult(block.result.toolName, block.result.response);
        if (block.result.toolName === 'source_report') observeReportResponse(collector, block.result.response);
      }
    }
  }
}

function reducedScope(result: SourceSubagentResult, reason: string): SourceSubagentResult {
  return {
    ...result,
    status: 'partial',
    missingEvidence: [...new Set([...result.missingEvidence, reason])].slice(0, 20),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderSourcePrompt(request: SourceSubagentRequest): string {
  return [
    '你是只读日志取证 Subagent，只能使用宿主提供的日志证据工具。',
    `profileId=${request.profileId}`,
    `service=${request.service}`,
    `start=${request.start}`,
    `end=${request.end}`,
    `question=${request.question}`,
    `knownEvidenceIds=${JSON.stringify(request.evidenceIds)}`,
    '请先采集或检索证据，最后调用 source_report；不要输出查询 DSL、路径、凭据或原始日志。',
  ].join('\n');
}

function assertChildTools(tools: readonly Tool[], source: SourceSubagentType): void {
  const names = new Set<string>();
  let reportCount = 0;
  for (const tool of tools) {
    if (names.has(tool.name)) throw new SourceSubagentFailure('POLICY_DENIED', `Duplicate child Tool: ${tool.name}`, false);
    names.add(tool.name);
    if (tool.name === 'source_report') reportCount += 1;
    const isSourceTool = tool.name.startsWith(`${source}.`);
    if ((!isSourceTool && tool.name !== 'source_report') || tool.kind === 'action' || tool.call === undefined
      || /(^|[._-])bash($|[._-])/i.test(tool.name) || tool.name.endsWith('_subagent')
      || (tool.name === 'source_report' && tool.kind !== 'utility')) {
      throw new SourceSubagentFailure('POLICY_DENIED', `Forbidden child Tool: ${tool.name}`, false);
    }
  }
  if (reportCount !== 1) throw new SourceSubagentFailure('POLICY_DENIED', 'Child Toolkit must contain exactly one source_report Tool.', false);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SourceSubagentFailure('ABORTED', 'Source subagent was aborted.', false);
}

export type SourceSubagentFailureCode =
  | 'ABORTED'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_INPUT'
  | 'MCP_SERVER_ERROR'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'POLICY_DENIED'
  | 'MCP_TIMEOUT'
  | 'MCP_NETWORK_ERROR'
  | 'MCP_RATE_LIMITED'
  | 'MCP_PROTOCOL_ERROR';
