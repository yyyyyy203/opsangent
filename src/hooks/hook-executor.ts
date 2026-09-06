import type { HookContext, HookResult, ToolHook } from './types.js';

export class HookExecutor {
  public constructor(private readonly hooks: readonly ToolHook[]) {}

  public async runBefore(context: HookContext): Promise<HookResult> {
    for (const hook of this.hooks) {
      if (!hook.matches(context) || hook.beforeExecute === undefined) continue;
      const result = await hook.beforeExecute(context);
      if (result.type !== 'continue') return result;
      if (result.modifiedInput !== undefined) context.input = result.modifiedInput;
    }
    return { type: 'continue', modifiedInput: context.input };
  }

  public async runAfter(context: HookContext): Promise<HookResult> {
    for (const hook of this.hooks) {
      if (!hook.matches(context) || hook.afterExecute === undefined) continue;
      const result = await hook.afterExecute(context);
      if (result.type !== 'continue') return result;
    }
    return { type: 'continue' };
  }
}
