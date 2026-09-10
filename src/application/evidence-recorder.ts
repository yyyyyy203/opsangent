import type { EventStore } from '../contracts/event-store.js';
import type { EventFactoryV2Like, EventPublisherV2Like } from '../contracts/event-publisher.js';
import type { EvidenceRecord, EvidenceStore } from '../contracts/storage.js';

const MAX_PUBLIC_SUMMARY_BYTES = 16 * 1024;

export interface EvidenceCaptureRequest {
  record: EvidenceRecord;
  stepId: string;
  toolCallId: string;
  coverage: number;
  publicSummary: string;
}

export interface EvidenceRecorder {
  capture(request: EvidenceCaptureRequest): Promise<EvidenceRecord>;
}

export interface EvidenceRecorderEventChannel {
  factory: EventFactoryV2Like;
  publisher: EventPublisherV2Like;
  store: Pick<EventStore, 'findById'>;
  correlationId(runId: string): string;
}

export interface DefaultEvidenceRecorderOptions {
  evidence: EvidenceStore;
  /** Omit only for isolated tool tests; production composition always provides the V2 audit channel. */
  events?: EvidenceRecorderEventChannel;
}

/**
 * The only application boundary allowed to turn raw evidence persistence into a public audit event.
 * Event payloads contain IDs and safe summaries only; the raw record stays in the EvidenceStore.
 */
export class DefaultEvidenceRecorder implements EvidenceRecorder {
  private readonly tails = new Map<string, Promise<EvidenceRecord>>();

  public constructor(private readonly options: DefaultEvidenceRecorderOptions) {}

  public capture(request: EvidenceCaptureRequest): Promise<EvidenceRecord> {
    const previous: Promise<unknown> = this.tails.get(request.record.evidenceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.captureOne(request));
    this.tails.set(request.record.evidenceId, current);
    return current.finally(() => {
      if (this.tails.get(request.record.evidenceId) === current) this.tails.delete(request.record.evidenceId);
    });
  }

  private async captureOne(request: EvidenceCaptureRequest): Promise<EvidenceRecord> {
    validateRequest(request);
    if (request.record.toolCallId !== undefined && request.record.toolCallId !== request.toolCallId) {
      throw new Error(`Evidence tool call does not match capture request: ${request.record.evidenceId}`);
    }
    const record: EvidenceRecord = { ...request.record, toolCallId: request.toolCallId };
    await this.options.evidence.save(record);
    const stored = await this.options.evidence.get(record.evidenceId);
    if (stored === null
      || stored.runId !== record.runId
      || stored.source !== record.source
      || stored.toolCallId !== request.toolCallId) {
      throw new Error(`Evidence was not durably readable after capture: ${record.evidenceId}`);
    }
    if (this.options.events === undefined) return stored;

    const eventId = evidenceEventId(stored.evidenceId);
    const existing = await this.options.events.store.findById(eventId);
    if (existing !== null) {
      if (existing.runId !== stored.runId || existing.type !== 'EVIDENCE_COLLECTED') {
        throw new Error(`Evidence event identity collision: ${stored.evidenceId}`);
      }
      return stored;
    }
    const pending = this.options.events.factory.create('EVIDENCE_COLLECTED', {
      runId: stored.runId,
      correlationId: this.options.events.correlationId(stored.runId),
      visibility: 'audit',
      durability: 'durable',
      stepId: request.stepId,
      toolCallId: request.toolCallId,
    }, {
      evidenceIds: [stored.evidenceId],
      coverage: request.coverage,
      source: stored.source,
      summary: request.publicSummary,
    });
    await this.options.events.publisher.publish({ ...pending, eventId, timestamp: stored.capturedAt });
    return stored;
  }
}

function validateRequest(request: EvidenceCaptureRequest): void {
  if (request.stepId.length === 0 || request.toolCallId.length === 0) throw new Error('Evidence capture requires step and tool call IDs');
  if (!Number.isFinite(request.coverage) || request.coverage < 0 || request.coverage > 1) {
    throw new RangeError('Evidence coverage must be between zero and one');
  }
  if (Buffer.byteLength(request.publicSummary, 'utf8') > MAX_PUBLIC_SUMMARY_BYTES) {
    throw new RangeError(`Evidence public summary exceeds ${MAX_PUBLIC_SUMMARY_BYTES} bytes`);
  }
}

function evidenceEventId(evidenceId: string): string {
  return `evidence-${evidenceId}`;
}
