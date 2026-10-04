import type { Observability, SpanHandle, SpanStart } from '../../src/contracts/index.js';

export class RecordingObservability implements Observability {
  public readonly starts: SpanStart[] = [];
  public readonly endings: Array<{ spanKey?: string; output?: unknown; error?: unknown }> = [];
  public flushes = 0;

  public startSpan(input: SpanStart): SpanHandle {
    this.starts.push(input);
    return {
      setAttributes: () => undefined,
      end: (output) => { this.endings.push({ ...(input.spanKey === undefined ? {} : { spanKey: input.spanKey }), output }); },
      fail: (error) => { this.endings.push({ ...(input.spanKey === undefined ? {} : { spanKey: input.spanKey }), error }); },
    };
  }

  public flush(): Promise<void> {
    this.flushes += 1;
    return Promise.resolve();
  }
}
