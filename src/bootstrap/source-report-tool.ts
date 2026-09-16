import { z } from 'zod';
import type { Tool, ToolResponse } from '../contracts/index.js';
import type { SourceReportCandidate, SourceReportCollector } from '../application/source-report-collector.js';

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
