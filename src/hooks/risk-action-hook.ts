import type { Clock } from '../contracts/common.js';
import { toolInputDigest } from '../tool/schema.js';
import type { ControlHook, HookContext, HookResult } from './types.js';

export class RiskActionHook implements ControlHook {
  public readonly id = 'risk-action';

  public constructor(
    private readonly clock: Clock,
    private readonly confirmationTtlMs = 15 * 60 * 1000,
  ) {}

  public matches(context: HookContext): boolean {
    return context.risk.requireConfirmation || context.tool.requireUserConfirm === true;
  }

  public beforeExecute(context: HookContext): Promise<HookResult> {
    if (!context.risk.requireConfirmation && context.tool.requireUserConfirm !== true) {
      return Promise.resolve({ type: 'continue' });
    }
    if (context.context.confirmedToolCallIds.includes(context.toolCall.id)) {
      return Promise.resolve({ type: 'continue' });
    }

    const createdAt = this.clock.now();
    return Promise.resolve({
      type: 'interrupt',
      interrupt: {
        hookId: this.id,
        interruptType: 'risk_confirmation',
        toolCallId: context.toolCall.id,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + this.confirmationTtlMs).toISOString(),
        payload: {
          toolName: context.tool.name,
          input: context.input,
          inputDigest: toolInputDigest(context.tool, context.toolCall),
          severity: context.risk.severity,
          findings: context.risk.findings,
        },
      },
    });
  }
}
