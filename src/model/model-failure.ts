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

export type ModelFailureDisposition = 'retryable' | 'fallback_only' | 'terminal' | 'aborted';

export interface ModelFailureOptions {
  disposition?: ModelFailureDisposition;
}

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
  public readonly disposition: ModelFailureDisposition;
  public readonly fallbackAllowed: boolean;

  public constructor(
    category: ModelFailureCategory,
    message: string,
    public readonly retryable: boolean,
    details: Record<string, unknown> = {},
    options: ModelFailureOptions = {},
  ) {
    super(message);
    this.name = 'ModelFailure';
    const explicitDisposition = options.disposition !== undefined;
    this.disposition = options.disposition ?? defaultDisposition(category, retryable);
    this.fallbackAllowed = this.disposition === 'retryable' || this.disposition === 'fallback_only';
    this.details = sanitizeDetails(category, details, this.disposition, explicitDisposition);
  }
}

function sanitizeDetails(
  category: ModelFailureCategory,
  details: Record<string, unknown>,
  disposition: ModelFailureDisposition,
  includeDisposition: boolean,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { category, ...(includeDisposition ? { disposition } : {}) };

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

function defaultDisposition(category: ModelFailureCategory, retryable: boolean): ModelFailureDisposition {
  if (category === 'aborted') return 'aborted';
  return retryable ? 'retryable' : 'fallback_only';
}
