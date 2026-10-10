import type { IdGenerator } from '../contracts/common.js';
import type {
  HistoricalEvidenceRef, MemoryCaptureIntent, MemoryCapturePort, MemoryCaptureRequest,
  MemoryCaptureSource, MemoryEventFactory, MemoryManualCaptureCommand, MemoryPolicyPort,
  MemoryQueryStore, MemoryWriteUnitOfWork, MemoryOperation,
} from '../contracts/diagnostic-memory.js';
import { MemoryError } from './memory-error.js';
import { memoryInstant, parseMemoryCaptureCommand } from './diagnostic-memory-state.js';
import { memoryScopeKey } from './memory-scope.js';

export interface MemoryCaptureServiceOptions {
  source: MemoryCaptureSource;
  queries: MemoryQueryStore;
  writes: MemoryWriteUnitOfWork;
  policy: MemoryPolicyPort;
  ids: IdGenerator;
  requiredSources: readonly HistoricalEvidenceRef['source'][];
  events: MemoryEventFactory;
  dispatch: () => Promise<void>;
}

/** Explicit, model-free command service for persisting a manual capture request. */
export class MemoryCaptureService implements MemoryCapturePort {
  public constructor(private readonly options: MemoryCaptureServiceOptions) {}

  public async capture(commandInput: MemoryManualCaptureCommand, operation: MemoryOperation) {
    assertOperation(operation);
    const command = parseMemoryCaptureCommand(commandInput);
    const source = await this.options.source.inspect(command.sourceRunId, operation);
    assertOperation(operation);
    if (source === null || source.context.memoryControl === undefined) throw new MemoryError('MEMORY_SCOPE_INVALID');
    const control = source.context.memoryControl;
    if (!source.isParent) throw new MemoryError('MEMORY_POLICY_DENIED');
    if (source.context.profileId !== control.scope.profileId
      || memoryScopeKey(control.scope) !== memoryScopeKey(command.scope)) throw new MemoryError('MEMORY_SCOPE_INVALID');
    if (!this.options.policy.allows(control, 'capture')) throw new MemoryError('MEMORY_POLICY_DENIED');

    // Replays are authorized against current control, but do not fail because the
    // original source checkpoint has since advanced.
    const previous = await this.options.queries.findCaptureResult(command);
    if (previous !== null) return previous;

    if (!isTerminalStatus(source.context.status)) {
      throw new MemoryError('MEMORY_RUN_NOT_TERMINAL');
    }
    if (source.checkpointRevision !== command.expectedCheckpointRevision) throw new MemoryError('MEMORY_SOURCE_CONFLICT');

    const request: MemoryCaptureRequest = {
      candidateId: this.options.ids.next('memory'),
      sourceRunId: source.context.runId,
      scope: command.scope,
      extractorVersion: 'episodic-v1',
      origin: 'manual',
      requestId: command.requestId,
      sourceRunStatus: source.context.status,
      sourceContextVersion: source.context.contextVersion,
      sourceCheckpointChecksum: source.checkpointChecksum,
      requiredSources: [...new Set(this.options.requiredSources)],
      requestedAt: memoryInstant(command.requestedAt),
    };
    const intent = createCaptureIntent(request, this.options.events);
    const ticket = await this.options.writes.enqueueManualCapture({ command, intent });
    await this.options.dispatch();
    return ticket;
  }
}

function isTerminalStatus(status: string): status is MemoryCaptureRequest['sourceRunStatus'] {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function createCaptureIntent(request: MemoryCaptureRequest, events: MemoryEventFactory): MemoryCaptureIntent {
  const scheduledEvent = events.create('MEMORY_UPDATE_SCHEDULED', request.sourceRunId,
    { candidateType: 'episodic', sourceRunId: request.sourceRunId });
  const rejectedEvent = events.create('MEMORY_UPDATE_FAILED', request.sourceRunId, {
    candidateId: request.candidateId,
    error: { code: 'UNAVAILABLE', message: 'Memory capture capacity is unavailable.', retryable: false,
      details: { category: 'MEMORY_CAPACITY_EXCEEDED' } },
  });
  const failedEvent = events.create('MEMORY_UPDATE_FAILED', request.sourceRunId, {
    candidateId: request.candidateId,
    error: { code: 'UNAVAILABLE', message: 'Memory capture failed.', retryable: false,
      details: { category: 'MEMORY_CAPTURE_FAILED' } },
  });
  return { request, scheduledEvent, rejectedEvent, failedEvent };
}

function assertOperation(operation: MemoryOperation): void {
  operation.signal?.throwIfAborted();
  memoryInstant(operation.now);
  if (!Number.isFinite(operation.deadlineMs)) throw new MemoryError('MEMORY_DATA_INVALID');
  const nowMs = operation.clock?.now().getTime() ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs >= operation.deadlineMs) {
    throw new DOMException('Memory capture deadline exceeded.', 'TimeoutError');
  }
}
