import type { GovernanceEffect, ResolvedRisk, SerializableInterrupt, ToolExecutionRecord, ToolExecutionResult } from '../contracts/index.js';

export type ExecutionOutcome =
  | {
      type: 'completed';
      result: ToolExecutionResult;
      risk: ResolvedRisk;
      execution?: ToolExecutionRecord;
      effects?: readonly GovernanceEffect[];
      observerFailures?: readonly string[];
    }
  | {
      type: 'interrupted';
      result: ToolExecutionResult;
      risk: ResolvedRisk;
      interrupt: SerializableInterrupt;
      effects?: readonly GovernanceEffect[];
      observerFailures?: readonly string[];
    };
