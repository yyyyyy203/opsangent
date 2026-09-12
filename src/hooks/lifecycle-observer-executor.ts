import type { LifecycleObserverResult, ToolLifecycleFact, ToolLifecycleObserver } from '../contracts/index.js';

/** Runs all lifecycle observers without allowing one observer to hide a fact from another. */
export class LifecycleObserverExecutor {
  private readonly observers: readonly ToolLifecycleObserver[];

  public constructor(observers: readonly ToolLifecycleObserver[]) {
    const seen = new Set<string>();
    for (const observer of observers) {
      if (observer.id.length === 0) throw new Error('Lifecycle observer id must not be empty.');
      if (seen.has(observer.id)) throw new Error(`Duplicate lifecycle observer id: ${observer.id}`);
      seen.add(observer.id);
    }
    this.observers = [...observers];
  }

  public async observe(fact: ToolLifecycleFact): Promise<LifecycleObserverResult> {
    const settled = await Promise.allSettled(this.observers.map((observer) => (
      Promise.resolve().then(() => observer.observe(structuredClone(fact)))
    )));
    const effects = settled.flatMap((result) => result.status === 'fulfilled'
      ? result.value.map((effect) => structuredClone(effect))
      : []);
    const failedObserverIds = settled.flatMap((result, index) => result.status === 'rejected' && this.observers[index] !== undefined
      ? [this.observers[index].id]
      : []);
    return { effects, failedObserverIds };
  }
}
