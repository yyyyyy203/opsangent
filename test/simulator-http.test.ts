import { describe, expect, it } from 'vitest';
import { SettlementSimulator } from '../src/infrastructure/simulator/settlement-simulator.js';
import { startSimulatorMetricsServer } from '../src/infrastructure/simulator/http-server.js';

describe('simulator readonly scrape surface', () => {
  it('serves actual exposition but does not expose scenario control', async () => {
    const simulator = new SettlementSimulator(() => 1_000_000);
    simulator.select('settlement_failure');
    const server = await startSimulatorMetricsServer(simulator, { host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${server.port}`;
    try {
      const response = await fetch(`${url}/metrics`);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toContain('outcome="failure"} 15');
      expect((await fetch(`${url}/metrics`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${url}/scenario`, { method: 'POST', body: 'normal' })).status).toBe(404);
      expect(await (await fetch(`${url}/metrics`)).text()).toContain('outcome="failure"} 15');
    } finally { await server.close(); }
  });
});
