export type SpanKind = 'chain' | 'llm' | 'tool' | 'retriever';

export interface SpanStart {
  name: string;
  kind: SpanKind;
  runId: string;
  stepId?: string;
  input?: unknown;
  attributes?: Record<string, unknown>;
}

export interface SpanHandle {
  setAttributes(attributes: Record<string, unknown>): void;
  end(output?: unknown): void;
  fail(error: unknown): void;
}

export interface Observability {
  startSpan(input: SpanStart): SpanHandle;
  flush(): Promise<void>;
}
