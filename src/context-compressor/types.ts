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
