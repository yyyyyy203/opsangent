import { createServer, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { SettlementSimulator } from './settlement-simulator.js';

const selection = z.object({ scenario: z.enum(['normal', 'settlement_failure', 'low_sample']) }).strict();
const scenarios = ['normal', 'settlement_failure', 'low_sample'] as const;

/** Loopback administration API for the future Simulator Web; never register it as an Agent Tool. */
export async function startSimulatorAdminServer(simulator: SettlementSimulator, options: { port: number }) {
  let expectedHost = '';
  const server = createServer((request, response) => {
    void handle(request).then((result) => {
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    }).catch(() => response.writeHead(500).end());

    async function handle(req: IncomingMessage): Promise<{ status: number; headers?: Record<string, string>; body?: string }> {
      if (req.headers.origin !== undefined || req.headers.host !== expectedHost) return { status: 403 };
      if (req.url === '/scenarios') {
        if (req.method !== 'GET') return { status: 405, headers: { Allow: 'GET' } };
        return json(200, { active: simulator.currentScenario(), scenarios });
      }
      if (req.url !== '/scenario') return { status: 404 };
      if (req.method !== 'PUT') return { status: 405, headers: { Allow: 'PUT' } };
      if (req.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') return { status: 415 };
      const length = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(length) || length < 1 || length > 1024) return { status: 413 };
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        if (!Buffer.isBuffer(chunk)) return { status: 400 };
        bytes += chunk.length;
        if (bytes > 1024) return { status: 413 };
        chunks.push(chunk);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return { status: 400 }; }
      const input = selection.safeParse(parsed);
      if (!input.success) return { status: 400 };
      simulator.select(input.data.scenario);
      return json(200, { active: simulator.currentScenario() });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SIMULATOR_ADMIN_LISTEN_FAILED');
  expectedHost = `127.0.0.1:${address.port}`;
  return { port: address.port, async close(): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

function json(status: number, value: unknown) {
  return { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(value) };
}
