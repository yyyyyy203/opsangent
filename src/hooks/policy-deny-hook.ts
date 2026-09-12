import type { ControlHook, HookContext, HookResult } from './types.js';

/** Converts a deterministic deny decision into the stable model-visible error. */
export class PolicyDenyHook implements ControlHook {
  public readonly id = 'policy-deny';

  public matches(context: HookContext): boolean {
    return context.risk.disposition === 'deny';
  }

  public beforeExecute(context: HookContext): Promise<HookResult> {
    void context;
    return Promise.resolve({
      type: 'abort',
      error: {
        code: 'POLICY_DENIED',
        message: 'Tool call denied by policy.',
        retryable: false,
        details: { category: 'risk_policy' },
      },
    });
  }
}
