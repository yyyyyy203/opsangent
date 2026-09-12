import type { HookRegistration, HookRegistryLike, HookRegistryValidation, SerializableInterrupt } from '../contracts/index.js';

const DEFAULT_INTERRUPT_TYPES: Record<string, readonly string[]> = {
  'risk-action': ['risk_confirmation'],
  'external-tool-execution': ['external_tool_execution'],
};

/** Static interrupt identity registry. It never stores or invokes resume closures. */
export class HookRegistry implements HookRegistryLike {
  private readonly registrations: ReadonlyMap<string, readonly string[]>;

  public constructor(registrations: readonly (string | HookRegistration)[]) {
    const entries = new Map<string, readonly string[]>();
    for (const registration of registrations) {
      const id = typeof registration === 'string' ? registration : registration.id;
      if (id.length === 0) throw new Error('Hook id must not be empty.');
      if (entries.has(id)) throw new Error(`Duplicate Hook id: ${id}`);
      const interruptTypes = typeof registration === 'string'
        ? DEFAULT_INTERRUPT_TYPES[id] ?? []
        : registration.interruptTypes ?? DEFAULT_INTERRUPT_TYPES[id] ?? [];
      entries.set(id, Object.freeze([...interruptTypes]));
    }
    this.registrations = entries;
  }

  public has(id: string): boolean {
    return this.registrations.has(id);
  }

  public validate(interrupt: SerializableInterrupt, now: Date): HookRegistryValidation {
    const types = this.registrations.get(interrupt.hookId);
    if (types === undefined) return { valid: false, reason: 'unknown_hook' };
    if (interrupt.toolCallId.length === 0) return { valid: false, reason: 'invalid_tool_call' };
    if (types.length > 0 && !types.includes(interrupt.interruptType)) {
      return { valid: false, reason: 'invalid_interrupt_type' };
    }
    if (interrupt.expiresAt !== undefined) {
      const expiresAt = Date.parse(interrupt.expiresAt);
      if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) return { valid: false, reason: 'expired' };
    }
    return { valid: true };
  }
}
