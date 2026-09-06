import type { AgentError } from '../contracts/errors.js';

export type ModelFailureCategory =
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'protocol'
  | 'aborted'
  | 'context_length'
  | 'output_truncated';

type ModelFailurePhase = 'connect' | 'first_byte' | 'idle' | 'overall' | 'run_deadline';

const MODEL_FAILURE_PHASES: ReadonlySet<string> = new Set<ModelFailurePhase>([
  'connect',
  'first_byte',
  'idle',
  'overall',
  'run_deadline',
]);

export class ModelFailure extends Error implements AgentError {
  public readonly code = 'MODEL_ERROR' as const;
  public readonly details: Record<string, unknown>;

  public constructor(
    category: ModelFailureCategory,
    message: string,
    public readonly retryable: boolean,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ModelFailure';
    this.details = sanitizeDetails(category, details);
  }
}

function sanitizeDetails(
  category: ModelFailureCategory,
  details: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { category };

  if (typeof details.status === 'number'
    && Number.isInteger(details.status)
    && details.status >= 100
    && details.status <= 599) {
    sanitized.status = details.status;
  }
  if (typeof details.attempts === 'number'
    && Number.isInteger(details.attempts)
    && details.attempts >= 0) {
    sanitized.attempts = details.attempts;
  }
  if (typeof details.retryAfterMs === 'number'
    && Number.isFinite(details.retryAfterMs)
    && details.retryAfterMs >= 0) {
    sanitized.retryAfterMs = details.retryAfterMs;
  }
  if (typeof details.phase === 'string' && MODEL_FAILURE_PHASES.has(details.phase)) {
    sanitized.phase = details.phase;
  }

  return sanitized;
}
