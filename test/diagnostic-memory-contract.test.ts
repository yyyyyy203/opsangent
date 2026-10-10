import { describe, expect, it } from 'vitest';
import type { MemoryHint, RunMemoryState } from '../src/contracts/diagnostic-memory.js';
import {
  parseDiagnosticMemoryCase, parseMemoryPreferences, parseMemoryScope,
  parseRunMemoryControl, parseRunMemoryState,
} from '../src/contracts/diagnostic-memory-schema.js';
import { InMemoryMemoryFacade, MemoryError, memoryScopeKey, sameMemoryScope } from '../src/memory/index.js';
import { parseAgentContext } from '../src/storage/durable-codec.js';
import { memoryCase, memoryNow, simulationMemoryScope } from './fixtures/diagnostic-memory.js';

function contextWithMemory(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: 'run-memory', profileId: 'simulation', status: 'running', stage: 'triage',
    messages: [], pendingToolCalls: [], confirmedToolCallIds: [], rejectedToolCallIds: [],
    executedActions: [], evidenceIds: [], missingEvidence: [], contextVersion: 1,
    budget: { startedAt: memoryNow, maxIterations: 8, iteration: 0,
      maxToolCalls: 16, toolCallsUsed: 0, maxDurationMs: 60_000 },
    ...fields,
  };
}

function control(): Record<string, unknown> {
  return { schemaVersion: 1, scope: simulationMemoryScope(),
    profilePolicyRevision: 'policy-v1', capture: 'manual', recall: false };
}

function state(): Record<string, unknown> {
  return { schemaVersion: 1, scope: simulationMemoryScope(), selectionState: 'unselected',
    availability: 'empty', selections: [], hints: [] };
}

function hint(overrides: Partial<MemoryHint> = {}): MemoryHint {
  const candidate = memoryCase();
  return { memoryId: candidate.id, revision: candidate.revision, digest: candidate.digest,
    sourceRunId: candidate.sourceRunId, capturedAt: candidate.capturedAt, validUntil: candidate.validUntil,
    summary: candidate.summary, limitations: candidate.limitations, evidenceRefs: candidate.evidenceRefs,
    diagnosisOnly: true, ...overrides };
}

function selectedState(hints: MemoryHint[] = [hint()]): RunMemoryState {
  return { schemaVersion: 1, scope: simulationMemoryScope(), selectionState: 'selected', availability: 'ready',
    selections: hints.map(({ memoryId, revision, digest }) => ({ memoryId, revision, digest })),
    hints, selectedAt: memoryNow, validatedAt: memoryNow };
}

