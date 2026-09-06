import { createServer } from 'node:http';
import type { SettlementSimulator } from './settlement-simulator.js';

/** Scrape-only listener. Scenario mutation stays with the injected owner, never a Tool. */
export async function startSimulatorMetricsServer(simulator: SettlementSimulator, options: { host: string; port: number }) {
  const server = createServer((request, response) => {
    if (request.url !== '/metrics') { response.writeHead(404).end(); return; }
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(simulator.exposition());
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SIMULATOR_LISTEN_FAILED');
  return {
    port: address.port,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
