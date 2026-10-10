import type { MemoryScope } from '../contracts/diagnostic-memory.js';
import { parseMemoryScope } from '../contracts/diagnostic-memory-schema.js';
import { canonicalJson } from '../contracts/stable-json.js';

export function memoryScopeKey(scope: MemoryScope): string {
  // Explicit projection keeps incidental host data out of durable scope identity.
  return canonicalJson(parseMemoryScope({
    profileId: scope.profileId,
    profileRevision: scope.profileRevision,
    serviceId: scope.serviceId,
    faultType: scope.faultType,
    targetFingerprint: scope.targetFingerprint,
    environment: scope.environment,
    dataClass: scope.dataClass,
    ...(scope.dataClass === 'simulated' ? { datasetId: scope.datasetId } : {}),
  }));
}

export function sameMemoryScope(left: MemoryScope, right: MemoryScope): boolean {
  return memoryScopeKey(left) === memoryScopeKey(right);
}
