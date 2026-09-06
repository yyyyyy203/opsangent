export type AgentErrorCode =
  | 'ABORTED'
  | 'BUDGET_EXCEEDED'
  | 'CONFIRMATION_EXPIRED'
  | 'INVALID_INPUT'
  | 'LOOP_DETECTED'
  | 'MODEL_ERROR'
  | 'STORAGE_ERROR'
  | 'TOOL_ERROR'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_ARGUMENTS_PARSE_FAILED'
  | 'TOOL_ARGUMENTS_SCHEMA_INVALID'
  | 'TOOL_ARGUMENTS_SEMANTIC_INVALID'
  | 'POLICY_DENIED'
  | 'USER_REJECTED';

export interface AgentError {
  code: AgentErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export function toAgentError(
  error: unknown,
  fallbackCode: AgentErrorCode = 'TOOL_ERROR',
): AgentError {
  if (isAgentError(error)) return error;
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

export function isAgentError(value: unknown): value is AgentError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AgentError>;
  return typeof candidate.code === 'string'
    && typeof candidate.message === 'string'
    && typeof candidate.retryable === 'boolean';
}
