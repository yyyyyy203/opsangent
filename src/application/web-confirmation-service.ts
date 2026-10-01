import type { Clock, StoredRunCheckpoint, VersionedCheckpointStore } from '../contracts/index.js';
import { CheckpointConflictError } from '../contracts/index.js';
import type { HitlDecisionOutcome, HitlService } from './hitl-service.js';

export interface WebConfirmationDecisionInput {
  toolCallId: string;
  confirmed: boolean;
  expectedRevision: number;
  reason?: string;
}

export interface WebConfirmationDecisionResult {
  outcome: HitlDecisionOutcome;
  revision: number;
}

export type WebConfirmationErrorCode = 'RUN_NOT_FOUND' | 'CONFIRMATION_CONFLICT' | 'REVISION_CONFLICT';

export class WebConfirmationError extends Error {
  public constructor(
    public readonly code: WebConfirmationErrorCode,
    message: string,
    public readonly statusCode: 404 | 409,
  ) {
    super(message);
    this.name = 'WebConfirmationError';
  }
}

/** Version-bound web command facade; it never resumes a Run implicitly. */
export class WebConfirmationService {
  public constructor(
    private readonly hitl: Pick<HitlService, 'decideWithResult'>,
    private readonly checkpoints: VersionedCheckpointStore,
    private readonly clock: Clock,
    private readonly actor = 'web-user',
  ) {
    if (actor.length === 0) throw new RangeError('confirmation actor must not be empty');
  }

  public async decide(runId: string, input: WebConfirmationDecisionInput): Promise<WebConfirmationDecisionResult> {
    validateInput(runId, input);
    const current = await this.checkpoints.load(runId);
    if (current === null) throw new WebConfirmationError('RUN_NOT_FOUND', 'Run not found.', 404);
    if (current.revision !== input.expectedRevision) {
      throw new WebConfirmationError('REVISION_CONFLICT', 'Confirmation revision is stale.', 409);
    }
    this.assertPending(current, input);

    let outcome: HitlDecisionOutcome;
    try {
      outcome = await this.hitl.decideWithResult({
        runId,
        toolCallId: input.toolCallId,
        confirmed: input.confirmed,
        expectedRevision: input.expectedRevision,
        actor: this.actor,
        decidedAt: this.clock.now().toISOString(),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
    } catch (error) {
      if (isCheckpointConflict(error)) {
        throw new WebConfirmationError('REVISION_CONFLICT', 'Confirmation revision is stale.', 409);
      }
      throw error;
    }
    const updated = await this.checkpoints.load(runId);
    if (updated === null) throw new Error(`Checkpoint disappeared after confirmation: ${runId}`);
    return { outcome, revision: updated.revision };
  }

  private assertPending(checkpoint: StoredRunCheckpoint, input: WebConfirmationDecisionInput): void {
    const interrupt = checkpoint.context.pendingInterrupt;
    if (checkpoint.context.status !== 'awaiting_confirmation' || interrupt === undefined) {
      throw new WebConfirmationError('CONFIRMATION_CONFLICT', 'Run is not awaiting confirmation.', 409);
    }
    if (interrupt.toolCallId !== input.toolCallId) {
      throw new WebConfirmationError('CONFIRMATION_CONFLICT', 'Confirmation does not match the pending tool call.', 409);
    }
  }
}

function validateInput(runId: string, input: WebConfirmationDecisionInput): void {
  if (runId.length === 0 || input.toolCallId.length === 0) throw new WebConfirmationError('CONFIRMATION_CONFLICT', 'Run and tool call IDs are required.', 409);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new WebConfirmationError('CONFIRMATION_CONFLICT', 'expectedRevision must be a non-negative integer.', 409);
  }
}

function isCheckpointConflict(error: unknown): boolean {
  if (error instanceof CheckpointConflictError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; details?: { category?: unknown } };
  return candidate.code === 'STORAGE_ERROR' && candidate.details?.category === 'checkpoint_conflict';
}
