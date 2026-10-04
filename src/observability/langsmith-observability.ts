import { Client } from 'langsmith';
import { RunTree } from 'langsmith/run_trees';
import type { Observability, SpanHandle, SpanStart } from '../contracts/index.js';
import { ExportDiagnosticsRecorder } from './export-diagnostics.js';
import {
  toSafeLangSmithError,
  toSafeLangSmithMetadata,
  toSafeLangSmithOutput,
  toSafeLangSmithSpanStart,
} from './langsmith-payload.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface LangSmithTraceLink {
  readonly spanKey: string;
  readonly agentRunId: string;
  readonly remoteRunId: string;
  readonly traceId: string;
  readonly parentRemoteRunId?: string;
}

export interface LangSmithObservabilityOptions {
  projectName: string;
  client?: Client;
  enabled?: boolean;
  tags?: string[];
  /** Internal adapter controls; all are optional to preserve the public constructor. */
  diagnostics?: ExportDiagnosticsRecorder;
  now?: () => number;
  maxPending?: number;
  onTraceLink?: (link: LangSmithTraceLink) => void;
  flushDeadlineMs?: number;
  abortController?: AbortController;
}

class NoopSpan implements SpanHandle {
  public setAttributes(attributes: Record<string, unknown>): void { void attributes; }
  public end(output?: unknown): void { void output; }
  public fail(error: unknown): void { void error; }
}

export class LangSmithObservability implements Observability {
  private readonly client: Client;
  private readonly roots = new Map<string, RunTree>();
  private readonly spans = new Map<string, RunTree>();
  private readonly pending = new Set<Promise<void>>();
  private readonly pendingStarts = new Set<Promise<void>>();
  private readonly pendingCompletions = new Set<Promise<void>>();
  private reservedCompletions = 0;
  private flushOperation: Promise<void> | undefined;
  private readonly diagnostics: ExportDiagnosticsRecorder;
  private readonly now: () => number;
  private readonly maxPending: number;

  public constructor(private readonly options: LangSmithObservabilityOptions) {
    this.client = options.client ?? new Client();
    this.diagnostics = options.diagnostics ?? new ExportDiagnosticsRecorder();
    this.now = options.now ?? Date.now;
    this.maxPending = options.maxPending ?? 256;
  }

  public startSpan(input: SpanStart): SpanHandle {
    if (this.options.enabled === false || this.options.abortController?.signal.aborted) return new NoopSpan();
    // Reserve capacity for this span's start operation and eventual completion
    // operation in one shared budget; otherwise the two queues could each grow
    // to maxPending independently.
    if (this.pending.size + this.reservedCompletions + 2 > this.maxPending
      || this.spans.size >= this.maxPending
      || (input.kind === 'chain' && this.roots.size >= this.maxPending)) {
      this.diagnostics.record('TRACE_QUEUE_FULL');
      return new NoopSpan();
    }
    if (input.spanKey !== undefined && this.spans.has(input.spanKey)) {
      this.diagnostics.record('TRACE_PAYLOAD_DROPPED');
      return new NoopSpan();
    }

    const parent = input.parentSpanKey === undefined
      ? (input.kind === 'chain' ? undefined : this.roots.get(input.runId))
      : this.spans.get(input.parentSpanKey);
    if ((input.parentSpanKey !== undefined && parent === undefined)
      || (input.kind !== 'chain' && parent === undefined)) {
      this.diagnostics.record('TRACE_PARENT_MISSING');
      return new NoopSpan();
    }

    const safe = toSafeLangSmithSpanStart(input, this.options.tags);
    const common = {
      name: safe.name,
      run_type: this.runType(input.kind),
      inputs: safe.inputs,
      metadata: safe.metadata,
      ...(safe.tags.length === 0 ? {} : { tags: safe.tags }),
      start_time: this.safeNow(),
    };
    const run = parent?.createChild(common) ?? new RunTree({
      ...common,
      project_name: this.options.projectName,
      client: this.client,
      tracingEnabled: this.options.enabled ?? true,
      replicas: [],
    });

    if (input.kind === 'chain') this.roots.set(input.runId, run);
    if (input.spanKey !== undefined) {
      this.spans.set(input.spanKey, run);
      this.diagnostics.setActiveSpans(this.spans.size);
      this.addTraceLink(input, run);
    }

    this.reservedCompletions += 1;
    this.trackStart(() => run.postRun(true));
    return new LangSmithSpanHandle(
      run,
      (operation) => this.trackCompletion(operation),
      () => {
        if (input.kind === 'chain' && this.roots.get(input.runId) === run) this.roots.delete(input.runId);
        if (input.spanKey !== undefined && this.spans.get(input.spanKey) === run) {
          this.spans.delete(input.spanKey);
          this.diagnostics.setActiveSpans(this.spans.size);
        }
      },
      this.safeNow,
    );
  }