describe('strict diagnostic memory contracts', () => {
  it('rejects simulated memory without a dataset boundary', () => {
    const value = { ...simulationMemoryScope(), datasetId: undefined };
    expect(() => parseMemoryScope(value)).toThrow();
  });

  it.each([
    { environment: 'simulation', dataClass: 'live' },
    { environment: 'production', dataClass: 'simulated' },
    { datasetId: '' }, { profileId: '' }, { profileRevision: ' ' },
    { targetFingerprint: 'x'.repeat(257) }, { environment: 'unknown' },
    { tenantId: 'untrusted' },
  ])('rejects invalid or undeclared scope fields: %j', (change) => {
    expect(() => parseMemoryScope({ ...simulationMemoryScope(), ...change })).toThrow();
  });

  it('accepts each allowed environment/data boundary without inventing a dataset for live data', () => {
    for (const environment of ['simulation', 'development', 'staging']) {
      expect(parseMemoryScope({ ...simulationMemoryScope(), environment })).toHaveProperty('datasetId', 'memory-lab-v1');
    }
    const { profileId, profileRevision, serviceId, faultType, targetFingerprint } = simulationMemoryScope();
    const base = { profileId, profileRevision, serviceId, faultType, targetFingerprint };
    for (const environment of ['development', 'staging', 'production']) {
      const live = parseMemoryScope({ ...base, environment, dataClass: 'live' });
      expect(live).not.toHaveProperty('datasetId');
      expect(() => parseMemoryScope({ ...live, datasetId: 'unexpected' })).toThrow();
    }
  });

  it('accepts empty/profile preferences and the explicit capture/recall matrix', () => {
    expect(parseMemoryPreferences({})).toEqual({});
    expect(parseMemoryPreferences({ capture: 'profile', recall: 'profile' })).toEqual({ capture: 'profile', recall: 'profile' });
    for (const capture of ['manual', 'automatic', 'skip']) {
      for (const recall of ['enabled', 'disabled']) expect(parseMemoryPreferences({ capture, recall })).toEqual({ capture, recall });
    }
  });

  it.each([
    { scope: simulationMemoryScope() }, { actorId: 'local-operator' }, { approved: true },
    { memory: state() }, { memoryControl: control() }, { trustedMemoryControl: control() },
    { capture: 'always' }, { recall: true }, { recall: 'on' },
  ])('rejects trusted fields and illegal preference enums: %j', (value) => {
    expect(() => parseMemoryPreferences(value)).toThrow();
  });

  it('round trips control and initial/selected/unavailable recall states independently', () => {
    expect(parseRunMemoryControl(control())).toEqual(control());
    expect(parseRunMemoryState(state())).toEqual(state());
    expect(parseRunMemoryState(selectedState())).toEqual(selectedState());
    const unavailable = { ...selectedState(), availability: 'unavailable', hints: [], reasonCode: 'MEMORY_LOOKUP_FAILED' };
    expect(parseRunMemoryState(unavailable)).toEqual(unavailable);
    for (const capture of ['manual', 'automatic', 'skip']) {
      for (const recall of [false, true]) expect(parseRunMemoryControl({ ...control(), capture, recall })).toMatchObject({ capture, recall });
    }
  });

  it.each([{ schemaVersion: 2 }, { capture: 'profile' }, { recall: 'enabled' },
    { profilePolicyRevision: '' }, { profilePolicyRevision: 'x'.repeat(257) }, { actorId: 'injected' }])('rejects invalid control snapshots: %j', (change) => {
    expect(() => parseRunMemoryControl({ ...control(), ...change })).toThrow();
  });

  it('parses a simulated approved reference without granting promotion', () => {
    expect(parseDiagnosticMemoryCase(memoryCase({ status: 'approved' }))).toMatchObject({ status: 'approved', eligibleForPromotion: false });
    expect(() => parseDiagnosticMemoryCase(memoryCase({ eligibleForPromotion: true }))).toThrow();
  });

  it.each(['failed', 'cancelled'] as const)('archives %s only as failed quality and never approved or promotable', (sourceRunStatus) => {
    expect(parseDiagnosticMemoryCase(memoryCase({ sourceRunStatus, quality: 'failed' }))).toMatchObject({ sourceRunStatus, quality: 'failed', status: 'observation' });
    expect(parseDiagnosticMemoryCase(memoryCase({ sourceRunStatus, quality: 'failed', status: 'rejected' }))).toHaveProperty('status', 'rejected');
    for (const quality of ['sufficient', 'insufficient'] as const) {
      expect(() => parseDiagnosticMemoryCase(memoryCase({ sourceRunStatus, quality }))).toThrow();
    }
    expect(() => parseDiagnosticMemoryCase(memoryCase({ sourceRunStatus, quality: 'failed', status: 'approved' }))).toThrow();
  });

  it('rejects approval of a completed investigation with missing evidence', () => {
    expect(() => parseDiagnosticMemoryCase(memoryCase({ status: 'approved', quality: 'insufficient' }))).toThrow();
  });

  it('permits promotion eligibility only for an approved sufficient completed live case', () => {
    const scope = parseMemoryScope({ profileId: 'live', profileRevision: 'live-v1', serviceId: 'settlement',
      faultType: 'settlement_failure', targetFingerprint: 'live-resource', environment: 'production', dataClass: 'live' });
    expect(parseDiagnosticMemoryCase(memoryCase({ scope, status: 'approved', eligibleForPromotion: true })))
      .toHaveProperty('eligibleForPromotion', true);
    for (const sourceRunStatus of ['failed', 'cancelled'] as const) {
      expect(() => parseDiagnosticMemoryCase(memoryCase({ scope, sourceRunStatus, quality: 'failed', eligibleForPromotion: true }))).toThrow();
    }
    for (const status of ['observation', 'rejected'] as const) {
      expect(() => parseDiagnosticMemoryCase(memoryCase({ scope, status, eligibleForPromotion: true }))).toThrow();
    }
    expect(() => parseDiagnosticMemoryCase(memoryCase({ scope, quality: 'insufficient', eligibleForPromotion: true }))).toThrow();
  });

  it.each([
    { digest: 'invalid' }, { digest: 'z'.repeat(64) }, { revision: 0 }, { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { schemaVersion: 2 }, { diagnosisOnly: false },
    { capturedAt: '2026-10-10T00:00:00' }, { validUntil: '2026-02-30T00:00:00Z' },
    { validUntil: memoryNow }, { capturedAt: 'not-a-time' },
    { summary: 'x'.repeat(2049) }, { summary: '结'.repeat(683) },
    { symptomCodes: Array<string>(21).fill('FAILURE') }, { limitations: Array<string>(21).fill('missing') },
    { evidenceRefs: Array.from({ length: 21 }, (_, index) => ({ ...memoryCase().evidenceRefs[0], evidenceId: `e-${index}` })) },
    { oracle: 'untrusted' },
  ])('rejects malformed or unbounded case data: %j', (change) => {
    expect(() => parseDiagnosticMemoryCase({ ...memoryCase(), ...change })).toThrow();
  });

  it('enforces the case JSON budget as well as individual field limits', () => {
    expect(parseDiagnosticMemoryCase(memoryCase({ summary: 'x'.repeat(2048) }))).toHaveProperty('summary', 'x'.repeat(2048));
    expect(() => parseDiagnosticMemoryCase(memoryCase({ limitations: Array<string>(20).fill('x'.repeat(1000)) }))).toThrow();
  });

  it('rejects invalid or undeclared historical evidence metadata', () => {
    for (const change of [{ rawSha256: 'b'.repeat(63) }, { source: 'oracle' },
      { capturedAt: '2026-10-10' }, { ownerRunId: '' }, { raw: 'secret raw log' }]) {
      expect(() => parseDiagnosticMemoryCase({ ...memoryCase(), evidenceRefs: [{ ...memoryCase().evidenceRefs[0], ...change }] })).toThrow();
    }
  });

  it('rejects malformed recall state and hints outside frozen selections', () => {
    for (const change of [{ schemaVersion: 2 }, { selectionState: 'new' }, { availability: 'unknown' },
      { selectedAt: '2026-10-10' }, { validatedAt: 'invalid' }, { reasonCode: 'RAW_SECRET' }, { extra: true }]) {
      expect(() => parseRunMemoryState({ ...selectedState(), ...change })).toThrow();
    }
    for (const change of [{ digest: 'bad' }, { diagnosisOnly: false }, { raw: 'untrusted' },
      { validUntil: memoryNow }, { memoryId: 'not-selected' }, { revision: 2 }]) {
      expect(() => parseRunMemoryState({ ...selectedState(), hints: [{ ...hint(), ...change }] })).toThrow();
    }
    expect(() => parseRunMemoryState({ ...selectedState(), selections: [{ memoryId: 'memory-1', revision: 0, digest: 'c'.repeat(64) }] })).toThrow();
    expect(() => parseRunMemoryState({ ...selectedState(), selections: [...selectedState().selections, ...selectedState().selections] })).toThrow();
  });

  it('rejects hint snapshots beyond five hints or the 4 KiB snapshot budget', () => {
    expect(() => parseRunMemoryState(selectedState(Array.from({ length: 6 }, (_, index) => hint({ memoryId: `memory-${index}` }))))).toThrow();
    expect(() => parseRunMemoryState(selectedState([hint({ summary: 'x'.repeat(2048) }), hint({ memoryId: 'memory-2', summary: 'x'.repeat(2048) })]))).toThrow();
    expect(parseRunMemoryState(selectedState(Array.from({ length: 5 }, (_, index) => hint({ memoryId: `memory-${index}` }))))).toHaveProperty('hints.length', 5);
  });

  it('compares precisely the declared complete scope independent of object order or extra data', () => {
    const scope = simulationMemoryScope();
    const shuffled = { datasetId: 'memory-lab-v1', dataClass: 'simulated', environment: 'simulation',
      targetFingerprint: 'a'.repeat(64), faultType: 'settlement_failure', serviceId: 'settlement',
      profileRevision: 'sim-v1', profileId: 'simulation' } as const;
    expect(memoryScopeKey(scope)).toBe('{"dataClass":"simulated","datasetId":"memory-lab-v1","environment":"simulation","faultType":"settlement_failure","profileId":"simulation","profileRevision":"sim-v1","serviceId":"settlement","targetFingerprint":"' + 'a'.repeat(64) + '"}');
    expect(sameMemoryScope(scope, shuffled)).toBe(true);
    const extendedScope = { ...scope, untrusted: 'ignored' };
    expect(memoryScopeKey(extendedScope)).toBe(memoryScopeKey(scope));
    for (const field of ['profileId', 'profileRevision', 'serviceId', 'faultType', 'targetFingerprint', 'datasetId'] as const) {
      expect(sameMemoryScope(scope, { ...shuffled, [field]: 'different' })).toBe(false);
    }
    expect(sameMemoryScope(scope, { ...shuffled, environment: 'development' })).toBe(false);
    const live = parseMemoryScope({ profileId: 'simulation', profileRevision: 'sim-v1', serviceId: 'settlement',
      faultType: 'settlement_failure', targetFingerprint: 'a'.repeat(64), environment: 'development', dataClass: 'live' });
    expect(sameMemoryScope(live, { ...shuffled, environment: 'development' })).toBe(false);
    expect(memoryScopeKey(live)).not.toContain('datasetId');
  });

  it('exposes fixed safe errors without carrying an underlying exception', () => {
    const codes = ['MEMORY_SCOPE_INVALID', 'MEMORY_DATA_INVALID', 'MEMORY_REVISION_CONFLICT',
      'MEMORY_REQUEST_CONFLICT', 'MEMORY_APPROVAL_DENIED', 'MEMORY_EVIDENCE_UNAVAILABLE',
      'MEMORY_SOURCE_CONFLICT', 'MEMORY_RUN_NOT_TERMINAL', 'MEMORY_POLICY_DENIED',
      'MEMORY_CAPACITY_EXCEEDED', 'MEMORY_LOOKUP_FAILED', 'MEMORY_CAPTURE_FAILED', 'MEMORY_DISABLED'] as const;
    for (const code of codes) {
      const error = new MemoryError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.name).toBe('MemoryError');
      expect(error.message).toBe(new MemoryError(code).message);
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('details');
    }
    const error = Reflect.construct(MemoryError, ['MEMORY_LOOKUP_FAILED', new Error('Authorization: secret; internal-host')]) as MemoryError;
    expect(String(error)).not.toMatch(/secret|internal-host|Authorization/u);
    expect(error).not.toHaveProperty('cause');
  });

  it('keeps the existing in-memory MemoryFacade exported and compatible', async () => {
    const facade = new InMemoryMemoryFacade();
    await facade.saveWorking('run-1', { facts: ['settlement'] });
    await facade.recordCase({ summary: 'settlement failed' });
    await facade.proposeExperience({ summary: 'inspect settlement' });
    expect(await facade.recall({ profileId: 'simulation', text: 'settlement', limit: 5 })).toEqual([]);
  });
});

