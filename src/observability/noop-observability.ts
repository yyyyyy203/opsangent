import type { Observability, SpanHandle, SpanStart } from '../contracts/index.js';

class NoopSpan implements SpanHandle {
  public setAttributes(attributes: Record<string, unknown>): void { void attributes; }
  public end(output?: unknown): void { void output; }
  public fail(error: unknown): void { void error; }
}

export class NoopObservability implements Observability {
  public startSpan(input: SpanStart): SpanHandle {
    void input;
    return new NoopSpan();
  }

  public flush(): Promise<void> {
    return Promise.resolve();
  }
}
