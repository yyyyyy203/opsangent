import { describe, expect, it } from 'vitest';
import { SourceCircuitBreaker, ResilientExecutor, SourceFailure } from '../src/mcp/resilience.js';

const options = () => ({ signal: new AbortController().signal, deadline: Date.now() + 5_000 });

describe('source retry and circuit policies', () => {
  it('does not retry before a Retry-After interval exceeding the configured wait cap', async () => {
    let calls = 0;
    const executor = new ResilientExecutor(new SourceCircuitBreaker(), { sleep: () => Promise.resolve() });
    await expect(executor.execute(() => { calls += 1; return Promise.reject(new SourceFailure('MCP_RATE_LIMITED', 10_000)); }, options())).rejects.toMatchObject({ code: 'MCP_RATE_LIMITED' });
    expect(calls).toBe(1);
  });

  it('uses a shared attempt budget without refilling it for another logical call', async () => {
    let calls = 0;
    const budget = { remaining: 1 };
    const executor = new ResilientExecutor(new SourceCircuitBreaker(), { sleep: () => Promise.resolve() });
    await expect(executor.execute(() => { calls += 1; return Promise.reject(new SourceFailure('MCP_NETWORK_ERROR')); }, { ...options(), attemptBudget: budget })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await expect(executor.execute(() => { calls += 1; return Promise.resolve('bad'); }, { ...options(), attemptBudget: budget })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(calls).toBe(1);
  });

  it('does not let an older parallel success close a newly opened circuit', async () => {
    const breaker = new SourceCircuitBreaker({ threshold: 1 });
    const executor = new ResilientExecutor(breaker, { maxRetries: 0 });
    let release: (value: string) => void = () => {};
    const old = executor.execute(() => new Promise<string>((resolve) => { release = resolve; }), options());
    await expect(executor.execute(() => Promise.reject(new SourceFailure('MCP_NETWORK_ERROR')), options())).rejects.toMatchObject({ code: 'MCP_NETWORK_ERROR' });
    release('late success');
    await old;
    expect(breaker.state).toBe('open');
  });

  it('retries transient failures twice and records attempts without retrying business failures', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const executor = new ResilientExecutor(new SourceCircuitBreaker(), { random: () => 1, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } });
    const result = await executor.execute(() => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new SourceFailure('MCP_NETWORK_ERROR'));
      return Promise.resolve('evidence');
    }, options());
    expect(result).toBe('evidence');
    expect(attempts).toBe(3);
    expect(waits).toEqual([200, 400]);
    attempts = 0;
    await expect(executor.execute(() => { attempts += 1; return Promise.reject(new SourceFailure('MCP_AUTH_ERROR')); }, options())).rejects.toMatchObject({ code: 'MCP_AUTH_ERROR' });
    expect(attempts).toBe(1);
  });

  it('opens after source failures and admits only one half-open probe', async () => {
    let now = 0;
    const breaker = new SourceCircuitBreaker({ threshold: 1, cooldownMs: 10, now: () => now });
    const executor = new ResilientExecutor(breaker, { maxRetries: 0, now: () => now });
    await expect(executor.execute(() => Promise.reject(new SourceFailure('MCP_SERVER_ERROR')), { ...options(), deadline: 100 })).rejects.toMatchObject({ code: 'MCP_SERVER_ERROR' });
    expect(breaker.state).toBe('open');
    let calls = 0;
    await expect(executor.execute(() => { calls += 1; return Promise.resolve('bad'); }, { ...options(), deadline: 100 })).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(calls).toBe(0);
    now = 11;
    let release: (value: string) => void = () => { throw new Error('probe not started'); };
    const probe = executor.execute(() => new Promise<string>((resolve) => { release = resolve; }), { ...options(), deadline: 100 });
    await expect(executor.execute(() => Promise.resolve('second'), { ...options(), deadline: 100 })).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    release('healthy');
    expect(await probe).toBe('healthy');
    expect(breaker.state).toBe('closed');
  });

  it('cancels a hung attempt and never starts a retry after parent cancellation', async () => {
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    let attempts = 0;
    const executor = new ResilientExecutor(new SourceCircuitBreaker());
    const result = executor.execute((signal) => { attempts += 1; childSignal = signal; return new Promise<string>(() => {}); }, { ...options(), signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'ABORTED' });
    expect(childSignal?.aborted).toBe(true);
    expect(attempts).toBe(1);
  });

  it('enforces attempt timeout even when the operation ignores AbortSignal', async () => {
    const executor = new ResilientExecutor(new SourceCircuitBreaker(), { timeoutMs: 10, maxRetries: 0 });
    await expect(executor.execute(() => new Promise<string>(() => {}), options())).rejects.toMatchObject({ code: 'MCP_TIMEOUT' });
  });

  it('rejects exhausted deadlines before opening a network operation', async () => {
    let called = false;
    const executor = new ResilientExecutor(new SourceCircuitBreaker(), { now: () => 100 });
    await expect(executor.execute(() => { called = true; return Promise.resolve('bad'); }, { ...options(), deadline: 99 })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(called).toBe(false);
  });
});
