import { describe, expect, it } from 'vitest';
import { createOpenAICompatibleModel } from '../src/bootstrap/openai-compatible.js';
import { RetryingChatModel } from '../src/model/retrying-model.js';
import { SmokeRequestBudget } from '../src/model/smoke-request-budget.js';
import { SmokeOutputBudget } from '../src/model/smoke-output-budget.js';
import { createBoundedSmokeFetch } from './fixtures/bounded-smoke-fetch.js';
import type { BoundedSmokeFetchOptions } from './fixtures/bounded-smoke-fetch.js';

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
  it('blocks an exhausted shared output ledger before network independently of the request ledger', async () => {
    const transport = fakeFetch();
    const budget = new SmokeRequestBudget(10);
    const outputBudget = new SmokeOutputBudget();
    for (let index = 0; index < 5; index += 1) outputBudget.reserve(1024);
    const options = {
      fetch: transport.fetch, budget, limit: 10, maxOutputTokens: 512, onAttempt: () => undefined,
      outputBudget,
    };
    const wrapper = createBoundedSmokeFetch(options);

    expect((await wrapper(COMPLETIONS_URL, { method: 'POST', body: '{"model":"test-model"}' })).status).toBe(402);
    expect(transport.calls).toEqual([]);
    expect(budget.snapshot()).toEqual({ limit: 10, attempted: 1, sent: 0, rejected: 1 });
  });

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

