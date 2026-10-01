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
} from '../api/types.js';

export interface RunViewClient {
  listProfiles(): Promise<readonly PublicProfile[]>;
  listRuns(options?: { profileId?: string; status?: string; cursor?: string; limit?: number }): Promise<PublicRunPage>;
  getRun(runId: string): Promise<PublicRunDetail>;
  getMessages(runId: string, options?: { cursor?: string; limit?: number }): Promise<PublicMessagePage>;
  listEvidence(runId: string): Promise<PublicEvidencePage>;
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
  confirmation: PublicConfirmation | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  connected: boolean;
  pendingCommand: 'start' | 'resume' | 'confirmation' | null;
  notice: string | null;
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
    profiles: [], runs: [], runId: null, detail: null, messages: [], evidence: [], confirmation: null,
    status: 'idle', connected: false, pendingCommand: null, notice: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly timers: TimerPort;
  private stream: EventSubscription | null = null;
  private refreshTimer: unknown;
  private calibrationTimer: unknown;
  private refreshInFlight = false;
  private refreshAgain = false;
  private generation = 0;

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
    this.patch({ runId, detail: null, messages: mergeMessagePage([], { items: initialMessages }, runId), evidence: [], confirmation: null, status: 'loading', connected: false, notice: null });
    this.stream = this.client.openRunEvents(runId, undefined, (frame) => this.onEvent(generation, frame), (error) => this.onStreamError(generation, error));
    this.patch({ connected: true });
    this.calibrationTimer = this.timers.setInterval(() => { void this.refreshRun(generation); }, 2_000);
    const [detail, messages, evidence, confirmation] = await Promise.allSettled([
      this.client.getRun(runId), this.client.getMessages(runId, { limit: 50 }), this.client.listEvidence(runId), this.client.getConfirmation(runId),
    ]);
    if (generation !== this.generation) return;
    const errors: string[] = [];
    if (detail.status === 'fulfilled') this.patch({ detail: detail.value }); else errors.push(errorMessage(detail.reason));
    if (messages.status === 'fulfilled') this.patch({ messages: mergeMessagePage(this.state.messages, messages.value, runId) }); else errors.push(errorMessage(messages.reason));
    if (evidence.status === 'fulfilled') this.patch({ evidence: evidence.value.items }); else errors.push(errorMessage(evidence.reason));
    if (confirmation.status === 'fulfilled') this.patch({ confirmation: confirmation.value }); else errors.push(errorMessage(confirmation.reason));
    this.patch({ status: errors.length === 4 ? 'error' : 'ready', notice: errors.length === 0 ? null : errors.join('；') });
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
    const [detail, evidence] = await Promise.allSettled([this.client.getRun(runId), this.client.listEvidence(runId)]);
    if (generation !== this.generation) return;
    if (detail.status === 'fulfilled') this.patch({ detail: detail.value });
    if (evidence.status === 'fulfilled') this.patch({ evidence: evidence.value.items });
    await this.refreshConfirmation(generation);
    await this.refreshMessages(generation);
  }

  private async refreshConfirmation(generation: number): Promise<void> {
    if (generation !== this.generation || this.state.runId === null) return;
    try {
      this.patch({ confirmation: await this.client.getConfirmation(this.state.runId) });
    } catch (error) {
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
