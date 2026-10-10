import { z } from 'zod';
import type {
  DiagnosticMemoryCase, MemoryPreferences, MemoryScope, RunMemoryControl, RunMemoryState,
} from './diagnostic-memory.js';

// Match the existing bounded contract identifier convention; never trim scope identity.
const identifier = z.string().min(1).max(256).refine((value) => value.trim().length > 0);
const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/iu);
const revision = z.number().int().positive().safe();
const summary = z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 2 * 1024,
  'Memory summary exceeds its byte budget');
const limitations = z.array(z.string().max(2048)).max(20);
const scopeBase = {
  profileId: identifier,
  profileRevision: identifier,
  serviceId: identifier,
  faultType: identifier,
  targetFingerprint: identifier,
};

export const memoryScopeSchema = z.discriminatedUnion('dataClass', [
  z.object({ ...scopeBase, environment: z.enum(['simulation', 'development', 'staging']),
    dataClass: z.literal('simulated'), datasetId: identifier }).strict(),
  z.object({ ...scopeBase, environment: z.enum(['development', 'staging', 'production']),
    dataClass: z.literal('live') }).strict(),
]);

const evidenceRef = z.object({
  evidenceId: identifier,
  ownerRunId: identifier,
  source: z.enum(['metric', 'log', 'trace', 'change']),
  capturedAt: timestamp,
  rawSha256: sha256,
}).strict();
const evidenceRefs = z.array(evidenceRef).max(20);

const diagnosticMemoryCaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifier,
  revision,
  extractorVersion: z.literal('episodic-v1'),
  scope: memoryScopeSchema,
  sourceRunId: identifier,
  sourceRunStatus: z.enum(['completed', 'failed', 'cancelled']),
  capturedAt: timestamp,
  validUntil: timestamp,
  status: z.enum(['observation', 'approved', 'rejected']),
  quality: z.enum(['sufficient', 'insufficient', 'failed']),
  summary,
  symptomCodes: z.array(identifier).max(20),
  limitations,
  evidenceRefs,
  diagnosisOnly: z.literal(true),
  eligibleForPromotion: z.boolean(),
  digest: sha256,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.validUntil) <= Date.parse(value.capturedAt)) {
    ctx.addIssue({ code: 'custom', message: 'Memory validity must follow capture time' });
  }
  if (value.eligibleForPromotion && (value.scope.dataClass !== 'live' || value.status !== 'approved'
    || value.sourceRunStatus !== 'completed' || value.quality !== 'sufficient')) {
    ctx.addIssue({ code: 'custom', message: 'Memory promotion requires an approved sufficient completed live case' });
  }
  if (value.sourceRunStatus !== 'completed'
    && (value.quality !== 'failed' || value.status === 'approved' || value.eligibleForPromotion)) {
    ctx.addIssue({ code: 'custom', message: 'Failed investigations are archive-only memory' });
  }
  if (value.status === 'approved' && value.quality !== 'sufficient') {
    ctx.addIssue({ code: 'custom', message: 'Approved memory requires sufficient evidence' });
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16 * 1024) {
    ctx.addIssue({ code: 'custom', message: 'Memory case exceeds its byte budget' });
  }
});

const memorySelection = z.object({ memoryId: identifier, revision, digest: sha256 }).strict();
const memoryHint = z.object({
  memoryId: identifier,
  revision,
  digest: sha256,
  sourceRunId: identifier,
  capturedAt: timestamp,
  validUntil: timestamp,
  summary,
  limitations,
  evidenceRefs,
  diagnosisOnly: z.literal(true),
}).strict().refine((value) => Date.parse(value.validUntil) > Date.parse(value.capturedAt),
  'Memory validity must follow capture time');

export const runMemoryControlSchema = z.object({
  schemaVersion: z.literal(1),
  scope: memoryScopeSchema,
  profilePolicyRevision: identifier,
  capture: z.enum(['manual', 'automatic', 'skip']),
  recall: z.boolean(),
}).strict();

export const runMemoryStateSchema = z.object({
  schemaVersion: z.literal(1),
  scope: memoryScopeSchema,
  selectionState: z.enum(['unselected', 'selected']),
  availability: z.enum(['ready', 'empty', 'unavailable']),
  selections: z.array(memorySelection).max(10),
  hints: z.array(memoryHint).max(5),
  selectedAt: timestamp.optional(),
  validatedAt: timestamp.optional(),
  reasonCode: z.enum(['MEMORY_SCOPE_INVALID', 'MEMORY_DATA_INVALID',
    'MEMORY_REVISION_CONFLICT', 'MEMORY_REQUEST_CONFLICT', 'MEMORY_APPROVAL_DENIED',
    'MEMORY_EVIDENCE_UNAVAILABLE', 'MEMORY_SOURCE_CONFLICT', 'MEMORY_RUN_NOT_TERMINAL',
    'MEMORY_POLICY_DENIED', 'MEMORY_CAPACITY_EXCEEDED', 'MEMORY_LOOKUP_FAILED',
    'MEMORY_CAPTURE_FAILED', 'MEMORY_DISABLED']).optional(),
}).strict().superRefine((value, ctx) => {
  const selections = new Map(value.selections.map((selection) => [selection.memoryId, selection]));
  const hintIds = new Set(value.hints.map((hint) => hint.memoryId));
  if (selections.size !== value.selections.length || hintIds.size !== value.hints.length) {
    ctx.addIssue({ code: 'custom', message: 'Memory selections and hints must have unique IDs' });
  }
  for (const hint of value.hints) {
    const selection = selections.get(hint.memoryId);
    if (selection?.revision !== hint.revision || selection.digest !== hint.digest) {
      ctx.addIssue({ code: 'custom', message: 'Memory hint must match its frozen selection' });
    }
  }
  // Bound the persisted hint payload too; the renderer separately enforces its token/window budget.
  if (Buffer.byteLength(JSON.stringify(value.hints), 'utf8') > 4 * 1024) {
    ctx.addIssue({ code: 'custom', message: 'Memory hints exceed their byte budget' });
  }
});

const memoryPreferencesSchema = z.object({
  capture: z.enum(['profile', 'manual', 'automatic', 'skip']).optional(),
  recall: z.enum(['profile', 'enabled', 'disabled']).optional(),
}).strict();

export function parseMemoryScope(value: unknown): MemoryScope {
  return structuredClone(memoryScopeSchema.parse(value));
}

export function parseDiagnosticMemoryCase(value: unknown): DiagnosticMemoryCase {
  return structuredClone(diagnosticMemoryCaseSchema.parse(value));
}

export function parseRunMemoryControl(value: unknown): RunMemoryControl {
  return structuredClone(runMemoryControlSchema.parse(value));
}

export function parseRunMemoryState(value: unknown): RunMemoryState {
  return structuredClone(runMemoryStateSchema.parse(value)) as RunMemoryState;
}

export function parseMemoryPreferences(value: unknown): MemoryPreferences {
  return structuredClone(memoryPreferencesSchema.parse(value)) as MemoryPreferences;
}
