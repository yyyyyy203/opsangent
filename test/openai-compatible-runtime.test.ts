import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
      await runtime.close();
    });
  });

  it('preserves interleaved raw tool calls through the four admission gates and into the next request', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    let requestCount = 0;
    await withServer((incoming, response) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { body += chunk; });
      incoming.on('end', () => {
        requestBodies.push(JSON.parse(body) as Record<string, unknown>);
        requestCount += 1;
        const events = requestCount === 1
          ? [
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tc-0","type":"function","function":{"name":"metrics.settlement","arguments":"{\\"window\\":"}},{"index":1,"id":"tc-1","type":"function","function":{"name":"metrics.settlement","arguments":"{\\"window\\":"}}]},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"5m\\"}"}},{"index":0,"function":{"arguments":"\\"5m\\"}"}]},"finish_reason":"tool_calls"}]}\n\n',
          ]
          : [
            'data: {"choices":[{"index":0,"delta":{"content":"已完成取证"},"finish_reason":"stop"}]}\n\n',
          ];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(requestCount === 1
          ? `${toolCallEvents().map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
          : `${events.join('')}data: [DONE]\n\n`);
      });
    }, async (baseUrl) => {
      const model = createOpenAICompatibleModel({ baseUrl, apiKey: 'test-api-key', model: 'deepseek-chat' });
      const runtime = createAgentRuntime({
        model,
        workspaceRoots: [],
        includeExternalBash: false,
        tools: [{
          name: 'metrics.settlement',
          description: 'Read settlement metrics.',
          kind: 'evidence',
          inputSchema: z.object({ window: z.string() }),
          call: () => ({ blocks: [{ type: 'text', text: 'failure_rate=0.15' }] }),
          isConcurrencySafe: () => true,
        }],
      });
      const result = await runtime.agent.reply({ message: 'inspect', profileId: 'settlement', maxIterations: 3 });
      const secondMessages = requestBodies[1]?.messages;

      expect(result.finalText).toBe('已完成取证');
      expect(requestCount).toBe(2);
      expect(Array.isArray(secondMessages)).toBe(true);
      expect((secondMessages as Array<Record<string, unknown>>).some((message) => message.role === 'tool')).toBe(true);
      await runtime.close();
    });
  });
});

function toolCallEvents(): Array<Record<string, unknown>> {
  return [
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'tc-0', type: 'function', function: { name: 'metrics.settlement', arguments: '{"window":' } },
      { index: 1, id: 'tc-1', type: 'function', function: { name: 'metrics.settlement', arguments: '{"window":' } },
    ] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 1, function: { arguments: '"5m"}' } },
      { index: 0, function: { arguments: '"5m"}' } },
    ] }, finish_reason: 'tool_calls' }] },
  ];
}

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
