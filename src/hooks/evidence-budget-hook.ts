import type { HookContext, HookResult, ToolHook } from './types.js';

export class EvidenceBudgetHook implements ToolHook {
  public readonly id = 'evidence-budget';

  public matches(context: HookContext): boolean {
    return context.tool.kind === 'evidence';
  }

  public beforeExecute(context: HookContext): Promise<HookResult> {
    // Harness admission reserves all calls, including invalid/utility calls.
    // Resuming an admitted call must not charge it again.
    if (context.context.admittedToolCallIds?.includes(context.toolCall.id)) return Promise.resolve({ type: 'continue' });
    const budget = context.context.budget;
    const elapsedMs = Date.now() - Date.parse(budget.startedAt);
    if (budget.toolCallsUsed >= budget.maxToolCalls || elapsedMs >= budget.maxDurationMs) {
      return Promise.resolve({
        type: 'abort',
        error: {
          code: 'BUDGET_EXCEEDED',
          message: 'Evidence collection budget exhausted.',
          retryable: false,
          details: { toolCallsUsed: budget.toolCallsUsed, elapsedMs },
        },
      });
    }
    budget.toolCallsUsed += 1;
    return Promise.resolve({ type: 'continue' });
  }
}
