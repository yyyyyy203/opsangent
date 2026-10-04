import type { AgentError, Tool, ToolCallOptions } from '../contracts/index.js';

export interface SourceInvocationLimiterOptions {
  readonly maxPerSource: 1;
}

type CanonicalSource = 'metrics' | 'logs';

const CANONICAL_SOURCES: Readonly<Record<string, CanonicalSource>> = Object.freeze({
  metrics_subagent: 'metrics',
  logs_subagent: 'logs',
});

/** Run-scoped admission wrapper for the two parent-facing source Subagents. */
export class SourceInvocationLimiter {
  private readonly invokedByRun = new Map<string, Set<CanonicalSource>>();

  public constructor(options: SourceInvocationLimiterOptions) {
    if (options === null || typeof options !== 'object' || options.maxPerSource !== 1) {
      throw new RangeError('Source invocation limit must be exactly one per source.');
    }
  }

  public wrap(tool: Tool): Tool {
    const source = CANONICAL_SOURCES[tool.name];
    if (source === undefined || tool.source !== 'subagent' || tool.call === undefined) {
      throw new TypeError('Only the canonical Metrics and Logs Subagent Tools can be limited.');
    }
    const invoke = tool.call;
    return Object.freeze({
      ...tool,
      call: (input: Record<string, unknown>, options: ToolCallOptions) => {
        if (typeof options.runId !== 'string' || options.runId.trim().length === 0) {
          throw new SourceInvocationLimitError({
            code: 'INVALID_INPUT', message: 'Source invocation requires a Run identity.', retryable: false,
          });
        }
        let invokedSources = this.invokedByRun.get(options.runId);
        if (invokedSources?.has(source) === true) {
          throw new SourceInvocationLimitError({
            code: 'BUDGET_EXCEEDED',
            message: 'Source invocation limit exceeded for this Run.',
            retryable: false,
            details: { source, limit: 1 },
          });
        }
        if (invokedSources === undefined) {
          invokedSources = new Set<CanonicalSource>();
          this.invokedByRun.set(options.runId, invokedSources);
        }
        invokedSources.add(source);
        return invoke(input, options);
      },
    });
  }

  /** Clear smoke-scoped state when the owning Web runtime closes. */
  public clear(): void {
    this.invokedByRun.clear();
  }
}

class SourceInvocationLimitError extends Error implements AgentError {
  public readonly code: AgentError['code'];
  public readonly retryable: boolean;
  public readonly details?: Record<string, unknown>;

  public constructor(error: AgentError) {
    super(error.message);
    this.name = 'SourceInvocationLimitError';
    this.code = error.code;
    this.retryable = error.retryable;
    if (error.details !== undefined) this.details = error.details;
  }
}
