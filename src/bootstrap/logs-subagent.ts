import { z } from 'zod';
import type {
  CheckpointStore,
  Clock,
  SourceSubagentDescriptor,
  SourceSubagentRequest,
  SubagentLifecyclePorts,
  Tool,
  ToolCallReturn,
  ToolCallOptions,
  ToolResponse,
  ToolResponseChunk,
} from '../contracts/index.js';
import { attachSourceEvidenceObservation } from '../application/source-evidence-observation.js';
import type { SourceReportCollector } from '../application/source-report-collector.js';
import {
  createLogEvidenceTools,
  type LogEvidencePageSource,
  type LogEvidenceToolOptions,
} from './log-evidence-tools.js';
import {
  DefaultSourceSubagentRunner,
  type SourceChildAgentFactory,
  type SourceChildToolsFactory,
} from '../application/source-subagent-runner.js';
import { createSourceSubagentTool } from '../tool/adapters/source-subagent-tool-adapter.js';
import { createSourceReportTool } from './source-report-tool.js';
import { stableSourceChildRunId } from './source-subagent-identity.js';

export const logsSubagentInputSchema = z.object({
  profileId: z.string().min(1),
  service: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  question: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).optional(),
}).strict();

export interface LogsSubagentOptions extends Omit<LogEvidenceToolOptions, 'maxModelBytes'> {
  childAgentFactory: SourceChildAgentFactory;
  checkpoints?: CheckpointStore;
  clock?: Clock;
  sourceWindow?: { start: string; end: string };
  lifecycle?: SubagentLifecyclePorts;
  maxAttempts?: number;
  validateRequest?: SourceSubagentDescriptor['validateRequest'];
  collector?: (input: { request: SourceSubagentRequest }) => SourceReportCollector;
}

/**
 * Compose the concrete logs source without leaking its child-only Tools into the
 * parent registry. The child factory remains injected so bootstrap can choose the
 * same model, checkpoint and event ports as the host runtime.
 */
export function createLogsSubagentTool(options: LogsSubagentOptions): Tool {
  const childOnlyTools = createLogEvidenceTools(options);
  const childTools: SourceChildToolsFactory = {
    create: ({ request, collector }) => {
      const scopedTools = options.collector === undefined ? childOnlyTools : childOnlyTools.map((tool) =>
        tool.name === 'logs.capture' ? bindCaptureObservation(tool, request, options.sourceWindow) : tool);
      return Object.freeze([...scopedTools, createSourceReportTool(collector)]);
    },
  };
  const runner = new DefaultSourceSubagentRunner({
    source: 'logs',
    childAgentFactory: options.childAgentFactory,
    childTools,
    ...(options.checkpoints === undefined ? {} : { checkpoints: options.checkpoints }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.collector === undefined ? {} : { collector: options.collector }),
    renderPrompt: renderLogsPrompt,
  });
  const descriptor: SourceSubagentDescriptor = {
    publicToolName: 'logs_subagent',
    subagentType: 'logs',
    description: '调查指定服务和时间窗口内的日志证据，返回可回查的结构化来源报告。',
    inputSchema: logsSubagentInputSchema,
    runner,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
    childRunId: (execution) => stableSourceChildRunId('logs', execution.parentRunId, execution.parentToolCallId),
    ...(options.validateRequest === undefined ? {} : { validateRequest: options.validateRequest }),
    validateEvidenceIds: async (evidenceIds, input) => {
      for (const evidenceId of evidenceIds) {
        const visible = await options.manifests.getVisible(evidenceId);
        if (visible === null || visible.source !== 'log' || visible.runId !== input.parentRunId) {
          throw new SourceScopeError('Parent evidence is not visible in the current Run.');
        }
      }
    },
  };
  return createSourceSubagentTool(descriptor);
}

function bindCaptureObservation(
  tool: Tool,
  request: SourceSubagentRequest,
  sourceWindow?: { start: string; end: string },
): Tool {
  if (tool.call === undefined) return tool;
  const invoke = tool.call;
  return Object.freeze({
    ...tool,
    call: (input: Record<string, unknown>, callOptions: ToolCallOptions) => {
      if (input.service !== request.service) throw new SourceScopeError('Log capture service is outside the parent request.');
      if (sourceWindow !== undefined && (input.start !== sourceWindow.start || input.end !== sourceWindow.end
        || request.start !== sourceWindow.start || request.end !== sourceWindow.end)) {
        throw new SourceScopeError('Log capture window is outside the immutable source snapshot.');
      }
      return mapToolResult(invoke(input, callOptions), (response) => attachCaptureObservation(response, input));
    },
  });
}

function mapToolResult(value: ToolCallReturn, transform: (response: ToolResponse) => ToolResponse): ToolCallReturn {
  if (isAsyncGenerator(value)) return mapToolGenerator(value, transform);
  if (isPromiseLike(value)) return value.then(transform);
  return transform(value);
}

async function* mapToolGenerator(
  stream: AsyncGenerator<ToolResponseChunk, ToolResponse>,
  transform: (response: ToolResponse) => ToolResponse,
): AsyncGenerator<ToolResponseChunk, ToolResponse> {
  return transform(yield* stream);
}

function attachCaptureObservation(response: ToolResponse, input: Record<string, unknown>): ToolResponse {
  if (response.isError === true || response.metadata?.sourceEvidence !== undefined) return response;
  const jsonBlocks = response.blocks.filter((block) => block.type === 'json');
  if (jsonBlocks.length !== 1 || jsonBlocks[0]?.type !== 'json' || !isRecord(jsonBlocks[0].value)) return response;
  const value = jsonBlocks[0].value;
  if (typeof value.evidenceId !== 'string' || (value.status !== 'committed' && value.status !== 'partial')
    || typeof value.coverage !== 'number' || !Number.isFinite(value.coverage)
    || !Array.isArray(value.missingEvidence) || typeof input.start !== 'string' || typeof input.end !== 'string') return response;
  try {
    return attachSourceEvidenceObservation(response, {
      schemaVersion: 1,
      source: 'logs',
      evidenceId: value.evidenceId,
      state: value.status,
      coverage: value.coverage,
      timeRange: { start: input.start, end: input.end },
      missingEvidence: value.missingEvidence as string[],
    });
  } catch {
    return response;
  }
}

function isAsyncGenerator(value: ToolCallReturn): value is AsyncGenerator<ToolResponseChunk, ToolResponse> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function isPromiseLike(value: ToolCallReturn): value is Promise<ToolResponse> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderLogsPrompt(request: {
  profileId: string;
  service: string;
  start: string;
  end: string;
  question: string;
  evidenceIds: readonly string[];
}): string {
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

class SourceScopeError extends Error {
  public readonly code = 'POLICY_DENIED';
  public readonly retryable = false;

  public constructor(message: string) {
    super(message);
    this.name = 'SourceScopeError';
  }
}

export type { LogEvidencePageSource };
