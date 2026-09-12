import { checkpointChecksum } from '../contracts/index.js';
import type { ProfileResolver, ResolvedProfileSnapshot } from '../contracts/index.js';
import type { ChangeFreezePeriod } from '../contracts/index.js';
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

  public async resolve(input: {
    profileId: string;
    capturedAt: string;
    signal: AbortSignal;
  }): Promise<ResolvedProfileSnapshot> {
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
  }
}

function validateDefinition(definition: ProfileDefinition): void {
  if (definition.profileId.length === 0 || definition.revision.length === 0
    || definition.serviceName.length === 0 || definition.policyVersion.length === 0
    || definition.timezone.length === 0) {
    throw new Error('Profile definition contains an empty identity field.');
  }
  const actionNames = [...definition.allowedActions, ...definition.forbiddenActions];
  if (actionNames.some((name) => name.length === 0)) throw new Error('Profile action names must not be empty.');
  if (new Set(definition.allowedActions).size !== definition.allowedActions.length
    || new Set(definition.forbiddenActions).size !== definition.forbiddenActions.length) {
    throw new Error('Profile action names must be unique.');
  }
  if (definition.allowedActions.some((name) => definition.forbiddenActions.includes(name))) {
    throw new Error('Profile action cannot be both allowed and forbidden.');
  }
  const periodIds = new Set<string>();
  const periods = [...definition.changeFreezePeriods].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  for (const period of periods) {
    validateFreezePeriod(period);
    if (periodIds.has(period.id)) throw new Error('Profile freeze period IDs must be unique.');
    periodIds.add(period.id);
  }
  for (let index = 1; index < periods.length; index += 1) {
    const previous = periods[index - 1];
    const current = periods[index];
    if (previous !== undefined && current !== undefined && previous.endsAt > current.startsAt) {
      throw new Error('Profile freeze periods must not overlap.');
    }
  }
}

function validateFreezePeriod(period: ChangeFreezePeriod): void {
  if (period.id.length === 0) throw new Error('Profile freeze period ID must not be empty.');
  const startsAt = Date.parse(period.startsAt);
  const endsAt = Date.parse(period.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt >= endsAt) {
    throw new Error('Profile freeze period must have a valid increasing interval.');
  }
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
