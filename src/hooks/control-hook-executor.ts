import type { ControlHook, HookContext, HookResult } from './types.js';

const FIXED_ORDER = ['evidence-budget', 'policy-deny', 'risk-action'] as const;

/** Executes control hooks deterministically and stops at the first decision. */
export class ControlHookExecutor {
  private readonly hooks: readonly ControlHook[];

  public constructor(hooks: readonly ControlHook[]) {
    const seen = new Set<string>();
    for (const hook of hooks) {
      if (hook.id.length === 0) throw new Error('Control Hook id must not be empty.');
      if (seen.has(hook.id)) throw new Error(`Duplicate control Hook id: ${hook.id}`);
      seen.add(hook.id);
    }
    this.hooks = hooks
      .map((hook, index) => ({ hook, index }))
      .sort((left, right) => this.orderOf(left.hook.id) - this.orderOf(right.hook.id) || left.index - right.index)
      .map((item) => item.hook);
  }

  public async runBefore(context: HookContext): Promise<HookResult> {
    for (const hook of this.hooks) {
      if (!hook.matches(context)) continue;
      const result = await hook.beforeExecute(context);
      if (result.type !== 'continue') return result;
      if (result.modifiedInput !== undefined) context.input = result.modifiedInput;
    }
    return { type: 'continue', modifiedInput: context.input };
  }

  private orderOf(id: string): number {
    const index = FIXED_ORDER.indexOf(id as typeof FIXED_ORDER[number]);
    return index === -1 ? FIXED_ORDER.length : index;
  }
}
