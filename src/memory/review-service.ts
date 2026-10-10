import type {
  DiagnosticMemoryCase, MemoryOperation, MemoryReviewCommand, MemoryReviewPort,
  MemoryReviewServiceOptions,
} from '../contracts/diagnostic-memory.js';
import { MemoryError } from './memory-error.js';
import { memoryInstant, parseMemoryReviewCommand } from './diagnostic-memory-state.js';
import { memoryScopeKey } from './memory-scope.js';

/** Evidence-gated approval and revocation; persistence owns CAS and atomic outbox writes. */
export class MemoryReviewService implements MemoryReviewPort {
  public constructor(private readonly options: MemoryReviewServiceOptions) {}

  public async review(commandInput: MemoryReviewCommand, operation: MemoryOperation): Promise<DiagnosticMemoryCase> {
    assertOperation(operation);
    const command = parseMemoryReviewCommand(commandInput);

    // Replays must return their stored result before inspecting today's state or evidence.
    const previous = await this.options.queries.findReviewResult(command);
    assertOperation(operation);
    if (previous !== null) return previous;

    const candidate = await this.options.queries.get(command.memoryId, command.scope);
    assertOperation(operation);
    if (candidate === null || candidate.id !== command.memoryId
      || memoryScopeKey(candidate.scope) !== memoryScopeKey(command.scope)) {
      throw new MemoryError('MEMORY_SCOPE_INVALID');
    }
    if (candidate.revision !== command.expectedRevision) throw new MemoryError('MEMORY_REVISION_CONFLICT');
    if (candidate.status === 'rejected'
      || (candidate.status === 'approved' && command.decision === 'approved')) {
      throw new MemoryError('MEMORY_APPROVAL_DENIED');
    }

    let eligibleForPromotion = false;
    if (command.decision === 'approved') {
      const now = operationNow(operation);
      if (candidate.status !== 'observation' || candidate.sourceRunStatus !== 'completed'
        || candidate.quality !== 'sufficient' || command.claimCheck !== 'supported'
        || Date.parse(candidate.validUntil) <= Date.parse(now)) {
        throw new MemoryError('MEMORY_APPROVAL_DENIED');
      }
      if (candidate.evidenceRefs.length === 0) throw new MemoryError('MEMORY_EVIDENCE_UNAVAILABLE');

      let evidenceValid = false;
      try {
        evidenceValid = await this.options.evidence.validate({ sourceRunId: candidate.sourceRunId,
          refs: candidate.evidenceRefs, scope: candidate.scope }, operation);
      } catch {
        assertOperation(operation);
        throw new MemoryError('MEMORY_EVIDENCE_UNAVAILABLE');
      }
      assertOperation(operation);
      const reviewedAt = operationNow(operation);
      if (Date.parse(candidate.validUntil) <= Date.parse(reviewedAt)) throw new MemoryError('MEMORY_APPROVAL_DENIED');
      if (!evidenceValid) throw new MemoryError('MEMORY_EVIDENCE_UNAVAILABLE');

      eligibleForPromotion = candidate.scope.dataClass === 'live'
        && candidate.sourceRunStatus === 'completed' && candidate.quality === 'sufficient';
    }

    const reviewedAt = operationNow(operation);
    const events = [
      this.options.events.create('EXPERIENCE_REVIEWED', candidate.sourceRunId,
        { candidateId: candidate.id, decision: command.decision, reviewer: command.actorId }),
      this.options.events.create('MEMORY_UPDATE_COMPLETED', candidate.sourceRunId,
        { memoryId: candidate.id, status: command.decision,
          eligibility: eligibleForPromotion ? 'eligible' : 'not_eligible' }),
    ];
    const result = await this.options.writes.review({ command, now: reviewedAt, events });
    await this.options.dispatch();
    return result;
  }
}

function assertOperation(operation: MemoryOperation): void {
  operation.signal?.throwIfAborted();
  memoryInstant(operation.now);
  if (!Number.isFinite(operation.deadlineMs)) throw new MemoryError('MEMORY_DATA_INVALID');
  const nowMs = operation.clock?.now().getTime() ?? Date.parse(operation.now);
  if (!Number.isFinite(nowMs) || nowMs >= operation.deadlineMs) {
    throw new DOMException('Memory review deadline exceeded.', 'TimeoutError');
  }
}

function operationNow(operation: MemoryOperation): string {
  const value = operation.clock?.now() ?? new Date(Date.parse(operation.now));
  if (!Number.isFinite(value.getTime())) throw new MemoryError('MEMORY_DATA_INVALID');
  return memoryInstant(value.toISOString());
}
