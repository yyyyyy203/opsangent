import type { AgentContext, CheckpointStore } from '../contracts/index.js';
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
  /** Retained after completion so an uncertain accepted request cannot be replayed by another tab. */
  private readonly accepted = new Set<string>();

  public constructor(
    private readonly agent: DiagnosisAgent,
    private readonly checkpoints: Pick<CheckpointStore, 'load'>,
  ) {}

  public start(options: ReplyOptions): Promise<void> {
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
    return this.claim(runId, async () => {
      const checkpoint = await this.checkpoints.load(runId);
      if (checkpoint !== null) {
        throw new RunExecutionError('RUN_CONFLICT', 'Run already exists and cannot be started again.', 409);
      }
      await this.drain(this.agent.replyStream(options));
    });
  }

  public resume(runId: string, signal?: AbortSignal): Promise<void> {
    const existing = this.active.get(runId);
    if (existing !== undefined) return existing;
    return this.claim(runId, async () => {
      const checkpoint = await this.checkpoints.load(runId);
      if (checkpoint === null) throw new RunExecutionError('RUN_NOT_FOUND', 'Run not found.', 404);
      if (isTerminal(checkpoint.status)) {
        throw new RunExecutionError('RUN_CONFLICT', 'Terminal Runs cannot be resumed.', 409);
      }
      if (checkpoint.status === 'awaiting_confirmation') {
        throw new RunExecutionError('RUN_CONFLICT', 'Resolve the pending confirmation before resuming.', 409);
      }
      await this.drain(signal === undefined
        ? this.agent.resumeStream(runId)
        : this.agent.resumeStream(runId, signal));
    });
  }

  public isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  private claim(runId: string, action: () => Promise<void>): Promise<void> {
    const current = this.active.get(runId);
    if (current !== undefined) return current;
    let task!: Promise<void>;
    task = (async () => {
      try {
        await action();
      } finally {
        if (this.active.get(runId) === task) this.active.delete(runId);
      }
    })();
    this.active.set(runId, task);
    return task;
  }

  private async drain(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
    for await (const event of stream) void event;
  }
}

function isTerminal(status: AgentContext['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
