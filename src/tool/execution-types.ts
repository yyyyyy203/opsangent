import type { ResolvedRisk, SerializableInterrupt, ToolExecutionRecord, ToolExecutionResult } from '../contracts/index.js';

export type ExecutionOutcome =
  | { type: 'completed'; result: ToolExecutionResult; risk: ResolvedRisk; execution?: ToolExecutionRecord }
  | { type: 'interrupted'; result: ToolExecutionResult; risk: ResolvedRisk; interrupt: SerializableInterrupt };
