import { Client } from 'langsmith';
import { RunTree } from 'langsmith/run_trees';
import type { Observability, SpanHandle, SpanStart } from '../contracts/index.js';

export interface LangSmithObservabilityOptions {
  projectName: string;
  client?: Client;
  enabled?: boolean;
  tags?: string[];
}

export class LangSmithObservability implements Observability {
  private readonly client: Client;
  private readonly roots = new Map<string, RunTree>();
  private readonly pending = new Set<Promise<unknown>>();

  public constructor(private readonly options: LangSmithObservabilityOptions) {
    this.client = options.client ?? new Client();
  }

  public startSpan(input: SpanStart): SpanHandle {
    const parent = input.kind === 'chain' ? undefined : this.roots.get(input.runId);
    const metadata = {
      ...input.attributes,
      agentRunId: input.runId,
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    };
    const common = {
      name: input.name,
      run_type: this.runType(input.kind),
      inputs: asMap(input.input),
      metadata,
      ...(this.options.tags === undefined ? {} : { tags: this.options.tags }),
    };
    const run = parent?.createChild(common) ?? new RunTree({
      ...common,
      project_name: this.options.projectName,
      client: this.client,
      tracingEnabled: this.options.enabled ?? true,
    });
    if (input.kind === 'chain') this.roots.set(input.runId, run);
    this.track(run.postRun(true));
    return new LangSmithSpanHandle(run, (promise) => this.track(promise), () => {
      if (input.kind === 'chain') this.roots.delete(input.runId);
    });
  }

  public async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    await this.client.awaitPendingTraceBatches();
  }

  private runType(kind: SpanStart['kind']): string {
    return kind === 'chain' ? 'chain' : kind === 'llm' ? 'llm' : kind === 'tool' ? 'tool' : 'retriever';
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }
}

class LangSmithSpanHandle implements SpanHandle {
  private ended = false;

  public constructor(
    private readonly run: RunTree,
    private readonly track: (promise: Promise<unknown>) => void,
    private readonly onEnd: () => void,
  ) {}

  public setAttributes(attributes: Record<string, unknown>): void {
    this.run.metadata = { ...this.run.metadata, ...attributes };
  }

  public end(output?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.track(this.run.end(asMap(output)).then(async () => this.run.patchRun()));
    this.onEnd();
  }

  public fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    const message = error instanceof Error ? error.message : String(error);
    this.track(this.run.end(undefined, message).then(async () => this.run.patchRun()));
    this.onEnd();
  }
}

function asMap(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}
