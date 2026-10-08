import type { AgentError } from '../contracts/errors.js';
import type { ModelUsage } from '../contracts/model.js';

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
  usage?: ModelUsage;
  finishReason?: string;
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
  declare public readonly usage?: ModelUsage;
  declare public readonly finishReason?: string;

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
    const usage = safeModelUsage(options.usage);
    if (usage !== undefined) this.usage = usage;
    if (options.finishReason !== undefined && /^(stop|tool_calls|length|content_filter)$/u.test(options.finishReason)) {
      this.finishReason = options.finishReason;
    }
  }
}

export function safeModelUsage(value: unknown): ModelUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage: ModelUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
    const count = record[key];
    if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) return undefined;
    if (typeof count === 'number') usage[key] = count;
  }
  if (usage.inputTokens !== undefined && usage.cachedInputTokens !== undefined && usage.cachedInputTokens > usage.inputTokens) return undefined;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

export function isModelFailureCategory(value: unknown): value is ModelFailureCategory {
  return typeof value === 'string' && [
    'auth', 'rate_limit', 'server', 'network', 'timeout', 'protocol', 'aborted', 'context_length', 'output_truncated',
  ].includes(value);
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
