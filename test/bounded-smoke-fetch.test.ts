import { describe, expect, it } from 'vitest';
import { createOpenAICompatibleModel } from '../src/bootstrap/openai-compatible.js';
import { RetryingChatModel } from '../src/model/retrying-model.js';
import { SmokeRequestBudget } from '../src/model/smoke-request-budget.js';
import { createBoundedSmokeFetch } from './fixtures/bounded-smoke-fetch.js';

const COMPLETIONS_URL = 'https://models.invalid/v1/chat/completions';

function fakeFetch() {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push({ input, ...(init === undefined ? {} : { init }) });
    return Promise.resolve(new Response('ok', { status: 200 }));
  };
  return { fetch, calls };
}

describe('bounded smoke fetch', () => {
  it('rewrites only the output cap while preserving JSON, headers, and request options', async () => {
    const transport = fakeFetch();
    const attempts: number[] = [];
    const wrapper = createBoundedSmokeFetch({
      fetch: transport.fetch, limit: 10, maxOutputTokens: 512, onAttempt: (count) => attempts.push(count),
    });
    const signal = new AbortController().signal;
    const body = JSON.stringify({
      model: 'test-model', stream: true, max_tokens: 4096, max_completion_tokens: 8192,
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [{ type: 'function', function: { name: 'read_logs', parameters: { type: 'object' } } }],
      stream_options: { include_usage: true }, custom: { unchanged: true },
    });
    const headers = new Headers({ authorization: 'Bearer test-secret', 'x-run-id': 'run-1' });

    const response = await wrapper(`${COMPLETIONS_URL}?trace=one`, { method: 'POST', headers, body, signal, cache: 'no-store' });

    expect(response.status).toBe(200);
    expect(attempts).toEqual([1]);
    expect(transport.calls).toHaveLength(1);
    const forwarded = transport.calls[0];
    expect(forwarded).toBeDefined();
    const sent = new Request(forwarded!.input, forwarded!.init);
    expect(sent.url).toBe(`${COMPLETIONS_URL}?trace=one`);
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('authorization')).toBe('Bearer test-secret');
    expect(sent.headers.get('x-run-id')).toBe('run-1');
    expect(sent.signal.aborted).toBe(signal.aborted);
    expect(sent.cache).toBe('no-store');
    expect(JSON.parse(await sent.text())).toEqual({
      model: 'test-model', stream: true, max_tokens: 512,
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [{ type: 'function', function: { name: 'read_logs', parameters: { type: 'object' } } }],
      stream_options: { include_usage: true }, custom: { unchanged: true },
    });
    expect(JSON.parse(body)).toHaveProperty('max_completion_tokens', 8192);
  });

  it('uses one counter across callers and blocks attempt 11 before transport', async () => {
    const transport = fakeFetch();
    const attempts: number[] = [];
    const wrapper = createBoundedSmokeFetch({
      fetch: transport.fetch, limit: 10, maxOutputTokens: 512, onAttempt: (count) => attempts.push(count),
    });
    const parent = wrapper;
    const child = wrapper;
    const request = { method: 'POST', body: '{"model":"test-model","stream":true}' };

    for (let count = 1; count <= 10; count += 1) {
      const response = await (count % 2 === 0 ? child : parent)(COMPLETIONS_URL, request);
      expect(response.status).toBe(200);
    }
    const blocked = await child(COMPLETIONS_URL, request);

    expect(blocked.status).toBe(402);
    expect(transport.calls).toHaveLength(10);
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(await blocked.text()).not.toMatch(/test-model|Bearer|secret|chat\/completions/);
  });

  it('reserves the shared request ledger before concurrent requests reach transport', async () => {
    const transport = fakeFetch();
    const budget = new SmokeRequestBudget(10);
    const wrapper = createBoundedSmokeFetch({
      fetch: transport.fetch, budget, limit: 10, maxOutputTokens: 512, onAttempt: () => undefined,
    });
    const responses = await Promise.all(Array.from({ length: 11 }, () => wrapper(COMPLETIONS_URL, {
      method: 'POST', body: JSON.stringify({ model: 'test-model', max_tokens: 4096 }),
    })));

    expect(transport.calls).toHaveLength(10);
    expect(responses.filter((response) => response.status === 402)).toHaveLength(1);
    expect(budget.snapshot()).toEqual({ limit: 10, attempted: 11, sent: 10, rejected: 1 });
  });

  it('stops the model retry pipeline when the local request cap returns 402', async () => {
    const transport = fakeFetch();
    const attempts: number[] = [];
    const bounded = createBoundedSmokeFetch({
      fetch: async (input, init) => {
        await transport.fetch(input, init);
        return Response.json({ error: { code: 'temporary_failure' } }, { status: 503 });
      },
      limit: 1, maxOutputTokens: 512, onAttempt: (count) => attempts.push(count),
    });
    const model = new RetryingChatModel(createOpenAICompatibleModel({
      baseUrl: 'https://models.invalid/v1', apiKey: 'test-key', model: 'test-model', fetch: bounded,
    }), { maxAttempts: 4, sleep: () => Promise.resolve() });

    await expect(model.stream([], [], {
      runId: 'run-1', stepId: 'step-1', signal: new AbortController().signal,
    }).next()).rejects.toMatchObject({ disposition: 'terminal', details: { status: 402 } });
    expect(attempts).toEqual([1, 2]);
    expect(transport.calls).toHaveLength(1);
  });

  it('reads a Request body and retains its method and headers', async () => {
    const transport = fakeFetch();
    const wrapper = createBoundedSmokeFetch({ fetch: transport.fetch, limit: 1, maxOutputTokens: 512, onAttempt: () => undefined });
    const request = new Request(COMPLETIONS_URL, {
      method: 'POST', headers: { authorization: 'Bearer test-secret', 'x-test': 'present' },
      body: '{"model":"test-model","max_tokens":2048}',
    });

    await wrapper(request);

    const forwarded = transport.calls[0];
    expect(forwarded).toBeDefined();
    const sent = new Request(forwarded!.input, forwarded!.init);
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('authorization')).toBe('Bearer test-secret');
    expect(sent.headers.get('x-test')).toBe('present');
    expect(JSON.parse(await sent.text())).toEqual({ model: 'test-model', max_tokens: 512 });
  });

  it('blocks every non-chat-completion URL without forwarding unknown paid API requests', async () => {
    const transport = fakeFetch();
    const attempts: number[] = [];
    const wrapper = createBoundedSmokeFetch({
      fetch: transport.fetch, limit: 10, maxOutputTokens: 512, onAttempt: (count) => attempts.push(count),
    });
    const init = { method: 'POST', body: 'not JSON' };

    const wrongPath = await wrapper('https://models.invalid/v1/chat/completions-extra', init);
    const modelsPath = await wrapper('https://models.invalid/v1/models', init);
    const completion = await wrapper(COMPLETIONS_URL, { method: 'POST', body: '{}' });

    expect(wrongPath.status).toBe(402);
    expect(modelsPath.status).toBe(402);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.input).toBe(COMPLETIONS_URL);
    expect(completion.status).toBe(200);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it.each([undefined, '{bad', 'null', '[]', '"string"', '{"model":"test","max_tokens":Infinity}', '{"model":"test","temperature":1e999}'])(
    'rejects missing or invalid JSON body %s without forwarding or leaking it', async (body) => {
      const transport = fakeFetch();
      const wrapper = createBoundedSmokeFetch({ fetch: transport.fetch, limit: 10, maxOutputTokens: 512, onAttempt: () => undefined });
      const init = body === undefined ? { method: 'POST' } : { method: 'POST', body };

      await expect(wrapper(COMPLETIONS_URL, init)).rejects.toThrow();
      try {
        await wrapper(COMPLETIONS_URL, init);
      } catch (error) {
        expect(String(error)).not.toContain(body ?? 'test-secret');
      }
      expect(transport.calls).toHaveLength(0);
    },
  );

  it('rejects oversized and unreadable request bodies before forwarding', async () => {
    const transport = fakeFetch();
    const wrapper = createBoundedSmokeFetch({ fetch: transport.fetch, limit: 10, maxOutputTokens: 512, onAttempt: () => undefined });
    const oversized = JSON.stringify({ messages: ['x'.repeat(8 * 1024 * 1024)] });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('test-secret stream')); } });

    await expect(wrapper(COMPLETIONS_URL, { method: 'POST', body: oversized })).rejects.toThrow();
    await expect(wrapper(COMPLETIONS_URL, { method: 'POST', body: stream, duplex: 'half' } as RequestInit)).rejects.toThrow();
    expect(transport.calls).toHaveLength(0);
  });

  it('rejects a 2 MiB Request body without waiting for the original tee branch', async () => {
    const transport = fakeFetch();
    const wrapper = createBoundedSmokeFetch({ fetch: transport.fetch, limit: 10, maxOutputTokens: 512, onAttempt: () => undefined });
    const request = new Request(COMPLETIONS_URL, {
      method: 'POST', body: JSON.stringify({ messages: ['x'.repeat(2 * 1024 * 1024)] }),
    });
    const result = await Promise.race([
      wrapper(request).then(() => 'forwarded', () => 'rejected'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 500)),
    ]);

    expect(result).toBe('rejected');
    expect(transport.calls).toHaveLength(0);
  });

  it('preserves network failure classification without leaking transport detail', async () => {
    const fetch: typeof globalThis.fetch = () => Promise.reject(new TypeError('test-secret network address'));
    const wrapper = createBoundedSmokeFetch({ fetch, limit: 10, maxOutputTokens: 512, onAttempt: () => undefined });

    try {
      await wrapper(COMPLETIONS_URL, { method: 'POST', body: '{}' });
      expect.fail('transport failure must be returned to the retry layer');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain('test-secret');
    }
  });

  it.each([
    { limit: 0, maxOutputTokens: 512 },
    { limit: 1.5, maxOutputTokens: 512 },
    { limit: 10, maxOutputTokens: 0 },
    { limit: 10, maxOutputTokens: Number.POSITIVE_INFINITY },
  ])('rejects invalid limits before use: %j', ({ limit, maxOutputTokens }) => {
    expect(() => createBoundedSmokeFetch({
      fetch: fakeFetch().fetch, limit, maxOutputTokens, onAttempt: () => undefined,
    })).toThrow();
  });
});
