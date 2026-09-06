import type { EvidenceRecord, EvidenceStore } from '../contracts/index.js';

export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly records = new Map<string, EvidenceRecord>();

  public save(record: EvidenceRecord): Promise<void> {
    this.records.set(record.evidenceId, structuredClone(record));
    return Promise.resolve();
  }

  public get(evidenceId: string): Promise<EvidenceRecord | null> {
    const value = this.records.get(evidenceId);
    return Promise.resolve(value === undefined ? null : structuredClone(value));
  }
}
