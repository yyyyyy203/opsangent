import type { z } from 'zod';
import type { AgentError } from './errors.js';

export type ToolKind = 'evidence' | 'action' | 'utility';
export type ToolSource = 'builtin' | 'mcp' | 'skill' | 'subagent' | 'external';
export type ToolRecoveryPolicy = 'replay_safe' | 'verify_before_retry' | 'never_replay';
export type ToolExecutionStatus =
  | 'success'
  | 'failed'
  | 'timeout'
  | 'aborted'
  | 'interrupted'
  | 'awaiting_external'
  | 'skipped';
export type RiskSeverity = 'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ValidationResult {
  valid: boolean;
  value?: Record<string, unknown>;
  error?: AgentError;
}

export interface ToolInputSchema {
  jsonSchema: Record<string, unknown>;
  validate(input: Record<string, unknown>): ValidationResult;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Complete model arguments before parsing; never represented by an empty input fallback. */
export interface RawToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type SemanticValidation =
  | { valid: true; value: Record<string, unknown> }
  | { valid: false; error: AgentError };

export interface ToolCallOptions {
  /** Stable identity supplied by the pipeline; optional for existing third-party Tool implementations. */
  toolCallId?: string;
  runId: string;
  stepId: string;
  sessionId?: string;
  replyId?: string;
  streamId?: string;
  /** Immutable host scope captured from the parent AgentContext. */
  profileId?: string;
  profileRevision?: string;
  signal: AbortSignal;
  mode: 'dry_run' | 'execute';
  deadline?: number;
  /** Shared ledger used when a Tool delegates work to a child Harness. */
  toolCallBudget?: { remaining: number };
  networkAttemptBudget?: { remaining: number };
  /** Remaining parent Tool-call budget available to a delegated source Run. */
  remainingToolCalls?: number;
}

export type ToolResponseBlock =
  | { type: 'text'; text: string }
  | { type: 'json'; value: unknown }
  | { type: 'evidence_ref'; evidenceId: string }
  | { type: 'artifact'; uri: string; mediaType?: string };

export interface ToolResponse {
  blocks: ToolResponseBlock[];
  evidenceIds?: string[];
  metadata?: Record<string, unknown>;
  isError?: boolean;
}

export type ToolResponseChunk =
  | { type: 'progress'; message: string; percent?: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'event'; name: string; payload: Record<string, unknown> };

export type ToolCallReturn =
  | ToolResponse
  | Promise<ToolResponse>
  | AsyncGenerator<ToolResponseChunk, ToolResponse>;

/**
 * Unified capability contract for MCP, Skill, Bash, Subagent, builtin and action tools.
 * Missing `call` means the host/endpoint must execute the tool and return a ToolResponse.
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
  /** Execution origin used by governance and presentation; omitted only for legacy adapters. */
  readonly source?: ToolSource;
  readonly inputSchema: z.ZodObject<z.ZodRawShape> | ToolInputSchema;
  readonly call?: (input: Record<string, unknown>, options: ToolCallOptions) => ToolCallReturn;
  readonly requireUserConfirm?: boolean;
  readonly trustedWhenInWorkspace?: boolean;
  readonly userFacingLabel?: (input: Record<string, unknown>) => string;
  readonly isConcurrencySafe?: (input: Record<string, unknown>) => boolean;
  /** Restart behavior is separate from same-batch concurrency behavior. */
  readonly recoveryPolicy?: ToolRecoveryPolicy;
  readonly validateSemantics?: (input: Record<string, unknown>) => SemanticValidation;
}

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  status: ToolExecutionStatus;
  response?: ToolResponse;
  error?: AgentError;
  startedAt: string;
  finishedAt?: string;
}

export function isToolInputSchema(schema: Tool['inputSchema']): schema is ToolInputSchema {
  return 'jsonSchema' in schema && 'validate' in schema;
}

export function successfulToolResponse(value: unknown): ToolResponse {
  return { blocks: [{ type: 'json', value }] };
}