  public flush(): Promise<void> {
    if (this.flushOperation !== undefined) return this.flushOperation;
    const operation = this.flushWithDeadline();
    this.flushOperation = operation;
    void operation.then(
      () => { if (this.flushOperation === operation) this.flushOperation = undefined; },
      () => { if (this.flushOperation === operation) this.flushOperation = undefined; },
    );
    return operation;
  }

  private async flushWithDeadline(): Promise<void> {
    if (this.options.enabled === false) return;
    const deadlineMs = this.options.flushDeadlineMs ?? 2_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      this.drainPendingOperations().then(() => this.client.flush()).then(() => this.client.awaitPendingTraceBatches()).then(
        () => 'completed' as const,
        () => 'failed' as const,
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), deadlineMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === 'timeout') {
      this.diagnostics.record('TRACE_FLUSH_TIMEOUT');
      this.options.abortController?.abort();
    } else if (outcome === 'failed') {
      this.diagnostics.record('TRACE_NETWORK_ERROR');
    }
  }

  private runType(kind: SpanStart['kind']): string {
    return kind === 'chain' ? 'chain' : kind === 'llm' ? 'llm' : kind === 'tool' ? 'tool' : 'retriever';
  }

  private trackStart(operation: () => Promise<unknown>): void {
    if (this.pending.size >= this.maxPending) {
      this.diagnostics.record('TRACE_QUEUE_FULL');
      return;
    }
    this.trackInQueue(operation, this.pendingStarts);
  }

  private trackCompletion(operation: () => Promise<unknown>): void {
    if (this.reservedCompletions <= 0) {
      this.diagnostics.record('TRACE_QUEUE_FULL');
      return;
    }
    this.reservedCompletions -= 1;
    this.trackInQueue(operation, this.pendingCompletions);
  }

  private trackInQueue(operation: () => Promise<unknown>, queue: Set<Promise<void>>): void {
    const promise = Promise.resolve().then(operation).then(
      () => undefined,
      () => { this.diagnostics.record('TRACE_NETWORK_ERROR'); },
    );
    this.pending.add(promise);
    queue.add(promise);
    this.diagnostics.setPending(this.pending.size);
    void promise.then(() => {
      this.pending.delete(promise);
      queue.delete(promise);
      this.diagnostics.setPending(this.pending.size);
    });
  }

  private async drainPendingOperations(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private addTraceLink(input: SpanStart, run: RunTree): void {
    if (input.spanKey === undefined || !isSafeId(input.runId) || !isSafeId(run.id) || !isSafeId(run.trace_id)) return;
    const parentRunId = run.parent_run?.id ?? run.parent_run_id;
    const link: LangSmithTraceLink = {
      spanKey: input.spanKey,
      agentRunId: input.runId,
      remoteRunId: run.id,
      traceId: run.trace_id,
      ...(parentRunId === undefined || !isSafeId(parentRunId) ? {} : { parentRemoteRunId: parentRunId }),
    };
    if (this.options.onTraceLink !== undefined) {
      this.options.onTraceLink(link);
      return;
    }
    // Direct legacy construction does not retain trace-link history.
  }

  private readonly safeNow = (): number => {
    const value = this.now();
    return Number.isFinite(value) ? value : Date.now();
  };
}

class LangSmithSpanHandle implements SpanHandle {
  private ended = false;

  public constructor(
    private readonly run: RunTree,
    private readonly track: (operation: () => Promise<unknown>) => void,
    private readonly onEnd: () => void,
    private readonly now: () => number,
  ) {}

  public setAttributes(attributes: Record<string, unknown>): void {
    if (this.ended) return;
    const safe = toSafeLangSmithMetadata(attributes);
    this.run.metadata = { ...this.run.metadata, ...safe };
  }

  public end(output?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd();
    const safeOutput = toSafeLangSmithOutput(output);
    this.track(async () => {
      await this.run.end(safeOutput, undefined, this.now());
      await this.run.patchRun();
    });
  }

  public fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd();
    const safeError = toSafeLangSmithError(error);
    this.track(async () => {
      await this.run.end(undefined, safeError, this.now());
      await this.run.patchRun();
    });
  }
}

function isSafeId(value: string): boolean {
  return SAFE_ID.test(value);
}
