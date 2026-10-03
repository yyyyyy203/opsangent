import { z } from 'zod';
import type {
  CheckpointStore,
  Clock,
  SourceSubagentDescriptor,
  SourceSubagentExecution,
  SourceSubagentRequest,
  SubagentLifecyclePorts,
  Tool,
} from '../contracts/index.js';
import {
  DefaultSourceSubagentRunner,
  SourceSubagentFailure,
  type SourceChildAgentFactory,
  type SourceChildToolsFactory,
} from '../application/source-subagent-runner.js';
import { MetricsSourceReportCollector } from '../application/metrics-source-report-collector.js';
import { createSourceSubagentTool } from '../tool/adapters/source-subagent-tool-adapter.js';
import type { SettlementMetricsProfile } from '../profiles/settlement.js';
import { createSourceReportTool } from './source-report-tool.js';
import { stableSourceChildRunId } from './source-subagent-identity.js';

const MAX_QUESTION_BYTES = 2 * 1024;
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export const metricsSubagentInputSchema = z.object({
  profileId: z.string().min(1),
  service: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  question: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).max(20).optional(),
}).strict();

export interface MetricsSubagentOptions {
  profile: SettlementMetricsProfile;
  settlementTool: Tool;
  childAgentFactory: SourceChildAgentFactory;
  checkpoints?: CheckpointStore;
  clock?: Clock;
  lifecycle?: SubagentLifecyclePorts;
  maxAttempts?: number;
}

export function createMetricsSubagentTool(options: MetricsSubagentOptions): Tool {
  assertSettlementTool(options.settlementTool);
  const clock = options.clock ?? { now: () => new Date() };
  const childTools: SourceChildToolsFactory = {
    create: ({ collector }) => Object.freeze([
      options.settlementTool,
      createSourceReportTool(collector),
    ]),
  };
  const runner = new DefaultSourceSubagentRunner({
    source: 'metrics',
    childAgentFactory: options.childAgentFactory,
    childTools,
    collector: ({ request }) => new MetricsSourceReportCollector({ request, profile: options.profile }),
    renderPrompt: renderMetricsPrompt,
    clock,
    ...(options.checkpoints === undefined ? {} : { checkpoints: options.checkpoints }),
  });
  const descriptor: SourceSubagentDescriptor = {
    publicToolName: 'metrics_subagent',
    subagentType: 'metrics',
    description: '调查 checkout 结算指标，返回可回查的确定性来源报告。',
    inputSchema: metricsSubagentInputSchema,
    runner,
    childRunId: (execution) => stableSourceChildRunId('metrics', execution.parentRunId, execution.parentToolCallId),
    validateRequest: (request, execution) => validateMetricsRequest(request, execution, options.profile, clock),
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  };
  return createSourceSubagentTool(descriptor);
}

function assertSettlementTool(tool: Tool): void {
  if (tool.name !== 'metrics.settlement' || tool.kind !== 'evidence'
    || tool.source !== 'mcp' || tool.call === undefined) {
    throw new Error('Metrics child requires the pre-bound readonly metrics.settlement MCP Tool.');
  }
  const schema = tool.inputSchema;
  if (!(schema instanceof z.ZodObject) || Object.keys(schema.shape).length !== 1
    || !Object.prototype.hasOwnProperty.call(schema.shape, 'service')
    || !(schema.shape.service instanceof z.ZodLiteral)
    || schema.shape.service.value !== 'checkout'
    || !schema.safeParse({ service: 'checkout' }).success
    || schema.safeParse({ service: 'payments' }).success
    || schema.safeParse({ service: 'checkout', url: 'https://invalid.example' }).success) {
    throw new Error('metrics.settlement must accept only service=checkout.');
  }
}

function validateMetricsRequest(
  request: SourceSubagentRequest,
  execution: Omit<SourceSubagentExecution, 'childRunId'>,
  profile: SettlementMetricsProfile,
  clock: Clock,
): void {
  if (request.profileId !== profile.profileId || request.service !== profile.service) {
    throw new SourceSubagentFailure('POLICY_DENIED', 'Metrics request is outside the configured Profile.', false);
  }
  if (request.evidenceIds.length > 0) {
    throw new SourceSubagentFailure('POLICY_DENIED', 'Metrics does not accept previous evidence hints.', false);
  }
  if (execution.remainingToolCalls === undefined || execution.remainingToolCalls < 2
    || (execution.toolCallBudget !== undefined && execution.toolCallBudget.remaining < 2)) {
    throw new SourceSubagentFailure('BUDGET_EXCEEDED', 'Metrics child requires two remaining Tool calls.', false);
  }
  if (request.question.trim().length === 0 || Buffer.byteLength(request.question, 'utf8') > MAX_QUESTION_BYTES
    || !isStrictIsoWithZone(request.start) || !isStrictIsoWithZone(request.end)) {
    throw new SourceSubagentFailure('INVALID_INPUT', 'Metrics request question or timestamps are invalid.', false);
  }
  const start = Date.parse(request.start);
  const end = Date.parse(request.end);
  const now = clock.now().getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now)
    || end - start !== profile.windowSeconds * 1_000
    || end < now - profile.maxWindowSkewSeconds * 1_000
    || end > now + profile.maxFutureSkewSeconds * 1_000) {
    throw new SourceSubagentFailure('INVALID_INPUT', 'Metrics request must select the latest 300-second window.', false);
  }
}

function isStrictIsoWithZone(value: string): boolean {
  const match = ISO_WITH_ZONE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (day > daysInMonth(year, month)) return false;
  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function renderMetricsPrompt(request: SourceSubagentRequest): string {
  return [
    '你是只读 Metrics 取证 Subagent。',
    '只能调用提供的指标查询工具和 source_report。',
    '失败率、阈值、样本充分性由工具结果决定；不要自行计算或猜测根因。',
    '低样本必须视为 insufficient_data。',
    `profileId=${JSON.stringify(request.profileId)}`,
    `service=${JSON.stringify(request.service)}`,
    `start=${JSON.stringify(request.start)}`,
    `end=${JSON.stringify(request.end)}`,
    `question=${JSON.stringify(request.question)}`,
    '最后调用 source_report，并只引用本次实际观察到的 evidenceId。',
  ].join('\n');
}
