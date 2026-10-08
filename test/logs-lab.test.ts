import { describe, expect, it } from 'vitest';
import { startLogsLab } from '../src/bootstrap/logs-lab.js';
import { logsLabStatusReply } from '../src/infrastructure/simulator/logs-lab-status-server.js';
import type { SettlementSimulator } from '../src/infrastructure/simulator/settlement-simulator.js';
import type { SettlementSnapshot } from '../src/infrastructure/prometheus/settlement-source.js';

const clock = 1_790_985_900_000;
const options = {
  elasticsearchUrl: 'http://127.0.0.1:19200', prometheusUrl: 'http://127.0.0.1:19290',
  cursorSecret: '0123456789abcdef0123456789abcdef', initialScenario: 'settlement_failure' as const,
  now: () => clock, id: () => 'fixture-1', metricsPort: 0, metricsMcpPort: 0, logsMcpPort: 0, statusPort: 0,
};

function fakeServices(failAt?: string, metricsResponses?: SettlementSnapshot[]) {
  const events: string[] = [];
  let simulator: SettlementSimulator | undefined;
  let seededCount = 0;
  const start = (name: string, result: { url: string }) => () => {
    events.push(`start:${name}`);
    if (failAt === name) return Promise.reject(new Error(`FAIL_${name}`));
    return Promise.resolve({ ...result, close: () => { events.push(`close:${name}`); return Promise.resolve(); } });
  };
  return {
    events,
    get simulator() { return simulator; },
    get seededCount() { return seededCount; },
    dependencies: {
      startMetrics: (value: SettlementSimulator) => {
        simulator = value;
        events.push('start:metrics');
        if (failAt === 'metrics') return Promise.reject(new Error('FAIL_metrics'));
        return Promise.resolve({ port: 19208, close: () => { events.push('close:metrics'); return Promise.resolve(); } });
      },
      writeFixture: async (input: { records: AsyncIterable<{ timestamp: string }>; index: string; signal: AbortSignal }) => {
        events.push('start:fixture');
        if (failAt === 'fixture') throw new Error('FAIL_fixture');
        expect(input.index).toBe('agentops-lab-logs-fixture-1');
        for await (const record of input.records) {
          expect(record.timestamp).toBeTruthy();
          seededCount++;
        }
        return { recordCount: seededCount };
      },
      createMetricsSource: () => ({ query: (): Promise<SettlementSnapshot> => {
        events.push('query:metrics');
        const snapshot = simulator!.currentSnapshot();
        return Promise.resolve(metricsResponses?.shift() ?? {
          status: 'available', start: snapshot.start, end: snapshot.end,
          counts: { total: snapshot.success + snapshot.failure, failed: snapshot.failure }, raw: {},
        });
      } }),
      startMetricsMcp: start('metricsMcp', { url: 'http://127.0.0.1:19210/mcp' }),
      startLogsMcp: start('logsMcp', { url: 'http://127.0.0.1:19211/mcp' }),
      startStatus: start('status', { url: 'http://127.0.0.1:19209/status' }),
    },
  };
}

