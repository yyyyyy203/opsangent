import type { ResolvedRisk, SerializableInterrupt, ToolExecutionResult } from '../contracts/index.js';

export type ExecutionOutcome =
  | { type: 'completed'; result: ToolExecutionResult; risk: ResolvedRisk }
  | { type: 'interrupted'; result: ToolExecutionResult; risk: ResolvedRisk; interrupt: SerializableInterrupt };
