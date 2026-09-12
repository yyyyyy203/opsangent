import { describe, expect, it } from 'vitest';
import type { ImpactPolicy } from '../src/contracts/index.js';
import { StaticProfileResolver, type ProfileDefinition } from '../src/profiles/profile-resolver.js';

const impactPolicy: ImpactPolicy = {
  unavailable: { S0: 'deny', S1: 'deny', S2: 'confirm', S3: 'confirm' },
};

function definition(overrides: Partial<ProfileDefinition> = {}): ProfileDefinition {
  return {
    profileId: 'group-buy-market',
    revision: 'profile/v1',
    serviceName: 'settlement',
    serviceLevel: 'S1',
    timezone: 'Asia/Shanghai',
    allowedActions: ['action.drain'],
    forbiddenActions: ['action.drop'],
    changeFreezePeriods: [],
    impactPolicy,
    policyVersion: 'risk/v2',
    ...overrides,
  };
}

describe('StaticProfileResolver', () => {
  it('returns a versioned immutable snapshot with a stable digest', async () => {
    const resolver = new StaticProfileResolver([definition()]);

    const snapshot = await resolver.resolve({
      profileId: 'group-buy-market',
      capturedAt: '2026-09-12T00:00:00.000Z',
      signal: new AbortController().signal,
    });

    expect(snapshot).toMatchObject({
      profileId: 'group-buy-market',
      revision: 'profile/v1',
      source: 'resolved',
      capturedAt: '2026-09-12T00:00:00.000Z',
    });
    expect(snapshot.digest).toMatch(/^sha256:v1:[a-f0-9]{64}$/);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.allowedActions)).toBe(true);
  });

  it('does not expose mutable registry state through repeated resolutions', async () => {
    const resolver = new StaticProfileResolver([definition()]);
    const first = await resolver.resolve({
      profileId: 'group-buy-market',
      capturedAt: '2026-09-12T00:00:00.000Z',
      signal: new AbortController().signal,
    });

    expect(() => first.allowedActions.push('action.fake')).toThrow();
    const second = await resolver.resolve({
      profileId: 'group-buy-market',
      capturedAt: '2026-09-12T00:01:00.000Z',
      signal: new AbortController().signal,
    });
    expect(second.allowedActions).toEqual(['action.drain']);
    expect(second.digest).toBe(first.digest);
  });

  it('fails closed when the requested Profile is missing', async () => {
    const resolver = new StaticProfileResolver([definition()]);

    await expect(resolver.resolve({
      profileId: 'missing',
      capturedAt: '2026-09-12T00:00:00.000Z',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { category: 'profile_not_found' },
    });
  });

  it('rejects malformed change-freeze periods during construction', () => {
    expect(() => new StaticProfileResolver([definition({
      changeFreezePeriods: [{
        id: 'freeze-1',
        startsAt: '2026-09-12T01:00:00.000Z',
        endsAt: '2026-09-12T00:00:00.000Z',
      }],
    })])).toThrow();
  });

  it('rejects duplicate Profile IDs with the stable input error shape', () => {
    try {
      new StaticProfileResolver([definition(), definition()]);
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_INPUT', details: { category: 'profile_invalid' } });
      return;
    }
    throw new Error('Expected duplicate Profile IDs to be rejected.');
  });

  it('rejects invalid runtime Profile fields with a stable error shape', () => {
    expectInvalid(definition({ serviceLevel: 'S4' as ProfileDefinition['serviceLevel'] }));
    expectInvalid(definition({ timezone: 'Mars/Olympus' }));
    expectInvalid(definition({ changeFreezePeriods: [{
      id: 'freeze-1', startsAt: '2026-09-12', endsAt: '2026-09-13T00:00:00.000Z',
    }] }));
  });

  it('orders freeze periods by instant and rejects overlaps across timezone offsets', () => {
    expectInvalid(definition({ changeFreezePeriods: [
      { id: 'freeze-a', startsAt: '2026-09-12T00:30:00+01:00', endsAt: '2026-09-12T01:00:00+01:00' },
      { id: 'freeze-b', startsAt: '2026-09-11T23:45:00Z', endsAt: '2026-09-12T00:15:00Z' },
    ] }));
  });

  it('propagates an already aborted signal before resolving', async () => {
    const resolver = new StaticProfileResolver([definition()]);

    await expect(resolver.resolve({
      profileId: 'group-buy-market',
      capturedAt: '2026-09-12T00:00:00.000Z',
      signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

function expectInvalid(value: ProfileDefinition): void {
  try {
    new StaticProfileResolver([value]);
  } catch (error) {
    expect(error).toMatchObject({ code: 'INVALID_INPUT', details: { category: 'profile_invalid' } });
    return;
  }
  throw new Error('Expected invalid Profile definition to be rejected.');
}
