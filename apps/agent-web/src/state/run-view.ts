import type { EventSubscription } from '../api/client.js';
import type {
  ConfirmationDecisionInput,
  ConfirmationDecisionResult,
  PublicConfirmation,
  PublicEventFrame,
  PublicEvidencePage,
  PublicMessageItem,
  PublicMessagePage,
  PublicProfile,
  PublicRunDetail,
  PublicRunPage,
  RunUsageSummary,
} from '../api/types.js';

export interface RunViewClient {
  listProfiles(): Promise<readonly PublicProfile[]>;
  listRuns(options?: { profileId?: string; status?: string; cursor?: string; limit?: number }): Promise<PublicRunPage>;
  getRun(runId: string): Promise<PublicRunDetail>;
  getMessages(runId: string, options?: { cursor?: string; limit?: number }): Promise<PublicMessagePage>;
  listEvidence(runId: string, options?: { cursor?: string; limit?: number }): Promise<PublicEvidencePage>;
  getConfirmation(runId: string): Promise<PublicConfirmation | null>;
  startRun(input: { runId: string; message: string; profileId: string }): Promise<{ runId: string; status: string; eventsUrl: string }>;
  resumeRun(runId: string): Promise<{ runId: string; status: string; eventsUrl: string }>;
  decideConfirmation(runId: string, input: ConfirmationDecisionInput): Promise<ConfirmationDecisionResult>;
  openRunEvents(runId: string, lastEventId: string | undefined, onEvent: (frame: PublicEventFrame) => void, onError?: (error: Error) => void): EventSubscription;
}

export interface RunViewState {
  profiles: readonly PublicProfile[];
  runs: readonly PublicRunPage['items'][number][];
  runId: string | null;
  detail: PublicRunDetail | null;
  messages: readonly PublicMessageItem[];
  evidence: PublicEvidencePage['items'];
  evidenceIncomplete: boolean;
  descendantUsage: RunUsageSummary | null;
  subtreeUsage: RunUsageSummary | null;
  confirmation: PublicConfirmation | null;
  toolActivity: PublicToolActivity | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  connected: boolean;
  /** A confirmation decision changes durable state but intentionally does not invoke resume. */
  resumeRequired: boolean;
  pendingCommand: 'start' | 'resume' | 'confirmation' | null;
  notice: string | null;
}

export type PublicToolActivityStatus = 'running' | 'success' | 'failed' | 'aborted' | 'timeout' | 'skipped' | 'interrupted' | 'awaiting_external' | 'unknown';

export interface PublicToolActivity {
  toolName: string;
  status: PublicToolActivityStatus;
}

