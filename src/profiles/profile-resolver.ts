import { checkpointChecksum } from '../contracts/index.js';
import type { ImpactPolicy, ProfileResolver, ResolvedProfileSnapshot } from '../contracts/index.js';
import type { ProfileDefinition } from './profile-types.js';

export { type ProfileDefinition } from './profile-types.js';

/**
 * In-memory versioned Profile registry. It is deliberately synchronous in
 * behavior but retains the async port so a storage-backed resolver can be
 * injected without changing the Harness.
 */
export class StaticProfileResolver implements ProfileResolver {
  private readonly definitions: ReadonlyMap<string, ProfileDefinition>;

  public constructor(definitions: readonly ProfileDefinition[]) {
    const entries = definitions.map((definition) => {
      validateDefinition(definition);
      return [definition.profileId, cloneDefinition(definition)] as const;
    });
    if (new Set(entries.map(([profileId]) => profileId)).size !== entries.length) {
      throw new Error('Duplicate Profile ID.');
    }
    this.definitions = new Map(entries);
  }

  public resolve(input: {
    profileId: string;
    capturedAt: string;
    signal: AbortSignal;
  }): Promise<ResolvedProfileSnapshot> {
    return Promise.resolve().then(() => {
      throwIfAborted(input.signal);
      const definition = this.definitions.get(input.profileId);
      if (definition === undefined) {
        throw structuredError('INVALID_INPUT', 'Profile is not registered.', 'profile_not_found');
      }
      const normalized = cloneDefinition(definition);
      const digest = `sha256:v1:${checkpointChecksum({ algorithm: 'sha256', version: 1, profile: normalized })}`;
      return deepFreeze({
        ...normalized,
        allowedActions: [...normalized.allowedActions],
        forbiddenActions: [...normalized.forbiddenActions],
        changeFreezePeriods: normalized.changeFreezePeriods.map((period) => ({ ...period })),
        digest,
        capturedAt: input.capturedAt,
        source: 'resolved',
      });
    });
  }
}

function validateDefinition(value: unknown): asserts value is ProfileDefinition {
  if (!isRecord(value)) {
    throw invalidProfile('Profile definition contains an invalid identity field.');
  }
  const profileId = value.profileId;
  const revision = value.revision;
  const serviceName = value.serviceName;
  const policyVersion = value.policyVersion;
  const timezone = value.timezone;
  if (!isNonEmptyString(profileId)
    || !isNonEmptyString(revision)
    || !isNonEmptyString(serviceName)
    || !isNonEmptyString(policyVersion)
    || !isNonEmptyString(timezone)) {
    throw invalidProfile('Profile definition contains an invalid identity field.');
  }
  if (!isServiceLevel(value.serviceLevel)) throw invalidProfile('Profile service level is invalid.');
  if (!isValidTimezone(timezone)) throw invalidProfile('Profile timezone is invalid.');
  const allowedActions = value.allowedActions;
  const forbiddenActions = value.forbiddenActions;
  validateStringArray(allowedActions, 'allowed actions');
  validateStringArray(forbiddenActions, 'forbidden actions');
  const changeFreezePeriods = value.changeFreezePeriods;
  if (!isUnknownArray(changeFreezePeriods)) throw invalidProfile('Profile freeze periods must be an array.');
  const impactPolicy = value.impactPolicy;
  if (!isImpactPolicy(impactPolicy)) throw invalidProfile('Profile impact policy is invalid.');
  const actionNames = [...allowedActions, ...forbiddenActions];
  if (actionNames.some((name) => name.trim().length === 0)) throw invalidProfile('Profile action names must not be empty.');
  if (new Set(allowedActions).size !== allowedActions.length
    || new Set(forbiddenActions).size !== forbiddenActions.length) {
    throw invalidProfile('Profile action names must be unique.');
  }
  if (allowedActions.some((name) => forbiddenActions.includes(name))) {
    throw invalidProfile('Profile action cannot be both allowed and forbidden.');
  }
  const periodIds = new Set<string>();
  const periods = changeFreezePeriods.map((period) => {
    const timestamps = validateFreezePeriod(period);
    return timestamps;
  }).sort((left, right) => left.startsAt - right.startsAt);
  for (const period of periods) {
    if (periodIds.has(period.id)) throw invalidProfile('Profile freeze period IDs must be unique.');
    periodIds.add(period.id);
  }
  for (let index = 1; index < periods.length; index += 1) {
    const previous = periods[index - 1];
    const current = periods[index];
    if (previous !== undefined && current !== undefined && previous.endsAt > current.startsAt) {
      throw invalidProfile('Profile freeze periods must not overlap.');
    }
  }
}

function validateFreezePeriod(period: unknown): { id: string; startsAt: number; endsAt: number } {
  if (!isRecord(period) || !isNonEmptyString(period.id)) throw invalidProfile('Profile freeze period ID must not be empty.');
  const startsAt = parseTimestamp(period.startsAt);
  const endsAt = parseTimestamp(period.endsAt);
  if (startsAt === undefined || endsAt === undefined || startsAt >= endsAt) {
    throw invalidProfile('Profile freeze period must have a valid ISO interval.');
  }
  return { id: period.id, startsAt, endsAt };
}

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isServiceLevel(value: unknown): value is ProfileDefinition['serviceLevel'] {
  return value === 'S0' || value === 'S1' || value === 'S2' || value === 'S3';
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function validateStringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    throw invalidProfile(`Profile ${label} must contain non-empty strings.`);
  }
}

function isImpactPolicy(value: unknown): value is ImpactPolicy {
  if (!isRecord(value) || !isRecord(value.unavailable)) return false;
  return value.unavailable.S0 === 'deny'
    && value.unavailable.S1 === 'deny'
    && value.unavailable.S2 === 'confirm'
    && value.unavailable.S3 === 'confirm';
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !isoTimestamp.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function invalidProfile(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'INVALID_INPUT' as const,
    retryable: false,
    details: { category: 'profile_invalid' },
  });
}

function cloneDefinition(definition: ProfileDefinition): ProfileDefinition {
  return {
    ...definition,
    allowedActions: [...definition.allowedActions],
    forbiddenActions: [...definition.forbiddenActions],
    changeFreezePeriods: definition.changeFreezePeriods.map((period) => ({ ...period })),
    impactPolicy: {
      unavailable: { ...definition.impactPolicy.unavailable },
    },
  };
}

function deepFreeze(snapshot: ResolvedProfileSnapshot): ResolvedProfileSnapshot {
  for (const period of snapshot.changeFreezePeriods) Object.freeze(period);
  Object.freeze(snapshot.allowedActions);
  Object.freeze(snapshot.forbiddenActions);
  Object.freeze(snapshot.changeFreezePeriods);
  Object.freeze(snapshot.impactPolicy.unavailable);
  Object.freeze(snapshot.impactPolicy);
  return Object.freeze(snapshot);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw structuredError('ABORTED', 'Profile resolution aborted.', 'aborted');
}

function structuredError(code: 'ABORTED' | 'INVALID_INPUT', message: string, category: string): Error {
  return Object.assign(new Error(message), { code, retryable: false, details: { category } });
}
