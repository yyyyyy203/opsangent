import type { Clock } from '../contracts/common.js';
import type {
  MemoryCaptureSource, MemoryEventFactory, MemoryWriteUnitOfWork,
} from '../contracts/diagnostic-memory.js';
import { buildMemoryCase } from './case-builder.js';
import { MemoryError } from './memory-error.js';

const MAX_DRAIN_LIMIT = 50;
const MAX_ATTEMPTS = 2;
const LEASE_MS = 30_000;

export interface MemoryCaptureWorkerOptions {
  source: MemoryCaptureSource;
  writes: MemoryWriteUnitOfWork;
  clock: Clock;
  ownerId: string;
  events: MemoryEventFactory;
  dispatch: () => Promise<void>;
}

/** Bounded one-shot capture worker. It has no model, agent loop, timer, or background polling. */
export class MemoryCaptureWorker {
  private activeDrain: Promise<{ completed: number; failed: number; pending: boolean }> | undefined;
  private closed = false;

  public constructor(private readonly options: MemoryCaptureWorkerOptions) {
    if (options.ownerId.trim().length === 0) throw new MemoryError('MEMORY_DATA_INVALID');
  }

  public drain(input: { limit: number; signal?: AbortSignal }): Promise<{ completed: number; failed: number; pending: boolean }> {
    if (this.closed) return Promise.reject(new MemoryError('MEMORY_DISABLED'));
    if (this.activeDrain !== undefined) return Promise.reject(new MemoryError('MEMORY_POLICY_DENIED'));
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > MAX_DRAIN_LIMIT) {
      return Promise.reject(new MemoryError('MEMORY_DATA_INVALID'));
    }
    const active = this.runDrain(input);
    this.activeDrain = active;
    void active.finally(() => { if (this.activeDrain === active) this.activeDrain = undefined; }).catch(() => {});
    return active;
  }

  /** Stops admitting work, then waits for the already-started bounded drain. */
  public async close(): Promise<void> {
    this.closed = true;
    const active = this.activeDrain;
    if (active !== undefined) await active.catch(() => undefined);
  }

  private async runDrain(input: { limit: number; signal?: AbortSignal }): Promise<{ completed: number; failed: number; pending: boolean }> {
    let completed = 0;
    let failed = 0;
    let claimed = 0;
    while (claimed < input.limit) {
      input.signal?.throwIfAborted();
      const now = this.options.clock.now();
      const leaseUntil = new Date(now.getTime() + LEASE_MS);
      const claim = await this.options.writes.claimNext({ ownerId: this.options.ownerId,
        now: now.toISOString(), leaseUntil: leaseUntil.toISOString(), maxAttempts: MAX_ATTEMPTS });
      if (claim === null) {
        await this.options.dispatch();
        return { completed, failed, pending: false };
      }
      claimed += 1;
      const operation = { now: now.toISOString(), deadlineMs: leaseUntil.getTime(),
        clock: this.options.clock,
        ...(input.signal === undefined ? {} : { signal: input.signal }) };
      try {
        const source = await this.options.source.load(claim.request, operation);
        input.signal?.throwIfAborted();
        const candidate = buildMemoryCase(claim.request, source, this.options.clock.now().toISOString());
        const events = [
          this.options.events.create('MEMORY_UPDATE_COMPLETED', claim.request.sourceRunId,
            { memoryId: candidate.id, status: candidate.status, eligibility: 'not_eligible' }),
          this.options.events.create('EXPERIENCE_CANDIDATE_CREATED', claim.request.sourceRunId,
            { candidateId: candidate.id, evidenceIds: candidate.evidenceRefs.map((ref) => ref.evidenceId), qualityStatus: candidate.quality }),
        ];
        await this.options.writes.completeCapture({ claim, candidate, now: this.options.clock.now().toISOString(), events });
        completed += 1;
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) throw error;
        failed += 1;
        await this.options.writes.failCapture({ claim, now: this.options.clock.now().toISOString(),
          code: 'MEMORY_CAPTURE_FAILED', events: [] });
      }
      await this.options.dispatch();
    }
    return { completed, failed, pending: claimed === input.limit };
  }

}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
