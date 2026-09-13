import type { AgentContext, ToolExecutionResult } from '../contracts/index.js';

export interface CompressionDecision {
  level: 'none' | 'L0' | 'L1' | 'L2';
  reason: string;
}

export interface CompressionResult {
  context: AgentContext;
  decision: CompressionDecision;
}

export interface ContextCompressor {
  compress(context: AgentContext): Promise<CompressionResult>;
  pruneToolResult(result: ToolExecutionResult): Promise<ToolExecutionResult>;
}

export interface ToolResultCompactionDecision {
  level: 'none' | 'L0';
  originalBytes: number;
  modelBytes: number;
}

export interface ToolResultCompaction {
  result: ToolExecutionResult;
  decision: ToolResultCompactionDecision;
}

export interface ToolResultCompactor {
  compact(
    result: ToolExecutionResult,
    options?: { maxBytes?: number },
  ): ToolResultCompaction;
}
