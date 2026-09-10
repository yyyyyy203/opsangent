import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { OpenAICompatibleClient, OpenAICompatibleClientOptions } from '../src/model/openai-compatible/client.js';
import { createOpenAICompatibleClient } from '../src/model/openai-compatible/client.js';
import type { OpenAICompatibleRequest, OpenAICompatibleStreamChunk } from '../src/model/openai-compatible/types.js';

const request: OpenAICompatibleRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'inspect' }],
  stream: true,
};

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

// The Windows dynamic port range on some development hosts includes Fetch-blocked ports.
const FETCH_BLOCKED_PORTS = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const MAX_SAFE_PORT_ATTEMPTS = 32;

describe('OpenAI-compatible SDK client', () => {
  it('normalizes the base path, sends JSON and forwards auth and trace headers', async () => {
    let seenPath = '';
    let seenAuthorization = '';
    let seenRunId = '';
    let seenStepId = '';
    let seenBody = '';

    await withServer((incoming, response) => {
      seenPath = incoming.url ?? '';
      seenAuthorization = String(incoming.headers.authorization ?? '');
      seenRunId = String(incoming.headers['x-run-id'] ?? '');
      seenStepId = String(incoming.headers['x-step-id'] ?? '');
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { seenBody += chunk; });
      incoming.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.end([
          'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ].join(''));
      });
    }, async (baseUrl) => {
      const client = createOpenAICompatibleClient({
        baseUrl: `${baseUrl}/v1///`,
        apiKey: 'test-api-key',
        requestHeaders: ({ runId, stepId }) => ({ 'x-run-id': runId ?? '', 'x-step-id': stepId ?? '' }),
      });
      const chunks = await collect(client, { runId: 'run-1', stepId: 'step-1' });

      expect(chunks).toEqual([
        { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]);
      expect(seenPath).toBe('/v1/chat/completions');
      expect(seenAuthorization).toBe('Bearer test-api-key');
      expect(seenRunId).toBe('run-1');
      expect(seenStepId).toBe('step-1');
      expect(JSON.parse(seenBody) as Record<string, unknown>).toMatchObject({ model: 'test-model', stream: true });
    });
  });

  it('rejects a successful response with a non-SSE content type', async () => {
    await withServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    }, async (baseUrl) => {
      const client = createOpenAICompatibleClient(options(baseUrl));
      await expect(collect(client)).rejects.toMatchObject({ details: { category: 'protocol' } });
    });
  });

  it('enforces the response byte limit without retaining the body', async () => {
    await withServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[]}\n\ndata: [DONE]\n\n');
    }, async (baseUrl) => {
      const client = createOpenAICompatibleClient({ ...options(baseUrl), maxResponseBytes: 8 });
      await expect(collect(client)).rejects.toMatchObject({ details: { category: 'protocol' } });
    });
  });

  it('requires the SDK stream done marker and never lets the SDK retry a request', async () => {
    let requests = 0;
    await withServer((_incoming, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
    }, async (baseUrl) => {
      const client = createOpenAICompatibleClient({ ...options(baseUrl), maxResponseBytes: 10_000 });
      await expect(collect(client)).rejects.toMatchObject({ details: { category: 'protocol' } });
      expect(requests).toBe(1);
    });

    let failedRequests = 0;
    await withServer((_incoming, response) => {
      failedRequests += 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":{"code":"temporary"}}');
    }, async (baseUrl) => {
      const client = createOpenAICompatibleClient(options(baseUrl));
      await expect(collect(client)).rejects.toBeDefined();
      expect(failedRequests).toBe(1);
    });
  });

  it('handles UTF-8 code points split across network chunks', async () => {
    await withServer((_incoming, response) => {
      const body = Buffer.from([
        'data: {"choices":[{"index":0,"delta":{"content":"诊断"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''));
      const cut = body.indexOf(Buffer.from('诊')) + 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(body.subarray(0, cut));
      setTimeout(() => response.end(body.subarray(cut)), 1);
    }, async (baseUrl) => {
      const client = createOpenAICompatibleClient(options(baseUrl));
      const chunks = await collect(client);
      expect(chunks[0]?.choices[0]?.delta?.content).toBe('诊断');
    });
  });

  it('rejects credentials and URLs that cannot be safely normalized', () => {
    expect(() => createOpenAICompatibleClient({ baseUrl: 'ftp://example.test', apiKey: 'key' })).toThrow();
    expect(() => createOpenAICompatibleClient({ baseUrl: 'https://user:pass@example.test', apiKey: 'key' })).toThrow();
    expect(() => createOpenAICompatibleClient({ baseUrl: 'https://example.test/path?token=secret', apiKey: 'key' })).toThrow();
    expect(() => createOpenAICompatibleClient({ baseUrl: 'https://example.test', apiKey: '   ' })).toThrow();
  });
});

async function collect(
  client: OpenAICompatibleClient,
  requestContext: { runId?: string; stepId?: string } = {},
): Promise<OpenAICompatibleStreamChunk[]> {
  const chunks: OpenAICompatibleStreamChunk[] = [];
  for await (const chunk of client.stream(request, { signal: new AbortController().signal, requestContext })) chunks.push(chunk);
  return chunks;
}

function options(baseUrl: string): OpenAICompatibleClientOptions {
  return { baseUrl, apiKey: 'test-api-key' };
}

async function withServer<T>(handler: Handler, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(handler);
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test server did not expose a TCP address.');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await close(server);
  }
}

async function listen(server: Server): Promise<void> {
  for (let attempt = 0; attempt < MAX_SAFE_PORT_ATTEMPTS; attempt += 1) {
    await listenOnce(server);
    const address = server.address();
    if (address !== null && typeof address !== 'string' && !FETCH_BLOCKED_PORTS.has(address.port)) return;
    await close(server);
  }
  throw new Error('Could not allocate a Fetch-safe port for the local test server.');
}

function listenOnce(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
