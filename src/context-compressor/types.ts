import type {
  AgentContext,
  CompressionTrace,
  CompressionValidationResult,
  EvidenceManifestStore,
  EvidenceStore,
  HistorySummaryInput,
  StructuredHistorySummary,
  ToolExecutionResult,
} from '../contracts/index.js';

export interface CompressionDecision {
  level: 'none' | 'L0' | 'L1' | 'L2';
  reason: string;
}

export interface CompressionResult {
  context: AgentContext;
  decision: CompressionDecision;
  trace?: CompressionTrace;
  validation?: CompressionValidationResult;
}

export interface ContextCompressor {
  compress(context: AgentContext, options?: CompressionOptions): Promise<CompressionResult>;
  pruneToolResult(result: ToolExecutionResult): Promise<ToolExecutionResult>;
}

export interface CompressionOptions {
  signal: AbortSignal;
  deadline: number;
  now: () => Date;
}

export interface HistorySummarizer {
  summarize(
    input: HistorySummaryInput,
    options: { signal: AbortSignal; deadline: number },
  ): Promise<StructuredHistorySummary>;
}

export interface CompressionValidationInput {
  before: AgentContext;
  candidate: AgentContext;
  sourceMessageIds: readonly string[];
  maxMessages: number;
  maxBytes: number;
}

export interface CompressionValidator {
  validate(input: CompressionValidationInput): Promise<CompressionValidationResult>;
}

export interface CompressionValidatorOptions {
  evidence?: EvidenceStore;
  evidenceManifests?: EvidenceManifestStore;
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
