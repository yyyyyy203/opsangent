import type { Observability, SpanHandle, SpanStart } from '../../contracts/index.js';

export type TraceTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'paused' | 'incomplete';
export type TraceDiagnosticCode = 'TRACE_PARENT_MISSING';

export interface TraceSpanRegistrySnapshot {
  readonly activeSpans: number;
  readonly rememberedSpanKeys: number;
  readonly seenEventIds: number;
  readonly terminalRuns: number;
  readonly droppedSpans: number;
  readonly counts: Readonly<Partial<Record<TraceDiagnosticCode, number>>>;
}

export interface TraceSpanRegistryOptions {
  readonly maxActiveSpans?: number;
  readonly maxRememberedSpanKeys?: number;
  readonly maxSeenEventIds?: number;
  readonly maxTerminalRuns?: number;
  readonly maxRunStreamFences?: number;
  readonly maxStreamsPerRun?: number;
}

interface ActiveSpan {
  readonly handle: SpanHandle;
  readonly runId: string;
  readonly parentSpanKey?: string;
}

const DEFAULT_MAX_ACTIVE_SPANS = 1_024;
const DEFAULT_MAX_REMEMBERED_SPAN_KEYS = 4_096;
const DEFAULT_MAX_SEEN_EVENT_IDS = 8_192;
const DEFAULT_MAX_TERMINAL_RUNS = 1_024;
const DEFAULT_MAX_RUN_STREAM_FENCES = 1_024;
const DEFAULT_MAX_STREAMS_PER_RUN = 256;

interface RunStreamFence {
  currentStreamId: string | undefined;
  retiredStreamId: string | undefined;
  readonly seenStreamIds: Set<string>;
}

/** Bounded, vendor-neutral ownership for active spans and lifecycle deduplication. */
export class TraceSpanRegistry {
  private readonly active = new Map<string, ActiveSpan>();
  private readonly children = new Map<string, Set<string>>();
  private readonly rememberedSpanKeys = new Map<string, string>();
  private readonly seenEventIds = new Map<string, string>();
  private readonly terminalRuns = new Map<string, true>();
  private readonly runStreamFences = new Map<string, RunStreamFence>();
  private readonly counts: Partial<Record<TraceDiagnosticCode, number>> = {};
  private readonly maxActiveSpans: number;
  private readonly maxRememberedSpanKeys: number;
  private readonly maxSeenEventIds: number;
  private readonly maxTerminalRuns: number;
  private readonly maxRunStreamFences: number;
  private readonly maxStreamsPerRun: number;
  private droppedSpans = 0;

  public constructor(
    private readonly observability: Observability,
    options: TraceSpanRegistryOptions = {},
  ) {
    this.maxActiveSpans = positiveLimit(options.maxActiveSpans, DEFAULT_MAX_ACTIVE_SPANS);
    this.maxRememberedSpanKeys = positiveLimit(options.maxRememberedSpanKeys, DEFAULT_MAX_REMEMBERED_SPAN_KEYS);
    this.maxSeenEventIds = positiveLimit(options.maxSeenEventIds, DEFAULT_MAX_SEEN_EVENT_IDS);
    this.maxTerminalRuns = positiveLimit(options.maxTerminalRuns, DEFAULT_MAX_TERMINAL_RUNS);
    this.maxRunStreamFences = positiveLimit(options.maxRunStreamFences, DEFAULT_MAX_RUN_STREAM_FENCES);
    this.maxStreamsPerRun = positiveLimit(options.maxStreamsPerRun, DEFAULT_MAX_STREAMS_PER_RUN);
  }

  public rememberEvent(runId: string, eventId: string): boolean {
    if (this.terminalRuns.has(runId) || this.seenEventIds.has(eventId)) return false;
    this.seenEventIds.set(eventId, runId);
    this.trimOldest(this.seenEventIds, this.maxSeenEventIds);
    return true;
  }

  public isRunTerminal(runId: string): boolean {
    return this.terminalRuns.has(runId);
  }

  public isActive(spanKey: string): boolean {
    return this.active.has(spanKey);
  }

  public isRememberedSpanKey(spanKey: string): boolean {
    return this.rememberedSpanKeys.has(spanKey);
  }

  public isCurrentExecutionStream(runId: string, streamId: string | undefined): boolean {
    const fence = this.runStreamFences.get(runId);
    if (fence === undefined) return true;
    if (streamId === undefined && fence.seenStreamIds.size > 1) return false;
    return fence.currentStreamId === (streamId ?? '');
  }

  /** A resume event identifies its new stream; it must be fresh and follow a retired stream. */
  public canResumeExecutionStream(runId: string, newStreamId: string | undefined): boolean {
    const fence = this.runStreamFences.get(runId);
    if (fence === undefined) return true;
    const normalizedStreamId = newStreamId ?? '';
    return fence.currentStreamId === undefined
      && fence.retiredStreamId !== undefined
      && fence.retiredStreamId !== normalizedStreamId
      && !fence.seenStreamIds.has(normalizedStreamId);
  }