const safeUsage = { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 20 } };
const identity = { id: 'chatcmpl-offline', model: 'test-model', object: 'chat.completion.chunk' };
const terminal = { ...identity, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
const finalUsage = { ...identity, choices: [], usage: safeUsage };
const initialDelta = { ...identity, choices: [{ index: 0, delta: { content: '巡检完成' }, finish_reason: null }] };

function sse(...frames: unknown[]): string {
  return frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\r\n\r\n`).join('');
}

function streamed(text: string, size = 7): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else {
        const end = Math.min(bytes.length, offset + size);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      }
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream', 'x-offline': 'preserved' } });
}

function outputHarness(fetch: typeof globalThis.fetch, additions: Partial<BoundedSmokeFetchOptions> = {}) {
  const outputBudget = additions.outputBudget ?? new SmokeOutputBudget();
  const budget = additions.budget ?? new SmokeRequestBudget(10);
  const wrapper = createBoundedSmokeFetch({
    fetch, budget, outputBudget, limit: 10, maxOutputTokens: 512, onAttempt: () => undefined, ...additions,
  });
  return { wrapper, outputBudget, budget };
}

const smokeInit = { method: 'POST', body: '{"model":"test-model","stream":true}' };

describe('bounded smoke shared output reservations', () => {
  it('shares 5120 tokens across parent/child concurrent attempts and counts every local rejection', async () => {
    const transport = fakeFetch();
    const { wrapper, outputBudget, budget } = outputHarness(transport.fetch, { maxOutputTokens: 1024 });
    const responses = await Promise.all(Array.from({ length: 11 }, () => wrapper(COMPLETIONS_URL, smokeInit)));
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(5);
    expect(responses.filter(({ status }) => status === 402)).toHaveLength(6);
    expect(transport.calls).toHaveLength(5);
    expect(budget.snapshot()).toEqual({ limit: 10, attempted: 11, sent: 5, rejected: 6 });
    expect(outputBudget.snapshot()).toEqual({ limit: 5120, reserved: 5120, settled: 0, available: 0, reservations: 5, settlements: 0, rejected: 5 });
    for (const response of responses.filter(({ status }) => status === 402)) expect(await response.text()).toBe('');
  });

  it('keeps one output ledger atomic across two separate wrappers', async () => {
    const transport = fakeFetch();
    const outputBudget = new SmokeOutputBudget();
    const options = { fetch: transport.fetch, outputBudget, limit: 10, maxOutputTokens: 1024, onAttempt: () => undefined };
    const parent = createBoundedSmokeFetch(options);
    const child = createBoundedSmokeFetch(options);
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => (index % 2 === 0 ? parent : child)(COMPLETIONS_URL, smokeInit)));
    expect(responses.filter(({ status }) => status === 402)).toHaveLength(1);
    expect(transport.calls).toHaveLength(5);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 5120, available: 0 });
  });

  it('selects 512 or 1024 within an explicit ceiling and reserves before the fetch call', async () => {
    const sent: number[] = [];
    const reservedAtSend: number[] = [];
    const outputBudget = new SmokeOutputBudget();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      reservedAtSend.push(outputBudget.snapshot().reserved);
      const body = await new Request(input, init).json() as { max_tokens: number; max_completion_tokens?: number };
      expect(body.max_completion_tokens).toBeUndefined();
      sent.push(body.max_tokens);
      return new Response('ok');
    };
    const { wrapper } = outputHarness(fetch, {
      outputBudget, maxOutputTokens: 1024,
      selectOutputTokens: (body) => body['mode'] === 'report' ? 1024 : 512,
    });
    await wrapper(COMPLETIONS_URL, { method: 'POST', body: '{"model":"test-model","mode":"query","max_completion_tokens":8192}' });
    await wrapper(COMPLETIONS_URL, { method: 'POST', body: '{"model":"test-model","mode":"report","max_tokens":8192}' });
    expect(sent).toEqual([512, 1024]);
    expect(reservedAtSend).toEqual([512, 1536]);
  });

  it.each([0, 513, 1025, Number.NaN, Number.POSITIVE_INFINITY])('rejects unsafe selector output %s before network or output reservation', async (value) => {
    const transport = fakeFetch();
    const { wrapper, outputBudget, budget } = outputHarness(transport.fetch, {
      maxOutputTokens: 1024,
      selectOutputTokens: (() => value) as NonNullable<BoundedSmokeFetchOptions['selectOutputTokens']>,
    });
    await expect(wrapper(COMPLETIONS_URL, smokeInit)).rejects.toThrow('Smoke model request was rejected.');
    expect(transport.calls).toEqual([]);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 0, reservations: 0 });
    expect(budget.snapshot()).toMatchObject({ attempted: 1, sent: 0, rejected: 1 });
  });

  it('rejects a selector exceeding the explicit ceiling and sanitizes callback errors', async () => {
    const transport = fakeFetch();
    const first = outputHarness(transport.fetch, { selectOutputTokens: () => 1024 });
    await expect(first.wrapper(COMPLETIONS_URL, smokeInit)).rejects.toThrow('Smoke model request was rejected.');
    const second = outputHarness(transport.fetch, { selectOutputTokens: () => { throw new Error('PRIVATE_SELECTOR_DETAIL'); } });
    await expect(second.wrapper(COMPLETIONS_URL, smokeInit)).rejects.toThrow('Smoke model request was rejected.');
    expect(transport.calls).toEqual([]);
    expect(second.outputBudget.snapshot()).toMatchObject({ reserved: 0 });
  });

  it('keeps the legacy ceiling at 512 and permits up to 1024 only with an explicit output ledger', () => {
    const options = { fetch: fakeFetch().fetch, limit: 10, onAttempt: () => undefined };
    expect(() => createBoundedSmokeFetch({ ...options, maxOutputTokens: 513 })).toThrow(RangeError);
    expect(() => createBoundedSmokeFetch({ ...options, maxOutputTokens: 1024 })).toThrow(RangeError);
    expect(() => createBoundedSmokeFetch({ ...options, maxOutputTokens: 512, selectOutputTokens: () => 512 })).toThrow(RangeError);
    expect(() => createBoundedSmokeFetch({ ...options, maxOutputTokens: 1024, outputBudget: new SmokeOutputBudget() })).not.toThrow();
    expect(() => createBoundedSmokeFetch({ ...options, maxOutputTokens: 1025, outputBudget: new SmokeOutputBudget() })).toThrow(RangeError);
  });

  it('rejects multiple paid choices before charging or sending a request', async () => {
    const transport = fakeFetch();
    const { wrapper, outputBudget } = outputHarness(transport.fetch);
    await expect(wrapper(COMPLETIONS_URL, { method: 'POST', body: '{"model":"test-model","n":2}' })).rejects.toThrow();
    expect(transport.calls).toEqual([]);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 0 });
  });

  it('retains failed attempt reservations across retries and returns terminal 402 at exhaustion', async () => {
    const transport = fakeFetch();
    const { wrapper, outputBudget, budget } = outputHarness(async (input, init) => {
      await transport.fetch(input, init);
      return Response.json({ error: { code: 'temporary_failure' } }, { status: 503 });
    }, { outputBudget: new SmokeOutputBudget(1024) });
    const model = new RetryingChatModel(createOpenAICompatibleModel({
      baseUrl: 'https://models.invalid/v1', apiKey: 'offline-test-key', model: 'test-model', fetch: wrapper,
    }), { maxAttempts: 4, sleep: () => Promise.resolve() });
    await expect(model.stream([], [], { runId: 'run-1', stepId: 'step-1', signal: new AbortController().signal }).next())
      .rejects.toMatchObject({ disposition: 'terminal', details: { status: 402 } });
    expect(budget.snapshot()).toEqual({ limit: 10, attempted: 3, sent: 2, rejected: 1 });
    expect(transport.calls).toHaveLength(2);
    expect(outputBudget.snapshot()).toMatchObject({ limit: 1024, reserved: 1024, available: 0 });
  });

  it.each(['AbortError', 'TimeoutError', 'TypeError', 'Error'])('retains the output reservation for network %s without leaking detail', async (name) => {
    const failure = name === 'TypeError' ? new TypeError('PRIVATE_NETWORK_DETAIL') : new Error('PRIVATE_NETWORK_DETAIL');
    failure.name = name;
    const { wrapper, outputBudget, budget } = outputHarness(() => Promise.reject(failure));
    await expect(wrapper(COMPLETIONS_URL, smokeInit)).rejects.toMatchObject({ name, message: 'Smoke model request was rejected.' });
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512, settled: 0, available: 4608 });
    expect(budget.snapshot()).toMatchObject({ attempted: 1, sent: 1, rejected: 0 });
  });

  it('counts a pre-aborted attempt without fetching or reserving output', async () => {
    const transport = fakeFetch();
    const { wrapper, outputBudget, budget } = outputHarness(transport.fetch);
    const controller = new AbortController();
    controller.abort(new Error('PRIVATE_ABORT_REASON'));
    await expect(wrapper(new Request(COMPLETIONS_URL, { ...smokeInit, signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.calls).toEqual([]);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 0 });
    expect(budget.snapshot()).toMatchObject({ attempted: 1, sent: 0, rejected: 1 });
  });

  it('cancels a stalled Request body on abort without creating an unbounded tee', async () => {
    const transport = fakeFetch();
    const { wrapper, outputBudget, budget } = outputHarness(transport.fetch);
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half', signal: controller.signal };
    const pending = wrapper(new Request(COMPLETIONS_URL, init));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
    expect(transport.calls).toEqual([]);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 0 });
    expect(budget.snapshot()).toMatchObject({ sent: 0, rejected: 1 });
  });
});

describe('bounded final usage observation', () => {
  it.each([1, 7, 4096])('settles split UTF-8/CRLF SSE only after full EOF (chunks %s)', async (size) => {
    const text = sse(initialDelta, terminal, finalUsage, '[DONE]');
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(streamed(text, size)));
    const response = await wrapper(COMPLETIONS_URL, smokeInit);
    expect(response.headers.get('x-offline')).toBe('preserved');
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512, settled: 0 });
    expect(await response.text()).toBe(text);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 0, settled: 7, available: 5113, settlements: 1 });
  });

  it('does not read or refund ahead of caller demand and retains cancellation after DONE without EOF', async () => {
    let pulls = 0;
    let cancelled = false;
    const text = sse(terminal, finalUsage, '[DONE]');
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new TextEncoder().encode(text)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 });
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(new Response(source, { headers: { 'content-type': 'text/event-stream' } })));
    const response = await wrapper(COMPLETIONS_URL, smokeInit);
    expect(pulls).toBe(0);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new TextEncoder().encode(text));
    expect(pulls).toBe(1);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512, settled: 0 });
    await reader.cancel('caller-stopped');
    expect(cancelled).toBe(true);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512, settled: 0 });
  });

  it('accepts SSE comments and multiple data lines with split CRLF', async () => {
    const multiline = `: keepalive\r\n\r\ndata: ${JSON.stringify(terminal)}\r\n\r\ndata: ${JSON.stringify(finalUsage).replace(',"choices"', ',\r\ndata: "choices"')}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(streamed(multiline, 1)));
    expect(await (await wrapper(COMPLETIONS_URL, smokeInit)).text()).toBe(multiline);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 0, settled: 7 });
  });

  it('settles completed truncation when final usage is trustworthy', async () => {
    const text = sse({ ...terminal, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }, finalUsage, '[DONE]');
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(streamed(text)));
    await (await wrapper(COMPLETIONS_URL, smokeInit)).text();
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 0, settled: 7 });
  });

  it('keeps exposed truncated output terminal through the real adapter while settling trusted usage', async () => {
    const text = sse(initialDelta,
      { ...terminal, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
      { ...finalUsage, usage: { prompt_tokens: 100, completion_tokens: 512, total_tokens: 612 } },
      '[DONE]');
    let calls = 0;
    const { wrapper, outputBudget, budget } = outputHarness(() => {
      calls += 1;
      return Promise.resolve(streamed(text));
    });
    const model = new RetryingChatModel(createOpenAICompatibleModel({
      baseUrl: 'https://models.invalid/v1', apiKey: 'offline-test-key', model: 'test-model', fetch: wrapper,
    }), { maxAttempts: 4, sleep: () => Promise.resolve() });
    const iterator = model.stream([], [], { runId: 'run-1', stepId: 'step-1', signal: new AbortController().signal });
    expect((await iterator.next()).value).toMatchObject({ type: 'text_delta', delta: '巡检完成' });
    await expect(iterator.next()).rejects.toMatchObject({ details: { category: 'output_truncated' }, disposition: 'terminal' });
    expect(calls).toBe(1);
    expect(budget.snapshot()).toEqual({ limit: 10, attempted: 1, sent: 1, rejected: 0 });
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 0, settled: 512, available: 4608 });
  });

  const unsafeStreams: [string, string][] = [
    ['missing usage', sse(terminal, '[DONE]')],
    ['missing DONE', sse(terminal, finalUsage)],
    ['partial DONE', sse(terminal, finalUsage) + 'data: [DO'],
    ['unterminated DONE', sse(terminal, finalUsage) + 'data: [DONE]'],
    ['no terminal choice', sse(initialDelta, finalUsage, '[DONE]')],
    ['early usage', sse(finalUsage, terminal, '[DONE]')],
    ['duplicate usage', sse(terminal, finalUsage, finalUsage, '[DONE]')],
    ['duplicate DONE', sse(terminal, finalUsage, '[DONE]', '[DONE]')],
    ['data after DONE', sse(terminal, finalUsage, '[DONE]', initialDelta)],
    ['invalid JSON', sse(terminal, '{bad', finalUsage, '[DONE]')],
    ['mismatched response id', sse(terminal, { ...finalUsage, id: 'chatcmpl-other' }, '[DONE]')],
    ['mismatched model', sse(terminal, { ...finalUsage, model: 'other-model' }, '[DONE]')],
    ['missing identity', sse({ choices: terminal.choices }, { choices: [], usage: safeUsage }, '[DONE]')],
    ['multiple choices', sse({ ...terminal, choices: [terminal.choices[0], { ...terminal.choices[0], index: 1 }] }, finalUsage, '[DONE]')],
    ['unknown finish reason', sse({ ...terminal, choices: [{ index: 0, delta: {}, finish_reason: 'opaque' }] }, finalUsage, '[DONE]')],
    ['error frame', sse(terminal, { ...identity, error: { message: 'PRIVATE_PROVIDER_ERROR' } }, finalUsage, '[DONE]')],
    ['usage embedded in text', sse({ ...initialDelta, choices: [{ index: 0, delta: { content: JSON.stringify(finalUsage) }, finish_reason: 'stop' }] }, '[DONE]')],
    ...([
      ['string counter', { ...safeUsage, completion_tokens: '7' }],
      ['negative counter', { ...safeUsage, completion_tokens: -1 }],
      ['fractional counter', { ...safeUsage, completion_tokens: 1.5 }],
      ['unsafe counter', { ...safeUsage, prompt_tokens: Number.MAX_SAFE_INTEGER + 1 }],
      ['missing total', { prompt_tokens: 100, completion_tokens: 7 }],
      ['mismatched total', { ...safeUsage, total_tokens: 99 }],
      ['output over cap', { prompt_tokens: 100, completion_tokens: 513, total_tokens: 613 }],
      ['cached over input', { ...safeUsage, prompt_tokens_details: { cached_tokens: 101 } }],
    ] satisfies [string, Record<string, unknown>][]).map(([name, usage]): [string, string] => [name, sse(terminal, { ...finalUsage, usage }, '[DONE]')]),
  ];

  it.each(unsafeStreams)('retains the full reservation for %s and forwards bytes intact', async (_name, text) => {
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(streamed(text, 23)));
    expect(await (await wrapper(COMPLETIONS_URL, smokeInit)).text()).toBe(text);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512, settled: 0, available: 4608, settlements: 0 });
    expect(JSON.stringify(outputBudget.snapshot())).not.toContain('PRIVATE');
  });

  it('disables observation for an oversized frame while preserving the whole caller stream', async () => {
    const text = sse({ ...initialDelta, choices: [{ index: 0, delta: { content: 'x'.repeat(70_000) }, finish_reason: null }] }, terminal, finalUsage, '[DONE]');
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(streamed(text, 4096)));
    expect(await (await wrapper(COMPLETIONS_URL, smokeInit)).text()).toBe(text);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512, settled: 0 });
  });

  it('settles complete non-SSE chat JSON only after the response is consumed', async () => {
    const completion = { ...identity, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: safeUsage };
    const original = Response.json(completion);
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(original));
    const response = await wrapper(COMPLETIONS_URL, { method: 'POST', body: '{"model":"test-model","stream":false}' });
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512 });
    expect(await response.json()).toEqual(completion);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 0, settled: 7 });
  });

  it.each(['mismatched model', 'missing usage', 'nonterminal', 'oversized', 'HTTP failure', 'wrong content type'])('retains non-SSE reservation for %s', async (condition) => {
    const completion: Record<string, unknown> = { ...identity, object: 'chat.completion', choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }], usage: safeUsage };
    if (condition === 'mismatched model') completion['model'] = 'other-model';
    if (condition === 'missing usage') delete completion['usage'];
    if (condition === 'nonterminal') completion['choices'] = [{ index: 0, message: { content: 'ok' }, finish_reason: null }];
    if (condition === 'oversized') completion['padding'] = 'x'.repeat(70_000);
    const text = JSON.stringify(completion);
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(new Response(text, {
      status: condition === 'HTTP failure' ? 500 : 200,
      headers: { 'content-type': condition === 'wrong content type' ? 'text/plain' : 'application/json' },
    })));
    expect(await (await wrapper(COMPLETIONS_URL, smokeInit)).text()).toBe(text);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512, settled: 0 });
  });

  it('retains a completed-looking stream if the source errors after DONE', async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulls === 1) controller.enqueue(new TextEncoder().encode(sse(terminal, finalUsage, '[DONE]')));
        else controller.error(new TypeError('PRIVATE_STREAM_FAILURE'));
      },
    }, { highWaterMark: 0 });
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(new Response(source, { headers: { 'content-type': 'text/event-stream' } })));
    await expect((await wrapper(COMPLETIONS_URL, smokeInit)).text()).rejects.toThrow();
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512, settled: 0 });
  });

  it('propagates abort to a stalled response and retains the full reservation', async () => {
    const controller = new AbortController();
    let cancelled = false;
    let sentSignal: AbortSignal | null | undefined;
    const source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const { wrapper, outputBudget } = outputHarness((input, init) => {
      sentSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return Promise.resolve(new Response(source, { headers: { 'content-type': 'text/event-stream' } }));
    });
    const response = await wrapper(COMPLETIONS_URL, { ...smokeInit, signal: controller.signal });
    const pending = response.text();
    controller.abort(new Error('PRIVATE_ABORT_DETAIL'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(sentSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512, settled: 0 });
  });

  it('cancels a response arriving after the caller aborted while waiting for headers', async () => {
    const controller = new AbortController();
    let resolveResponse: (response: Response) => void = () => undefined;
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { wrapper, outputBudget, budget } = outputHarness(() => {
      const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
      started();
      return response;
    });
    const pending = wrapper(COMPLETIONS_URL, { ...smokeInit, signal: controller.signal });
    await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    let cancelled = false;
    resolveResponse(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512, settled: 0 });
    expect(budget.snapshot()).toMatchObject({ attempted: 1, sent: 1 });
  });

  it('does not settle one response against another concurrent request reservation', async () => {
    const text = sse(terminal, finalUsage, '[DONE]');
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(streamed(text)), {
      maxOutputTokens: 1024, selectOutputTokens: (body) => body['mode'] === 'report' ? 1024 : 512,
    });
    const query = await wrapper(COMPLETIONS_URL, { ...smokeInit, body: '{"model":"test-model","mode":"query"}' });
    const report = await wrapper(COMPLETIONS_URL, { ...smokeInit, body: '{"model":"test-model","mode":"report"}' });
    await query.text();
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 1024, settled: 7, available: 4089 });
    await report.text();
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 0, settled: 14, available: 5106 });
  });

  it('allows trusted zero output usage without inventing a nonzero charge', async () => {
    const text = sse(terminal, { ...finalUsage, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }, '[DONE]');
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(streamed(text)));
    await (await wrapper(COMPLETIONS_URL, smokeInit)).text();
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 0, settled: 0, available: 5120, settlements: 1 });
  });

  it('bounds cumulative SSE inspection independently of frame size', async () => {
    const text = ': bounded keepalive\n\n'.repeat(55_000) + sse(terminal, finalUsage, '[DONE]');
    const { wrapper, outputBudget } = outputHarness(() => Promise.resolve(streamed(text, 8192)));
    expect(await (await wrapper(COMPLETIONS_URL, smokeInit)).text()).toBe(text);
    expect(outputBudget.snapshot()).toMatchObject({ reserved: 512, settled: 0 });
  });
});
