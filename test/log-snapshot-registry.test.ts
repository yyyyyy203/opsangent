import { describe, expect, it } from 'vitest';
import { SourceFailure } from '../src/mcp/resilience.js';
import { LogSnapshotRegistry } from '../src/infrastructure/elk/log-snapshot-registry.js';

const secret = '0123456789abcdef0123456789abcdef';

describe('LogSnapshotRegistry', () => {
  it('fails closed at history capacity without evicting a retryable tombstone', () => {
    let next = 0;
    const registry = new LogSnapshotRegistry({
      cursorSecret: secret, now: () => 1_000, id: () => `snapshot-${++next}`,
      maxSessions: 1, maxRequestHistory: 3,
    });
    for (let index = 1; index <= 3; index++) {
      const session = registry.createSession({ requestId: `request-${index}`, queryDigest: 'query', pitId: `pit-${index}` });
      registry.markClosed(session);
    }
    expect(() => registry.createSession({ requestId: 'request-4', queryDigest: 'query', pitId: 'pit-4' }))
      .toThrowError(new SourceFailure('MCP_RATE_LIMITED'));
    expect(() => registry.findByRequest('request-1', 'query'))
      .toThrowError(new SourceFailure('UNAVAILABLE'));
    expect(() => registry.createSession({ requestId: 'request-1', queryDigest: 'query', pitId: 'replacement' }))
      .toThrowError(new SourceFailure('UNAVAILABLE'));
  });

  it('retains tombstones through the inclusive 150-second query freshness horizon', () => {
    let clock = 0;
    let next = 0;
    const registry = new LogSnapshotRegistry({
      cursorSecret: secret, now: () => clock, id: () => `snapshot-${++next}`,
      maxSessions: 1, maxRequestHistory: 1, ttlMs: 100,
    });
    registry.markClosed(registry.createSession({ requestId: 'old', queryDigest: 'query', pitId: 'old-pit' }));
    clock = 150_000;
    registry.expire();
    expect(() => registry.createSession({ requestId: 'new', queryDigest: 'query', pitId: 'new-pit' }))
      .toThrowError(new SourceFailure('MCP_RATE_LIMITED'));
    clock += 1;
    expect(registry.createSession({ requestId: 'new', queryDigest: 'query', pitId: 'new-pit' })).toMatchObject({ requestId: 'new' });
  });

  it('does not evict an in-flight open from bounded request history', () => {
    const registry = new LogSnapshotRegistry({ cursorSecret: secret, maxSessions: 2, maxRequestHistory: 2 });
    registry.reserveOpening({ requestId: 'opening', queryDigest: 'query' });
    registry.reserveOpening({ requestId: 'failed', queryDigest: 'query' });
    registry.failOpening('failed');
    expect(() => registry.reserveOpening({ requestId: 'new', queryDigest: 'query' }))
      .toThrowError(new SourceFailure('MCP_RATE_LIMITED'));
    expect(registry.createSession({ requestId: 'opening', queryDigest: 'query', pitId: 'known-pit' }))
      .toMatchObject({ requestId: 'opening', pitId: 'known-pit' });
  });

  it('rejects a new opening whose query retention deadline already passed', () => {
    const registry = new LogSnapshotRegistry({ cursorSecret: secret, now: () => 1_001 });
    expect(() => registry.reserveOpening({ requestId: 'late', queryDigest: 'query', retainUntil: 1_000 }))
      .toThrowError(new SourceFailure('UNAVAILABLE'));
  });

  it('keeps interleaved logical snapshots stable while rotating private PIT IDs', () => {
    let next = 0;
    const registry = new LogSnapshotRegistry({
      cursorSecret: secret,
      now: () => 1_000,
      id: () => `snapshot-${++next}`,
    });
    const first = registry.createSession({ requestId: 'request-1', queryDigest: 'digest-1', pitId: 'pit-1' });
    const second = registry.createSession({ requestId: 'request-2', queryDigest: 'digest-2', pitId: 'pit-2' });

    registry.updatePitId(first, 'pit-1-rotated');

    expect(registry.findByRequest('request-1', 'digest-1')).toMatchObject({ snapshotId: 'snapshot-1', pitId: 'pit-1-rotated' });
    expect(registry.findByRequest('request-2', 'digest-2')).toMatchObject({ snapshotId: 'snapshot-2', pitId: 'pit-2' });
    expect(first.snapshotId).not.toBe(first.pitId);
    expect(second.snapshotId).not.toBe(second.pitId);
  });

  it('binds opaque cursors to the logical snapshot and query and rejects tampering', () => {
    const registry = new LogSnapshotRegistry({ cursorSecret: secret, now: () => 1_000, id: () => 'snapshot-1' });
    const session = registry.createSession({ requestId: 'request-1', queryDigest: 'digest-1', pitId: 'pit-private' });
    const cursor = registry.createCursor(session, ['2026-10-03T00:00:01Z', 7]);

    expect(cursor).not.toContain('pit-private');
    expect(registry.resolveCursor(session.snapshotId, 'digest-1', cursor))
      .toEqual(['2026-10-03T00:00:01Z', 7]);
    expect(() => registry.resolveCursor('other-snapshot', 'digest-1', cursor))
      .toThrowError(SourceFailure);
    expect(() => registry.resolveCursor(session.snapshotId, 'other-query', cursor))
      .toThrowError(SourceFailure);
    expect(() => registry.resolveCursor(session.snapshotId, 'digest-1', cursor.slice(0, -1) + 'x'))
      .toThrowError(SourceFailure);
  });

  it('caches only the first and most recent input cursor page and returns defensive copies', () => {
    const registry = new LogSnapshotRegistry({ cursorSecret: secret, now: () => 1_000, id: () => 'snapshot-1' });
    const session = registry.createSession({ requestId: 'request-1', queryDigest: 'digest-1', pitId: 'pit-1' });
    const first = { status: 'available' as const, records: [], sourceSnapshotId: session.snapshotId };
    const pageTwo = { status: 'available' as const, records: [], sourceSnapshotId: session.snapshotId, nextCursor: 'cursor-3' };
    const pageThree = { status: 'available' as const, records: [], sourceSnapshotId: session.snapshotId };

    registry.cachePage(session, undefined, first);
    registry.cachePage(session, 'cursor-2', pageTwo);
    registry.cachePage(session, 'cursor-3', pageThree);

    expect(registry.getCachedPage(session, undefined)).toEqual(first);
    expect(registry.getCachedPage(session, 'cursor-2')).toBeUndefined();
    const cached = registry.getCachedPage(session, 'cursor-3');
    expect(cached).toEqual(pageThree);
    if (cached?.status === 'available') cached.records.push({ timestamp: '2026-10-03T00:00:00Z' });
    expect(registry.getCachedPage(session, 'cursor-3')).toEqual(pageThree);
  });

  it('expires snapshots and enforces the active session limit', () => {
    let now = 0;
    const registry = new LogSnapshotRegistry({ cursorSecret: secret, now: () => now, id: () => 'snapshot-1', maxSessions: 1, ttlMs: 100 });
    const first = registry.createSession({ requestId: 'request-1', queryDigest: 'digest-1', pitId: 'pit-1' });
    expect(() => registry.createSession({ requestId: 'request-2', queryDigest: 'digest-2', pitId: 'pit-2' }))
      .toThrowError(SourceFailure);

    now = 101;
    expect(registry.expire()).toEqual([first]);
    expect(() => registry.findByRequest('request-1', 'digest-1')).toThrowError(SourceFailure);
  });

  it('allows sequential closed snapshots while bounding retained replay sessions', () => {
    let nextId = 0;
    const registry = new LogSnapshotRegistry({
      cursorSecret: secret,
      now: () => 1_000,
      id: () => `snapshot-${++nextId}`,
      maxSessions: 1,
    });
    const first = registry.createSession({ requestId: 'request-1', queryDigest: 'digest-1', pitId: 'pit-1' });
    registry.markClosed(first);

    const second = registry.createSession({ requestId: 'request-2', queryDigest: 'digest-2', pitId: 'pit-2' });
    registry.markClosed(second);
    const third = registry.createSession({ requestId: 'request-3', queryDigest: 'digest-3', pitId: 'pit-3' });

    expect(() => registry.findByRequest('request-1', 'digest-1')).toThrowError(SourceFailure);
    expect(registry.findByRequest('request-2', 'digest-2')).toBe(second);
    expect(registry.findByRequest('request-3', 'digest-3')).toBe(third);
  });
});
