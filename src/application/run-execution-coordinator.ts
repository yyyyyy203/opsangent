import type { AgentContext, CheckpointStore } from '../contracts/index.js';
import { USER_RUN_CANCELLATION_REASON } from '../agent/types.js';
import type { DiagnosisAgent, ReplyOptions } from '../agent/types.js';

export type RunExecutionErrorCode = 'RUN_ID_REQUIRED' | 'RUN_NOT_FOUND' | 'RUN_CONFLICT';

/** Stable command error exposed by the local HTTP adapter. */
export class RunExecutionError extends Error {
  public constructor(
    public readonly code: RunExecutionErrorCode,
    message: string,
    public readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'RunExecutionError';
  }
}

/** Coordinates one in-process execution per Run ID and owns generator draining. */
export class RunExecutionCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  /** Retained after completion so an uncertain accepted request cannot be replayed by another tab. */
  private readonly accepted = new Set<string>();
  private closing = false;

  public constructor(
    private readonly agent: DiagnosisAgent,
    private readonly checkpoints: Pick<CheckpointStore, 'load'>,
    private readonly options: { prepareStart?: (options: ReplyOptions) => ReplyOptions } = {},
  ) {}

  public start(options: ReplyOptions): Promise<void> {
    if (this.closing) return Promise.reject(new RunExecutionError('RUN_CONFLICT', 'Runtime is shutting down.', 409));
    const runId = options.runId;
    if (runId === undefined || runId.length === 0) {
      return Promise.reject(new RunExecutionError('RUN_ID_REQUIRED', 'runId is required.', 400));
    }
    const existing = this.active.get(runId);
    if (existing !== undefined) return existing;
    if (this.accepted.has(runId)) {
      return Promise.reject(new RunExecutionError('RUN_CONFLICT', 'Run ID has already been accepted.', 409));
    }
    this.accepted.add(runId);
    return this.claim(runId, async (signal) => {
      const checkpoint = await this.checkpoints.load(runId);
      if (checkpoint !== null) {
        throw new RunExecutionError('RUN_CONFLICT', 'Run already exists and cannot be started again.', 409);
      }
      const preparedOptions = this.prepareStart(options);
      await this.drain(this.agent.replyStream({ ...preparedOptions, signal }));
    }, options.signal);
  }

  public resume(runId: string, signal?: AbortSignal): Promise<void> {
    if (this.closing) return Promise.reject(new RunExecutionError('RUN_CONFLICT', 'Runtime is shutting down.', 409));
    const existing = this.active.get(runId);
    if (existing !== undefined) return existing;
    return this.claim(runId, async (runSignal) => {
      const checkpoint = await this.checkpoints.load(runId);
      if (checkpoint === null) throw new RunExecutionError('RUN_NOT_FOUND', 'Run not found.', 404);
      if (isTerminal(checkpoint.status)) {
        throw new RunExecutionError('RUN_CONFLICT', 'Terminal Runs cannot be resumed.', 409);
      }
      if (checkpoint.status === 'awaiting_confirmation') {
        throw new RunExecutionError('RUN_CONFLICT', 'Resolve the pending confirmation before resuming.', 409);
      }
      await this.drain(this.agent.resumeStream(runId, runSignal));
    }, signal);
  }

  /** Abort only work currently owned by this in-process coordinator. */
  public async cancel(runId: string): Promise<void> {
    const controller = this.controllers.get(runId);
    if (controller !== undefined) {
      controller.abort(USER_RUN_CANCELLATION_REASON);
      return;
    }
    const checkpoint = await this.checkpoints.load(runId);
    if (checkpoint === null) throw new RunExecutionError('RUN_NOT_FOUND', 'Run not found.', 404);
    throw new RunExecutionError('RUN_CONFLICT', 'Run is not actively executing and cannot be cancelled.', 409);
  }

  public isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Stop accepting new work and wait until accepted Runs have reached a checkpoint or terminal state. */
  public async close(): Promise<void> {
    this.closing = true;
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()]);
    }
  }

  private prepareStart(options: ReplyOptions): ReplyOptions {
    if (this.options.prepareStart === undefined) return options;
    const prepared = this.options.prepareStart({
      ...options,
      ...(options.toolCallBudget === undefined ? {} : { toolCallBudget: { ...options.toolCallBudget } }),
      ...(options.networkAttemptBudget === undefined ? {} : { networkAttemptBudget: { ...options.networkAttemptBudget } }),
    });
    if (prepared.runId !== options.runId
      || prepared.profileId !== options.profileId
      || prepared.message !== options.message
      || prepared.sessionId !== options.sessionId
      || prepared.replyId !== options.replyId) {
      throw new RunExecutionError('RUN_CONFLICT', 'prepareStart cannot change Run identity.', 409);
    }
    return prepared;
  }

  private claim(runId: string, action: (signal: AbortSignal) => Promise<void>, upstreamSignal?: AbortSignal): Promise<void> {
    const current = this.active.get(runId);
    if (current !== undefined) return current;
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) relayAbort();
    else upstreamSignal?.addEventListener('abort', relayAbort, { once: true });
    const taskRef: { value?: Promise<void> } = {};
    const task = (async () => {
      try {
        await action(controller.signal);
      } finally {
        upstreamSignal?.removeEventListener('abort', relayAbort);
        if (this.active.get(runId) === taskRef.value) {
          this.active.delete(runId);
          this.controllers.delete(runId);
        }
      }
    })();
    taskRef.value = task;
    this.active.set(runId, task);
    this.controllers.set(runId, controller);
    return task;
  }

  private async drain(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
    for await (const event of stream) void event;
  }
}

function isTerminal(status: AgentContext['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