  /** Keeps stream fencing per live Run, outside the cross-Run LRU. */
  public acceptExecutionStream(runId: string, streamId: string | undefined): boolean {
    if (this.terminalRuns.has(runId)) return false;
    const normalizedStreamId = streamId ?? '';
    let fence = this.runStreamFences.get(runId);
    if (fence === undefined) {
      if (this.runStreamFences.size >= this.maxRunStreamFences) {
        this.recordParentMissing();
        return false;
      }
      fence = {
        currentStreamId: normalizedStreamId,
        retiredStreamId: undefined,
        seenStreamIds: new Set([normalizedStreamId]),
      };
      this.runStreamFences.set(runId, fence);
      return true;
    }
    if (fence.seenStreamIds.has(normalizedStreamId)) {
      if (fence.currentStreamId !== normalizedStreamId) return false;
      return true;
    }
    if (fence.currentStreamId !== undefined || fence.seenStreamIds.size >= this.maxStreamsPerRun) {
      this.recordParentMissing();
      return false;
    }
    fence.seenStreamIds.add(normalizedStreamId);
    fence.currentStreamId = normalizedStreamId;
    fence.retiredStreamId = undefined;
    return true;
  }

  public retireExecutionStream(runId: string, streamId: string | undefined): void {
    const fence = this.runStreamFences.get(runId);
    if (fence?.currentStreamId === (streamId ?? '')) {
      fence.currentStreamId = undefined;
      fence.retiredStreamId = streamId ?? '';
    }
  }

  /** Parent pauses retire children even when span creation failed for a child segment. */
  public retireCurrentExecutionStream(runId: string): void {
    const fence = this.runStreamFences.get(runId);
    if (fence?.currentStreamId === undefined) return;
    fence.retiredStreamId = fence.currentStreamId;
    fence.currentStreamId = undefined;
  }

  public recordParentMissing(): void {
    this.counts.TRACE_PARENT_MISSING = (this.counts.TRACE_PARENT_MISSING ?? 0) + 1;
  }

  public start(input: SpanStart): boolean {
    const spanKey = input.spanKey;
    if (spanKey === undefined || this.terminalRuns.has(input.runId)
      || this.active.has(spanKey) || this.rememberedSpanKeys.has(spanKey)) return false;
    if (this.active.size >= this.maxActiveSpans) {
      this.droppedSpans += 1;
      return false;
    }

    let parentSpanKey = input.parentSpanKey;
    let orphan = input.attributes?.orphan === true;
    if (parentSpanKey !== undefined && !this.active.has(parentSpanKey)) {
      parentSpanKey = undefined;
      orphan = true;
      this.recordParentMissing();
    }
    const { parentSpanKey: _requestedParentSpanKey, ...spanInput } = input;
    void _requestedParentSpanKey;
    let handle: SpanHandle;
    try {
      handle = this.observability.startSpan({
        ...spanInput,
        ...(parentSpanKey === undefined ? {} : { parentSpanKey }),
        attributes: { ...input.attributes, ...(orphan ? { orphan: true } : {}) },
      });
    } catch {
      return false;
    }
    this.active.set(spanKey, {
      handle,
      runId: input.runId,
      ...(parentSpanKey === undefined ? {} : { parentSpanKey }),
    });
    if (parentSpanKey !== undefined) {
      const siblings = this.children.get(parentSpanKey) ?? new Set<string>();
      siblings.add(spanKey);
      this.children.set(parentSpanKey, siblings);
    }
    return true;
  }

  public end(key: string, output?: unknown): void {
    const span = this.active.get(key);
    if (span === undefined) return;
    try { span.handle.end(output); } catch { /* best effort */ }
    this.removeActive(key, span);
  }

  public fail(key: string, error: unknown): void {
    const span = this.active.get(key);
    if (span === undefined) return;
    try { span.handle.fail(error); } catch { /* best effort */ }
    this.removeActive(key, span);
  }

  public closeDescendants(key: string, status: TraceTerminalStatus): void {
    const ordered: string[] = [];
    const pending = [...(this.children.get(key) ?? [])];
    while (pending.length > 0) {
      const childKey = pending.pop();
      if (childKey === undefined) continue;
      ordered.push(childKey);
      pending.push(...(this.children.get(childKey) ?? []));
    }
    for (const childKey of ordered.reverse()) {
      this.end(childKey, { status: 'incomplete', terminalStatus: status });
    }
  }

  public markRunTerminal(runId: string): void {
    if (this.terminalRuns.has(runId)) return;
    this.terminalRuns.set(runId, true);
    this.trimOldest(this.terminalRuns, this.maxTerminalRuns);
    this.runStreamFences.delete(runId);
    this.removeOwnedEntries(this.rememberedSpanKeys, runId);
    this.removeOwnedEntries(this.seenEventIds, runId);
  }

  public getSnapshot(): TraceSpanRegistrySnapshot {
    return {
      activeSpans: this.active.size,
      rememberedSpanKeys: this.rememberedSpanKeys.size,
      seenEventIds: this.seenEventIds.size,
      terminalRuns: this.terminalRuns.size,
      droppedSpans: this.droppedSpans,
      counts: { ...this.counts },
    };
  }

  private removeActive(key: string, span: ActiveSpan): void {
    this.active.delete(key);
    if (span.parentSpanKey !== undefined) {
      const siblings = this.children.get(span.parentSpanKey);
      siblings?.delete(key);
      if (siblings?.size === 0) this.children.delete(span.parentSpanKey);
    }
    this.children.delete(key);
    if (!this.terminalRuns.has(span.runId)) {
      this.rememberedSpanKeys.set(key, span.runId);
      this.trimOldest(this.rememberedSpanKeys, this.maxRememberedSpanKeys);
    }
  }

  private removeOwnedEntries<T>(entries: Map<string, T>, owner: T): void {
    for (const [key, value] of entries) if (value === owner) entries.delete(key);
  }

  private trimOldest<T>(entries: Map<string, T>, limit: number): void {
    while (entries.size > limit) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) return;
      entries.delete(oldest);
    }
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
