import { z } from 'zod';
import type {
  CheckpointStore,
  Clock,
  SourceSubagentDescriptor,
  SubagentLifecyclePorts,
  Tool,
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
