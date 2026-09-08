import type { AgentEventEnvelopeV2 } from '../../contracts/index.js';
import type {
  EventProjectorV2,
  ProjectionFailureSinkV2,
} from './event-publisher.js';
import { toFailure } from './event-publisher.js';

export interface ProjectionCheckpointStoreV2 {
  load(projector: string, runId: string): Promise<number>;
  save(projector: string, runId: string, expectedSequence: number, sequence: number): Promise<void>;
}

export class ProjectionCheckpointConflictError extends Error {
  public constructor(projector: string, runId: string, expected: number, actual: number) {
    super(`projection checkpoint conflict for ${projector}/${runId}: expected ${expected}, actual ${actual}`);
    this.name = 'ProjectionCheckpointConflictError';
  }
}

export class InMemoryProjectionCheckpointStore implements ProjectionCheckpointStoreV2 {
  private readonly checkpoints = new Map<string, number>();

  public load(projector: string, runId: string): Promise<number> {
    return Promise.resolve().then(() => this.checkpoints.get(this.key(projector, runId)) ?? 0);
  }

  public save(projector: string, runId: string, expectedSequence: number, sequence: number): Promise<void> {
    return Promise.resolve().then(() => {
      const key = this.key(projector, runId);
      const actual = this.checkpoints.get(key) ?? 0;
      if (actual !== expectedSequence) throw new ProjectionCheckpointConflictError(projector, runId, expectedSequence, actual);
      if (!Number.isSafeInteger(sequence) || sequence <= actual) throw new RangeError('projection sequence must advance');
      this.checkpoints.set(key, sequence);
    });
  }

  private key(projector: string, runId: string): string {
    return `${projector}\u0000${runId}`;
  }
}

export interface ProjectionRunnerOptionsV2 {
  maxAttempts: number;
}

export class ProjectionRunnerV2 implements EventProjectorV2 {
  public readonly name: string;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, Map<number, AgentEventEnvelopeV2>>();

  public constructor(
    private readonly projector: EventProjectorV2,
    private readonly checkpoints: ProjectionCheckpointStoreV2,
    private readonly failures: ProjectionFailureSinkV2,
    private readonly options: ProjectionRunnerOptionsV2,
  ) {
    this.name = projector.name;
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0) {
      throw new RangeError('maxAttempts must be a positive safe integer');
    }
  }

  public async project(event: AgentEventEnvelopeV2): Promise<void> {
    const events = this.pending.get(event.runId) ?? new Map<number, AgentEventEnvelopeV2>();
    events.set(event.sequence, structuredClone(event));
    this.pending.set(event.runId, events);
    const previous = this.tails.get(event.runId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => this.processPending(event.runId));
    this.tails.set(event.runId, current);
    try {
      await current;
    } finally {
      if (this.tails.get(event.runId) === current) this.tails.delete(event.runId);
    }
  }

  private async processPending(runId: string): Promise<void> {
    const events = this.pending.get(runId);
    if (!events) return;

    while (events.size > 0) {
      const checkpoint = await this.checkpoints.load(this.projector.name, runId);
      const event = events.get(checkpoint + 1);
      if (!event) {
        for (const sequence of events.keys()) {
          if (sequence <= checkpoint) events.delete(sequence);
        }
        return;
      }
      const projected = await this.process(event);
      if (!projected) return;
      events.delete(event.sequence);
    }
    this.pending.delete(runId);
  }

  private async process(event: AgentEventEnvelopeV2): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        const checkpoint = await this.checkpoints.load(this.projector.name, event.runId);
        if (checkpoint >= event.sequence) return true;
        await this.projector.project(structuredClone(event));
        await this.checkpoints.save(this.projector.name, event.runId, checkpoint, event.sequence);
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    await this.failures.record(toFailure(event, this.projector.name, lastError, this.options.maxAttempts));
    return false;
  }
}
