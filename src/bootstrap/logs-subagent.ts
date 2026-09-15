import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  CheckpointStore,
  Clock,
  SourceSubagentDescriptor,
  SubagentLifecyclePorts,
  Tool,
  ToolResponse,
} from '../contracts/index.js';
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
import type { SourceReportCandidate, SourceReportCollector } from '../application/source-report-collector.js';

export const logsSubagentInputSchema = z.object({
  profileId: z.string().min(1),
  service: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  question: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).optional(),
}).strict();

const sourceReportInputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(z.object({
    kind: z.enum(['observation', 'inference']),
    statement: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)),
  }).strict()),
  businessTraceIds: z.array(z.string().min(1)),
  missingEvidence: z.array(z.string().min(1)),
}).strict();

export interface LogsSubagentOptions extends Omit<LogEvidenceToolOptions, 'maxModelBytes'> {
  childAgentFactory: SourceChildAgentFactory;
  checkpoints?: CheckpointStore;
  clock?: Clock;
  lifecycle?: SubagentLifecyclePorts;
  maxAttempts?: number;
}

/**
 * Compose the concrete logs source without leaking its child-only Tools into the
 * parent registry. The child factory remains injected so bootstrap can choose the
 * same model, checkpoint and event ports as the host runtime.
 */
export function createLogsSubagentTool(options: LogsSubagentOptions): Tool {
  const childOnlyTools = createLogEvidenceTools(options);
  const childTools: SourceChildToolsFactory = {
    create: ({ collector }) => Object.freeze([
      ...childOnlyTools,
      createSourceReportTool(collector),
    ]),
  };
  const runner = new DefaultSourceSubagentRunner({
    source: 'logs',
    childAgentFactory: options.childAgentFactory,
    childTools,
    ...(options.checkpoints === undefined ? {} : { checkpoints: options.checkpoints }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const descriptor: SourceSubagentDescriptor = {
    publicToolName: 'logs_subagent',
    subagentType: 'logs',
    description: '调查指定服务和时间窗口内的日志证据，返回可回查的结构化来源报告。',
    inputSchema: logsSubagentInputSchema,
    runner,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
    childRunId: (execution) => stableChildRunId(execution.parentRunId, execution.parentToolCallId),
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

export function createSourceReportTool(collector: SourceReportCollector): Tool {
  return {
    name: 'source_report',
    description: '提交已脱敏且引用可验证的来源调查报告。',
    kind: 'utility',
    source: 'builtin',
    inputSchema: sourceReportInputSchema,
    recoveryPolicy: 'replay_safe',
    isConcurrencySafe: () => false,
    userFacingLabel: () => '提交来源报告',
    call: (input): ToolResponse => {
      const parsed = sourceReportInputSchema.parse(input);
      collector.acceptReport(parsed satisfies SourceReportCandidate);
      return { blocks: [{ type: 'json', value: { accepted: true } }] };
    },
  };
}

function stableChildRunId(parentRunId: string, parentToolCallId: string): string {
  const digest = createHash('sha256')
    .update(`logs\u0000${parentRunId}\u0000${parentToolCallId}`)
    .digest('hex')
    .slice(0, 32);
  return `source-child-logs-${digest}`;
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