export interface TimerPort {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export function mergeMessagePage(current: readonly PublicMessageItem[], page: PublicMessagePage, runId: string): PublicMessageItem[] {
  const byId = new Map<string, PublicMessageItem>();
  for (const item of current) if (item.message.runId === runId) byId.set(item.message.id, item);
  for (const item of page.items) {
    if (item.message.runId !== runId) continue;
    const previous = byId.get(item.message.id);
    if (previous === undefined || item.version >= previous.version) byId.set(item.message.id, item);
  }
  return [...byId.values()].sort((left, right) => compareDescending(left.message.createdAt, right.message.createdAt) || compareDescending(left.message.id, right.message.id));
}

export class RunViewController {
  private state: RunViewState = {
    profiles: [], runs: [], runId: null, detail: null, messages: [], evidence: [], evidenceIncomplete: false, descendantUsage: null, subtreeUsage: null, confirmation: null,
    toolActivity: null,
    status: 'idle', connected: false, resumeRequired: false, pendingCommand: null, notice: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly timers: TimerPort;
  private stream: EventSubscription | null = null;
  private refreshTimer: unknown;
  private calibrationTimer: unknown;
  private refreshInFlight = false;
  private refreshAgain = false;
  private generation = 0;
  private snapshotRequest = 0;
  private appliedSnapshot = 0;

  public constructor(private readonly client: RunViewClient, timers?: TimerPort) {
    this.timers = timers ?? defaultTimers;
  }

  public getState(): RunViewState { return this.state; }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async loadIndex(): Promise<void> {
    try {
      const [profiles, runs] = await Promise.all([this.client.listProfiles(), this.client.listRuns({ limit: 50 })]);
      this.patch({ profiles, runs: runs.items, notice: null });
    } catch (error) {
      this.patch({ notice: errorMessage(error), status: 'error' });
    }
  }

  public async openRun(runId: string, initialMessages: readonly PublicMessageItem[] = []): Promise<void> {
    this.closeRunResources();
    const generation = ++this.generation;
    const snapshotRequest = ++this.snapshotRequest;
    this.patch({ runId, detail: null, messages: mergeMessagePage([], { items: initialMessages }, runId), evidence: [], evidenceIncomplete: false, descendantUsage: null, subtreeUsage: null, confirmation: null, toolActivity: null, status: 'loading', connected: false, resumeRequired: false, notice: null });
    this.stream = this.client.openRunEvents(runId, undefined, (frame) => this.onEvent(generation, frame), (error) => this.onStreamError(generation, error));
    this.patch({ connected: true });
    this.calibrationTimer = this.timers.setInterval(() => { void this.refreshRun(generation); }, 2_000);
    const [detail, messages, confirmation] = await Promise.allSettled([
      this.client.getRun(runId), this.client.getMessages(runId, { limit: 50 }), this.client.getConfirmation(runId),
    ]);
    if (generation !== this.generation) return;
    // Messages have their own monotonic versions and can be retained even if a
    // newer detail/evidence snapshot completes before this tree request.
    if (messages.status === 'fulfilled') this.patch({ messages: mergeMessagePage(this.state.messages, messages.value, runId) });
    const errors: string[] = [];
    if (detail.status === 'rejected') errors.push(errorMessage(detail.reason));
    if (messages.status === 'rejected') errors.push(errorMessage(messages.reason));
    if (confirmation.status === 'rejected') errors.push(errorMessage(confirmation.reason));
    const evidence = await collectRunTreeEvidence(this.client, detail.status === 'fulfilled' ? detail.value : null, runId);
    if (!this.acceptSnapshot(generation, snapshotRequest)) return;
    this.patch({
      ...(detail.status === 'fulfilled' ? { detail: detail.value } : {}),
      ...(confirmation.status === 'fulfilled' ? { confirmation: confirmation.value } : {}),
      evidence: evidence.incomplete ? mergeEvidenceSnapshot(this.state.evidence, evidence.items) : evidence.items,
      evidenceIncomplete: evidence.incomplete, descendantUsage: evidence.descendantUsage, subtreeUsage: evidence.subtreeUsage,
      status: errors.length === 3 && evidence.items.length === 0 ? 'error' : 'ready', notice: errors.length === 0 ? null : errors.join('；'),
    });
  }

  public async startRun(message: string, profileId: string): Promise<void> {
    const runId = globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}`;
    this.patch({ pendingCommand: 'start', notice: null });
    try {
      await this.client.startRun({ runId, message, profileId });
      await this.openRun(runId);
    } catch (error) {
      this.patch({ notice: errorMessage(error), status: 'error' });
    } finally {
      this.patch({ pendingCommand: null });
    }
  }

  public async decideConfirmation(input: ConfirmationDecisionInput): Promise<void> {
    const runId = this.state.runId;
    if (runId === null) return;
    this.patch({ pendingCommand: 'confirmation', notice: null });
    try {
      await this.client.decideConfirmation(runId, input);
      // Every decision mutates the checkpoint but the harness is paused at the
      // HITL boundary. Approval, rejection, and expiry all require an explicit
      // resume command before the next reasoning step may run.
      this.patch({ resumeRequired: true });
      await this.refreshRun(this.generation);
    } catch (error) {
      this.patch({ notice: errorMessage(error) });
      await this.refreshConfirmation(this.generation);
    } finally {
      this.patch({ pendingCommand: null });
    }
  }

  public async resumeRun(): Promise<void> {
    const runId = this.state.runId;
    if (runId === null) return;
    this.patch({ pendingCommand: 'resume', notice: null });
    try {
      await this.client.resumeRun(runId);
      this.patch({ resumeRequired: false });
      await this.refreshRun(this.generation);
    } catch (error) {
      this.patch({ notice: errorMessage(error) });
    } finally {
      this.patch({ pendingCommand: null });
    }
  }

  public close(): void {
    this.closeRunResources();
    this.generation += 1;
    this.patch({ connected: false, pendingCommand: null });
    this.listeners.clear();
  }

  private onEvent(generation: number, frame: PublicEventFrame): void {
    if (generation !== this.generation) return;
    // Native EventSource retries the same connection after a transient error;
    // the first accepted frame is the authoritative reconnect signal.
    if (!this.state.connected) this.patch({ connected: true });
    const activity = toolActivityForEvent(frame, this.state.toolActivity);
    if (activity !== undefined) this.patch({ toolActivity: activity });
    if (frame.event === 'stream_error') {
      this.patch({ notice: '实时连接需要重新同步，正在刷新公开快照。' });
      this.closeStream();
    }
    this.scheduleRefresh(generation);
  }

  private onStreamError(generation: number, error: Error): void {
    if (generation !== this.generation) return;
    this.patch({ connected: false, notice: error.message });
  }

  private scheduleRefresh(generation: number): void {
    if (this.refreshTimer !== undefined) return;
    this.refreshTimer = this.timers.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshMessages(generation);
    }, 200);
  }

  private async refreshMessages(generation: number): Promise<void> {
    if (generation !== this.generation || this.state.runId === null) return;
    if (this.refreshInFlight) { this.refreshAgain = true; return; }
    this.refreshInFlight = true;
    try {
      const page = await this.client.getMessages(this.state.runId, { limit: 50 });
      if (generation === this.generation && this.state.runId !== null) this.patch({ messages: mergeMessagePage(this.state.messages, page, this.state.runId) });
    } catch (error) {
      if (generation === this.generation) this.patch({ notice: errorMessage(error) });
    } finally {
      this.refreshInFlight = false;
      if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(generation); }
    }
  }

  private async refreshRun(generation: number): Promise<void> {
    if (generation !== this.generation || this.state.runId === null) return;
    const runId = this.state.runId;
    const snapshotRequest = ++this.snapshotRequest;
    const [detail] = await Promise.allSettled([this.client.getRun(runId)]);
    if (generation !== this.generation) return;
    if (detail.status === 'fulfilled') {
      const evidence = await collectRunTreeEvidence(this.client, detail.value, runId);
      if (!this.acceptSnapshot(generation, snapshotRequest)) return;
      this.patch({ detail: detail.value, evidence: evidence.incomplete ? mergeEvidenceSnapshot(this.state.evidence, evidence.items) : evidence.items, evidenceIncomplete: evidence.incomplete, descendantUsage: evidence.descendantUsage, subtreeUsage: evidence.subtreeUsage, status: 'ready' });
    }
    await this.refreshConfirmation(generation, snapshotRequest);
    await this.refreshMessages(generation);
  }

  private acceptSnapshot(generation: number, request: number): boolean {
    if (generation !== this.generation || request < this.appliedSnapshot) return false;
    this.appliedSnapshot = request;
    return true;
  }

  private async refreshConfirmation(generation: number, request?: number): Promise<void> {
    if (generation !== this.generation || this.state.runId === null) return;
    try {
      const confirmation = await this.client.getConfirmation(this.state.runId);
      if (generation !== this.generation || (request !== undefined && request < this.appliedSnapshot)) return;
      this.patch({ confirmation });
    } catch (error) {
      if (generation !== this.generation || (request !== undefined && request < this.appliedSnapshot)) return;
      this.patch({ notice: errorMessage(error) });
    }
  }

  private closeRunResources(): void {
    this.closeStream();
    if (this.refreshTimer !== undefined) { this.timers.clearTimeout(this.refreshTimer); this.refreshTimer = undefined; }
    if (this.calibrationTimer !== undefined) { this.timers.clearInterval(this.calibrationTimer); this.calibrationTimer = undefined; }
    this.refreshInFlight = false;
    this.refreshAgain = false;
  }

  private closeStream(): void {
    this.stream?.close();
    this.stream = null;
    this.patch({ connected: false });
  }

  private patch(patch: Partial<RunViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

const MAX_EVIDENCE_TREE_RUNS = 100;
const MAX_EVIDENCE_TREE_ITEMS = 500;
const EVIDENCE_PAGE_SIZE = 100;

function mergeEvidenceSnapshot(previous: PublicEvidencePage['items'], incoming: PublicEvidencePage['items']): PublicEvidencePage['items'] {
  const byId = new Map(incoming.map((item) => [item.evidenceId, item]));
  for (const item of previous) {
    if (byId.size >= MAX_EVIDENCE_TREE_ITEMS) break;
    if (!byId.has(item.evidenceId)) byId.set(item.evidenceId, item);
  }
  return [...byId.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.evidenceId.localeCompare(right.evidenceId));
}

async function collectRunTreeEvidence(
  client: RunViewClient,
  root: PublicRunDetail | null,
  rootRunId: string,
): Promise<{ items: PublicEvidencePage['items']; incomplete: boolean; descendantUsage: RunUsageSummary | null; subtreeUsage: RunUsageSummary | null }> {
  const evidenceById = new Map<string, PublicEvidencePage['items'][number]>();
  const failures = new Set<string>();
  if (root === null) {
    try {
      const page = await listAllEvidence(client, rootRunId, MAX_EVIDENCE_TREE_ITEMS);
      for (const item of page.items) evidenceById.set(item.evidenceId, item);
      if (page.truncated) failures.add('__evidence_item_limit__');
    } catch {
      failures.add(rootRunId);
    }
    return { items: [...evidenceById.values()], incomplete: failures.size > 0, descendantUsage: null, subtreeUsage: null };
  }

  const queued = new Set([root.runId]);
  const details = [root];
  let descendantDetailsIncomplete = false;
  let evidenceItemsLoaded = 0;
  let level: PublicRunDetail[] = [root];
  while (level.length > 0) {
    for (const detail of level) {
      const remaining = MAX_EVIDENCE_TREE_ITEMS - evidenceItemsLoaded;
      if (remaining <= 0) {
        failures.add('__evidence_item_limit__');
        continue;
      }
      try {
        const page = await listAllEvidence(client, detail.runId, remaining);
        for (const item of page.items) {
          if (evidenceById.has(item.evidenceId)) continue;
          evidenceById.set(item.evidenceId, item);
          evidenceItemsLoaded += 1;
        }
        if (page.truncated) failures.add('__evidence_item_limit__');
      } catch {
        failures.add(detail.runId);
      }
    }

    const nextIds = [...new Set(level.flatMap((detail) => detail.childRunIds))].filter((id) => !queued.has(id));
    const available = Math.max(0, MAX_EVIDENCE_TREE_RUNS - queued.size);
    if (nextIds.length > available) {
      failures.add('__run_tree_limit__');
      descendantDetailsIncomplete = true;
    }
    const boundedIds = nextIds.slice(0, available);
    boundedIds.forEach((id) => queued.add(id));
    const detailResults = await Promise.allSettled(boundedIds.map((id) => client.getRun(id)));
    level = [];
    detailResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures.add(boundedIds[index]!);
        descendantDetailsIncomplete = true;
      } else {
        level.push(result.value);
        details.push(result.value);
      }
    });
  }

  const items = [...evidenceById.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.evidenceId.localeCompare(right.evidenceId));
  const descendants = details.slice(1).map((detail) => detail.usage ?? { completeness: 'unavailable' as const });
  const descendantUsage = descendants.length === 0 && !descendantDetailsIncomplete
    ? null
    : aggregateUsage(descendants, descendantDetailsIncomplete);
  const subtreeUsage = aggregateUsage(
    details.map((detail) => detail.usage ?? { completeness: 'unavailable' as const }),
    descendantDetailsIncomplete,
  );
  return { items, incomplete: failures.size > 0, descendantUsage, subtreeUsage };
}

function aggregateUsage(summaries: readonly RunUsageSummary[], forcePartial: boolean): RunUsageSummary {
  const input = sumUsageCounter(summaries, 'inputTokens');
  const output = sumUsageCounter(summaries, 'outputTokens');
  const cached = sumUsageCounter(summaries, 'cachedInputTokens');
  const completeness: RunUsageSummary['completeness'] = forcePartial || input.invalid || output.invalid || cached.invalid
    ? 'partial'
    : summaries.length === 0
      ? 'unavailable'
      : summaries.some((summary) => summary.completeness !== 'complete')
        ? 'partial'
        : 'complete';
  return {
    completeness,
    ...(input.value === undefined ? {} : { inputTokens: input.value }),
    ...(output.value === undefined ? {} : { outputTokens: output.value }),
    ...(cached.allKnown && cached.value !== undefined ? { cachedInputTokens: cached.value } : {}),
  };
}

function sumUsageCounter(
  summaries: readonly RunUsageSummary[],
  key: 'inputTokens' | 'outputTokens' | 'cachedInputTokens',
): { value?: number; invalid: boolean; allKnown: boolean } {
  let total = 0;
  let known = 0;
  let invalid = false;
  for (const summary of summaries) {
    const count = summary[key];
    if (count === undefined) continue;
    known += 1;
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total + count)) invalid = true;
    else total += count;
  }
  return { ...(known > 0 && !invalid ? { value: total } : {}), invalid, allKnown: known === summaries.length };
}

async function listAllEvidence(
  client: RunViewClient,
  runId: string,
  itemLimit: number,
): Promise<{ items: PublicEvidencePage['items'][number][]; truncated: boolean }> {
  const items: PublicEvidencePage['items'][number][] = [];
  const evidenceIds = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    const remaining = itemLimit - items.length;
    if (remaining <= 0) return { items, truncated: cursor !== undefined };
    let page: PublicEvidencePage;
    try {
      page = await client.listEvidence(runId, { limit: Math.min(EVIDENCE_PAGE_SIZE, remaining), ...(cursor === undefined ? {} : { cursor }) });
    } catch {
      return { items, truncated: true };
    }
    for (const item of page.items) {
      if (evidenceIds.has(item.evidenceId)) continue;
      evidenceIds.add(item.evidenceId);
      items.push(item);
    }
    cursor = page.nextCursor;
    pageCount += 1;
    if (cursor !== undefined && pageCount >= MAX_EVIDENCE_TREE_RUNS) return { items, truncated: true };
    if (items.length >= itemLimit && cursor !== undefined) return { items, truncated: true };
  } while (cursor !== undefined);
  return { items, truncated: false };
}

function toolActivityForEvent(frame: PublicEventFrame, previous: PublicToolActivity | null): PublicToolActivity | undefined {
  const envelope = record(frame.data);
  const data = record(envelope?.payload) ?? envelope;
  if (frame.event === 'TOOL_STARTED') {
    const toolName = stringValue(data?.toolName);
    return toolName === undefined ? undefined : { toolName, status: 'running' };
  }
  if (frame.event === 'TOOL_RESULT') {
    const result = record(data?.result);
    const toolName = stringValue(result?.toolName) ?? previous?.toolName;
    if (toolName === undefined) return undefined;
    return { toolName, status: toolStatus(stringValue(result?.status)) };
  }
  if (frame.event === 'TOOL_FAILED') {
    return previous === null ? undefined : { toolName: previous.toolName, status: 'failed' };
  }
  return undefined;
}

function toolStatus(value: string | undefined): PublicToolActivityStatus {
  return value === 'success' || value === 'failed' || value === 'aborted' || value === 'timeout'
    || value === 'skipped' || value === 'interrupted' || value === 'awaiting_external'
    ? value : 'unknown';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const defaultTimers: TimerPort = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

function compareDescending(left: string, right: string): number {
  return left === right ? 0 : left > right ? -1 : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败。';
}
