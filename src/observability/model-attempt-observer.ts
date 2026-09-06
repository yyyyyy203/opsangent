import type { Observability, SpanHandle } from '../contracts/observability.js';
import type { ModelAttemptEvent, ModelAttemptObserver } from '../model/model-attempt-observer.js';
import { ModelFailure } from '../model/model-failure.js';

export class ObservabilityModelAttemptObserver implements ModelAttemptObserver {
  private readonly active = new Map<string, SpanHandle>();

  public constructor(private readonly observability: Observability) {}

  public record(event: ModelAttemptEvent): void | Promise<void> {
    const key = this.key(event);
    if (event.type === 'started') {
      if (this.active.has(key)) return;
      this.active.set(key, this.observability.startSpan({
        name: 'model.attempt',
        kind: 'llm',
        runId: event.runId,
        stepId: event.stepId,
        attributes: { attempt: event.attempt },
      }));
      return;
    }

    const span = this.active.get(key);
    if (span === undefined) return;
    this.active.delete(key);

    if (event.type === 'succeeded') {
      span.end({
        outcome: 'succeeded',
        ...(event.usage === undefined ? {} : { usage: event.usage }),
      });
      return;
    }

    if (event.type === 'retry_scheduled') {
      span.setAttributes({
        category: event.category,
        delayMs: event.delayMs,
        outcome: 'retry_scheduled',
      });
      span.fail(new ModelFailure(
        event.category,
        'Model attempt scheduled for retry.',
        true,
        { delayMs: event.delayMs },
      ));
      return;
    }

    span.setAttributes({
      category: event.category,
      outcome: 'failed',
      retryable: event.retryable,
    });
    span.fail(new ModelFailure(event.category, 'Model attempt failed.', event.retryable));
  }

  private key(event: ModelAttemptEvent): string {
    return `${event.runId}:${event.stepId}:${event.attempt}`;
  }
}
