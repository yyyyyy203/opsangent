import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { createOpenAICompatibleModel } from '../src/bootstrap/openai-compatible.js';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

describe('OpenAI-compatible runtime composition', () => {
  it('builds the production adapter from explicit options and runs it through the Harness', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        'data: {"choices":[{"index":0,"delta":{"content":"本地诊断"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''));
    }, async (baseUrl) => {
      const model = createOpenAICompatibleModel({ baseUrl, apiKey: 'test-api-key', model: 'deepseek-chat' });
      const runtime = createAgentRuntime({ model, workspaceRoots: [], includeExternalBash: false });
      const result = await runtime.agent.reply({ message: 'inspect', profileId: 'settlement' });

      expect(result.finalText).toBe('本地诊断');
      expect(result.status).toBe('completed');
      runtime.close();
    });
  });
});

async function withServer<T>(handler: Handler, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(handler);
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test server did not expose a TCP address.');
  try {
    return await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await close(server);
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
