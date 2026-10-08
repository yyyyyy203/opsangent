export interface LangSmithExportLimits {
  readonly requestTimeoutMs: number;
  readonly flushTimeoutMs: number;
}

export const DEFAULT_LANGSMITH_EXPORT_LIMITS = { requestTimeoutMs: 1000, flushTimeoutMs: 2000 } as const;
export const ACCEPTANCE_LANGSMITH_EXPORT_LIMITS = { requestTimeoutMs: 10000, flushTimeoutMs: 15000 } as const;

export function resolveLangSmithExportLimits(limits: LangSmithExportLimits = DEFAULT_LANGSMITH_EXPORT_LIMITS): LangSmithExportLimits {
  if (![limits.requestTimeoutMs, limits.flushTimeoutMs].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 30000)) {
    throw new Error('TRACE_EXPORT_LIMITS_INVALID');
  }
  return { requestTimeoutMs: limits.requestTimeoutMs, flushTimeoutMs: limits.flushTimeoutMs };
}
