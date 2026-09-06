import { describe, expect, it } from 'vitest';
import { startMetricsLab } from '../src/bootstrap/metrics-lab.js';
import { HttpMcpConnection } from '../src/infrastructure/mcp/http-connection.js';

describe('metrics lab composition', () => {
  it('starts isolated scrape, admin and MCP surfaces and closes them together', async () => {
    const lab = await startMetricsLab({ prometheusUrl: 'http://127.0.0.1:1', metricsHost: '127.0.0.1', metricsPort: 0, adminPort: 0, mcpPort: 0 });
    const connection = new HttpMcpConnection({ url: lab.mcpUrl });
    try {
      const changed = await fetch(`${lab.adminUrl}/scenario`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"scenario":"settlement_failure"}' });
      expect(changed.status).toBe(200);
      expect(await (await fetch(`${lab.metricsUrl}/metrics`)).text()).toContain('outcome="failure"} 15');
      await connection.connect(AbortSignal.timeout(2000));
      expect((await connection.listTools(AbortSignal.timeout(2000))).map((tool) => tool.name)).toEqual(['get_settlement_snapshot']);
    } finally { await connection.close(); await lab.close(); }
    await expect(fetch(`${lab.adminUrl}/scenarios`)).rejects.toThrow();
    await expect(fetch(`${lab.metricsUrl}/metrics`)).rejects.toThrow();
  });
});
