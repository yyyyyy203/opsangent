import type { EvidencePage, EvidenceQueryStore, EvidenceRecord, EvidenceStore } from '../contracts/index.js';
import { InMemoryEvidenceRepository } from './in-memory-durable-state.js';

/** Legacy EvidenceStore name backed by the durable repository contract. */
export class InMemoryEvidenceStore implements EvidenceStore, EvidenceQueryStore {
  public constructor(private readonly repository: InMemoryEvidenceRepository = new InMemoryEvidenceRepository()) {}

  public save(record: EvidenceRecord): Promise<void> {
    return this.repository.save(record);
  }

  public get(evidenceId: string): Promise<EvidenceRecord | null> {
    return this.repository.get(evidenceId);
  }

  public listByRun(runId: string, options?: { cursor?: string; limit?: number }): Promise<EvidencePage> {
    return this.repository.listByRun(runId, options);
  }
}