describe('logs lab lifecycle', () => {
  it('seeds from exactly the immutable metrics snapshot before exposing ready, then closes once in reverse order', async () => {
    const fake = fakeServices();
    const lab = await startLogsLab({ ...options, dependencies: fake.dependencies });
    expect(fake.simulator?.currentSnapshot()).toMatchObject({ success: 85, failure: 15 });
    expect(fake.seededCount).toBe(100);
    expect(fake.events).toEqual(['start:metrics', 'start:fixture', 'query:metrics', 'start:metricsMcp', 'start:logsMcp', 'start:status']);
    expect(lab).toMatchObject({
      metricsMcpUrl: 'http://127.0.0.1:19210/mcp', logsMcpUrl: 'http://127.0.0.1:19211/mcp',
      statusUrl: 'http://127.0.0.1:19209/status', scenario: 'settlement_failure', snapshotId: 'fixture-1',
      sourceWindow: {
        start: new Date(clock - 300_000).toISOString(),
        end: new Date(clock).toISOString(),
      },
    });
    await lab.close();
    await lab.close();
    expect(fake.events.slice(6)).toEqual(['close:status', 'close:logsMcp', 'close:metricsMcp', 'close:metrics']);
  });

  it.each([
    ['metrics', []],
    ['fixture', ['close:metrics']],
    ['metricsMcp', ['close:metrics']],
    ['logsMcp', ['close:metricsMcp', 'close:metrics']],
    ['status', ['close:logsMcp', 'close:metricsMcp', 'close:metrics']],
  ] as const)('rolls back only local resources when %s fails', async (failAt, expectedClose) => {
    const fake = fakeServices(failAt);
    await expect(startLogsLab({ ...options, dependencies: fake.dependencies })).rejects.toThrow(`FAIL_${failAt}`);
    expect(fake.events.filter((event) => event.startsWith('close:'))).toEqual(expectedClose);
  });

  it('does not expose MCP or ready when the snapshot expires during seeding', async () => {
    let nowMs = clock;
    const fake = fakeServices();
    const originalWriter = fake.dependencies.writeFixture;
    fake.dependencies.writeFixture = async (input) => {
      const result = await originalWriter(input);
      nowMs += 121_000;
      return result;
    };
    await expect(startLogsLab({ ...options, now: () => nowMs, dependencies: fake.dependencies }))
      .rejects.toThrow('LAB_SNAPSHOT_STALE');
    expect(fake.events).toEqual(['start:metrics', 'start:fixture', 'close:metrics']);
  });

  it('waits for the exact Prometheus window and counts before publishing ready', async () => {
    const exact = { status: 'available' as const, start: 1_790_985_600, end: 1_790_985_900,
      counts: { total: 100, failed: 15 }, raw: {} };
    const fake = fakeServices(undefined, [
      { status: 'unavailable', reason: 'missing_series' },
      { ...exact, start: exact.start - 1, end: exact.end - 1 },
      { ...exact, counts: { total: 100, failed: 14 } },
      exact,
    ]);
    const lab = await startLogsLab({ ...options, startupTimeoutMs: 500, dependencies: fake.dependencies });
    expect(fake.events.filter((event) => event === 'query:metrics')).toHaveLength(4);
    expect(fake.events.indexOf('start:status')).toBeGreaterThan(fake.events.lastIndexOf('query:metrics'));
    await lab.close();
  });

  it('times out without publishing ready when no exact metric snapshot arrives', async () => {
    const fake = fakeServices(undefined, Array.from({ length: 100 }, () => ({ status: 'unavailable' as const, reason: 'missing_series' as const })));
    await expect(startLogsLab({ ...options, startupTimeoutMs: 30, dependencies: fake.dependencies }))
      .rejects.toThrow('LAB_STARTUP_TIMEOUT');
    expect(fake.events.filter((event) => event.startsWith('close:'))).toEqual(['close:metrics']);
    expect(fake.events).not.toContain('start:status');
  });

  it('bounds a metric query that never settles', async () => {
    const fake = fakeServices();
    fake.dependencies.createMetricsSource = () => ({ query: () => new Promise<SettlementSnapshot>(() => undefined) });
    const result = await Promise.race([
      startLogsLab({ ...options, startupTimeoutMs: 30, dependencies: fake.dependencies })
        .then(() => 'unexpected-ready', (error: unknown) => error instanceof Error ? error.message : 'unknown'),
      new Promise<string>((resolve) => setTimeout(() => resolve('did-not-time-out'), 250)),
    ]);
    expect(result).toBe('LAB_STARTUP_TIMEOUT');
    expect(fake.events.filter((event) => event.startsWith('close:'))).toEqual(['close:metrics']);
  });

  it('aborts stalled fixture seeding and closes only the started metrics server', async () => {
    const fake = fakeServices();
    fake.dependencies.writeFixture = (input: { signal: AbortSignal }) => new Promise<{ recordCount: number }>((_, reject) => {
      fake.events.push('start:fixture');
      input.signal.addEventListener('abort', () => { fake.events.push('abort:fixture'); reject(new Error('FIXTURE_ABORTED')); }, { once: true });
    });
    const result = await Promise.race([
      startLogsLab({ ...options, startupTimeoutMs: 30, dependencies: fake.dependencies })
        .then(() => 'unexpected-ready', (error: unknown) => error instanceof Error ? error.message : 'unknown'),
      new Promise<string>((resolve) => setTimeout(() => resolve('did-not-time-out'), 250)),
    ]);
    expect(result).toBe('LAB_STARTUP_TIMEOUT');
    expect(fake.events).toEqual(['start:metrics', 'start:fixture', 'abort:fixture', 'close:metrics']);
  });

  it('rejects hot switching and reports expired evidence as stale', () => {
    const state = { scenario: 'low_sample' as const, snapshotId: 'fixture-1', expiresAt: clock + 120_000, ready: true };
    expect(logsLabStatusReply('GET', '/status', state, clock)).toMatchObject({ statusCode: 200, body: { readiness: 'ready', scenario: 'low_sample', snapshotId: 'fixture-1' } });
    expect(logsLabStatusReply('GET', '/status', state, clock + 120_001)).toMatchObject({ statusCode: 200, body: { readiness: 'stale' } });
    expect(logsLabStatusReply('PUT', '/status', state, clock).statusCode).toBe(405);
    expect(logsLabStatusReply('POST', '/scenario', state, clock).statusCode).toBe(404);
    expect(logsLabStatusReply('GET', '/status', { ...state, ready: false }, clock)).toMatchObject({ body: { readiness: 'unavailable' } });
  });
});
