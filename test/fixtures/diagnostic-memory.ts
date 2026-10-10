import type { DiagnosticMemoryCase, MemoryScope } from '../../src/contracts/diagnostic-memory.js';

export const memoryNow = '2026-10-10T00:00:00.000Z';

export function simulationMemoryScope(): MemoryScope {
  return {
    profileId: 'simulation', profileRevision: 'sim-v1', serviceId: 'settlement',
    faultType: 'settlement_failure', targetFingerprint: 'a'.repeat(64),
    environment: 'simulation', dataClass: 'simulated', datasetId: 'memory-lab-v1',
  };
}

export function memoryCase(overrides: Partial<DiagnosticMemoryCase> = {}): DiagnosticMemoryCase {
  return {
    schemaVersion: 1, id: 'memory-1', revision: 1, extractorVersion: 'episodic-v1',
    scope: simulationMemoryScope(), sourceRunId: 'historical-run-1', sourceRunStatus: 'completed',
    capturedAt: memoryNow, validUntil: '2026-11-09T00:00:00.000Z',
    status: 'observation', quality: 'sufficient', summary: '结算失败率升高，连接池等待增加。',
    symptomCodes: ['SETTLEMENT_FAILURE_HIGH'], limitations: [],
    evidenceRefs: [{ evidenceId: 'evidence-1', ownerRunId: 'historical-run-1',
      source: 'metric', capturedAt: memoryNow, rawSha256: 'b'.repeat(64) }],
    diagnosisOnly: true, eligibleForPromotion: false, digest: 'c'.repeat(64), ...overrides,
  };
}