describe('diagnostic memory checkpoint boundary', () => {
  it('preserves manual capture control when recall is disabled and no recall snapshot exists', () => {
    const parsed = parseAgentContext(contextWithMemory({ memoryControl: control() }));
    expect(parsed).toHaveProperty('memoryControl', control());
    expect(parsed).not.toHaveProperty('memory');
  });

  it('round trips a recall snapshot without rewriting its trusted scope', () => {
    const parsed = parseAgentContext(contextWithMemory({ memoryControl: control(), memory: state() }));
    expect(parsed).toHaveProperty('memory', state());
    expect(parsed).toHaveProperty('memoryControl.scope.datasetId', 'memory-lab-v1');
  });

  it('rejects a simulated checkpoint with no dataset boundary', () => {
    expect(() => parseAgentContext(contextWithMemory({ memoryControl: {
      ...control(), scope: { ...simulationMemoryScope(), datasetId: undefined },
    } }))).toThrow();
  });

  it('rejects unknown control fields and malformed hint digests', () => {
    expect(() => parseAgentContext(contextWithMemory({ memoryControl: { ...control(), actorId: 'untrusted' } }))).toThrow();
    const candidate = memoryCase();
    expect(() => parseAgentContext(contextWithMemory({ memory: {
      ...state(), selectionState: 'selected', availability: 'ready',
      selections: [{ memoryId: candidate.id, revision: 1, digest: candidate.digest }],
      hints: [{ memoryId: candidate.id, revision: 1, digest: 'invalid', sourceRunId: candidate.sourceRunId,
        capturedAt: candidate.capturedAt, validUntil: candidate.validUntil, summary: candidate.summary,
        limitations: [], evidenceRefs: candidate.evidenceRefs, diagnosisOnly: true }],
    } }))).toThrow();
  });
});
