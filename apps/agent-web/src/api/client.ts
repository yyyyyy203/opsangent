import type {
  ConfirmationDecisionInput,
  ConfirmationDecisionResult,
  PublicConfirmation,
  PublicEventFrame,
  PublicEvidencePage,
  PublicMessagePage,
  PublicProfile,
  PublicRunDetail,
  PublicRunPage,
} from './types.js';

export interface EventSourceLike {
  onopen?: ((event: Event) => void) | null;
  onerror?: ((event: Event) => void) | null;
  onmessage?: ((event: MessageEvent<string>) => void) | null;
  addEventListener?: (type: string, listener: (event: MessageEvent<string>) => void) => void;
  removeEventListener?: (type: string, listener: (event: MessageEvent<string>) => void) => void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;
export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  fetchImpl?: FetchImplementation;
  eventSourceFactory?: EventSourceFactory;
}

export interface EventSubscription {
  close(): void;
}

export class ApiClientError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export class ApiClient {
  public lastEventSourceUrl: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly eventSourceFactory: EventSourceFactory;

  public constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.eventSourceFactory = options.eventSourceFactory ?? ((url) => {
      if (typeof EventSource === 'undefined') throw new Error('EventSource is unavailable in this browser.');
      return new EventSource(url);
    });
  }

  public async listProfiles(): Promise<readonly PublicProfile[]> {
    return this.request<readonly PublicProfile[]>('/profiles');
  }

  public async listRuns(options: { profileId?: string; status?: string; cursor?: string; limit?: number } = {}): Promise<PublicRunPage> {
    const query = new URLSearchParams();
    if (options.profileId !== undefined) query.set('profileId', options.profileId);
    if (options.status !== undefined) query.set('status', options.status);
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    return this.request<PublicRunPage>(`/runs${query.size === 0 ? '' : `?${query.toString()}`}`);
  }

  public async getRun(runId: string): Promise<PublicRunDetail> {
    return this.request<PublicRunDetail>(this.runPath(runId));
  }

  public async getMessages(runId: string, options: { cursor?: string; limit?: number } = {}): Promise<PublicMessagePage> {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    return this.request<PublicMessagePage>(`${this.runPath(runId)}/messages${query.size === 0 ? '' : `?${query.toString()}`}`);
  }

  public async listEvidence(runId: string, options: { cursor?: string; limit?: number } = {}): Promise<PublicEvidencePage> {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    return this.request<PublicEvidencePage>(`${this.runPath(runId)}/evidence${query.size === 0 ? '' : `?${query.toString()}`}`);
  }

  public async getConfirmation(runId: string): Promise<PublicConfirmation | null> {
    return this.request<PublicConfirmation | null>(`${this.runPath(runId)}/confirmation`);
  }

  public async startRun(input: { runId: string; message: string; profileId: string }): Promise<{ runId: string; status: string; eventsUrl: string }> {
    return this.request('/runs', { method: 'POST', body: input });
  }

  public async resumeRun(runId: string): Promise<{ runId: string; status: string; eventsUrl: string }> {
    return this.request(`${this.runPath(runId)}/resume`, { method: 'POST' });
  }

  public async decideConfirmation(runId: string, input: ConfirmationDecisionInput): Promise<ConfirmationDecisionResult> {
    return this.request<ConfirmationDecisionResult>(`${this.runPath(runId)}/confirmation`, { method: 'POST', body: input });
  }

  public openRunEvents(runId: string, lastEventId: string | undefined, onEvent: (frame: PublicEventFrame) => void, onError: (error: Error) => void = () => undefined): EventSubscription {
    const query = new URLSearchParams({ snapshots: 'none' });
    if (lastEventId !== undefined) query.set('lastEventId', lastEventId);
    const url = `${this.baseUrl}${this.runPath(runId)}/events?${query.toString()}`;
    this.lastEventSourceUrl = url;
    const source = this.eventSourceFactory(url);
    const listeners: Array<[string, (event: MessageEvent<string>) => void]> = [];
    const deliver = (eventName: string, event: MessageEvent<string>): void => {
      try {
        onEvent({ event: eventName, ...(event.lastEventId === '' ? {} : { id: event.lastEventId }), data: JSON.parse(event.data) });
      } catch (error) {
        onError(error instanceof Error ? error : new Error('Invalid SSE event payload.'));
      }
    };
    source.onmessage = (event) => deliver('message', event);
    for (const eventName of SSE_EVENT_NAMES) {
      const listener = (event: MessageEvent<string>) => deliver(eventName, event);
      source.addEventListener?.(eventName, listener);
      listeners.push([eventName, listener]);
    }
    source.onerror = () => onError(new Error('SSE connection failed.'));
    return {
      close: () => {
        for (const [eventName, listener] of listeners) source.removeEventListener?.(eventName, listener);
        source.onmessage = null;
        source.onerror = null;
        source.close();
      },
    };
  }

  private runPath(runId: string): string {
    return `/runs/${encodeURIComponent(runId)}`;
  }

  private async request<T>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
    const init: RequestInit = { method: options.method ?? 'GET' };
    if (options.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(options.body);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    let value: unknown = null;
    if (text.length > 0) {
      try { value = JSON.parse(text); }
      catch { value = null; }
    }
    if (!response.ok) {
      const record = asRecord(value);
      const code = typeof record?.error === 'string' ? record.error : `HTTP_${response.status}`;
      const message = typeof record?.message === 'string' ? record.message : 'Request failed.';
      throw new ApiClientError(code, response.status, message);
    }
    return value as T;
  }
}

const SSE_EVENT_NAMES = [
  'RUN_STARTED', 'RUN_RESUMED', 'RUN_PAUSED', 'RUN_FINISHED', 'RUN_FAILED', 'RUN_CANCELLED', 'RUN_TIMED_OUT',
  'RUN_BUDGET_WARNING', 'RUN_BUDGET_EXHAUSTED', 'STEP_STARTED', 'STEP_COMPLETED', 'STEP_FAILED', 'STAGE_CHANGED',
  'REASONING_STARTED', 'MESSAGE_STARTED', 'CONTENT_BLOCK_STARTED', 'CONTENT_BLOCK_DELTA', 'CONTENT_BLOCK_COMPLETED',
  'MESSAGE_COMPLETED', 'MESSAGE_FAILED', 'TOOL_CALL_CREATED', 'TOOL_STARTED', 'TOOL_PROGRESS', 'TOOL_OUTPUT_DELTA',
  'TOOL_RESULT', 'TOOL_FAILED', 'TOOL_CANCELLED', 'CONFIRMATION_REQUESTED', 'CONFIRMATION_RESOLVED', 'CONFIRMATION_EXPIRED',
  'EVIDENCE_COLLECTED', 'EVIDENCE_COLLECTION_FAILED', 'HYPOTHESIS_UPDATED', 'DIAGNOSIS_COMPLETED', 'ACTION_PROPOSED',
  'ACTION_EXECUTED', 'ACTION_VERIFICATION_COMPLETED', 'ACTION_VERIFICATION_FAILED', 'stream_error', 'message_snapshot',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
