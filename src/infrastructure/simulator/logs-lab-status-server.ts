import { createServer } from 'node:http';
import type { SettlementScenario } from './settlement-simulator.js';

export interface LogsLabStatusState {
  readonly scenario: SettlementScenario;
  readonly snapshotId: string;
  readonly expiresAt: number;
  readonly ready: boolean;
}

export function logsLabStatusReply(method: string | undefined, path: string | undefined, state: LogsLabStatusState, nowMs: number) {
  if (path !== '/status') return { statusCode: 404, body: { error: 'NOT_FOUND' } };
  if (method !== 'GET') return { statusCode: 405, body: { error: 'METHOD_NOT_ALLOWED' } };
  const readiness = !state.ready ? 'unavailable' : nowMs > state.expiresAt ? 'stale' : 'ready';
  return {
    statusCode: 200,
    body: { scenario: state.scenario, snapshotId: state.snapshotId, expiresAt: new Date(state.expiresAt).toISOString(), readiness },
  };
}

export async function startLogsLabStatusServer(
  state: LogsLabStatusState,
  options: { port: number; now: () => number },
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const reply = logsLabStatusReply(request.method, request.url, state, options.now());
    response.writeHead(reply.statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(reply.statusCode === 405 ? { Allow: 'GET' } : {}),
    });
    response.end(JSON.stringify(reply.body));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LAB_STATUS_LISTEN_FAILED');
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/status`,
    close: () => closePromise ??= new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
