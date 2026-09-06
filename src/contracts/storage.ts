import type { AgentContext } from './context.js';
import type { ToolCall, ToolExecutionResult } from './tool.js';

export interface CheckpointStore {
  load(runId: string): Promise<AgentContext | null>;
  save(context: AgentContext): Promise<void>;
  hasExecuted(call: ToolCall): Promise<boolean>;
  recordExecuted(call: ToolCall, result: ToolExecutionResult): Promise<void>;
}

export interface EvidenceRecord {
  evidenceId: string;
  runId: string;
  source: 'metric' | 'log' | 'trace' | 'change';
  summary: Record<string, unknown>;
  raw: unknown;
  businessTraceIds: string[];
  capturedAt: string;
}

export interface EvidenceStore {
  save(record: EvidenceRecord): Promise<void>;
  get(evidenceId: string): Promise<EvidenceRecord | null>;
}
