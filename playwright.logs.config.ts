import { createServer } from 'node:net';
import { defineConfig } from '@playwright/test';

if (process.env.AGENTOPS_REAL_LOGS_WEB !== '1') {
  throw new Error('Logs browser acceptance is opt-in. Start the existing agentops-logs backends, then set AGENTOPS_REAL_LOGS_WEB=1 and run playwright test -c playwright.logs.config.ts.');
}

const agentPort = 45200;
const webPort = 45273;
const controlPort = 45201;
// Playwright evaluates this config again in workers after it has started both servers.
if (process.env.TEST_WORKER_INDEX === undefined) {
  for (const port of [agentPort, webPort, controlPort, 19208]) {
    await assertFreePort(port);
  }
}

const fixtureEnv = {
  ...process.env,
  AGENTOPS_MODEL_BASE_URL: '',
  AGENTOPS_MODEL_API_KEY: '',
  AGENTOPS_E2E_AGENT_PORT: String(agentPort),
  AGENTOPS_E2E_WEB_PORT: String(webPort),
  AGENTOPS_E2E_CONTROL_PORT: String(controlPort),
} as Record<string, string>;

export default defineConfig({
  testDir: './test/e2e',
  testMatch: /logs-web\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'test-results/logs-web',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    viewport: { width: 1920, height: 1200 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: [
    {
      command: 'node test/e2e/logs-fixture-server.mjs',
      url: `http://127.0.0.1:${agentPort}/health`,
      env: fixtureEnv,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `pnpm --dir apps/agent-web dev --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      env: { ...fixtureEnv, VITE_AGENT_API_URL: `http://127.0.0.1:${agentPort}` },
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});

async function assertFreePort(port: number): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch {
    throw new Error(`Logs E2E needs free local port ${port}; stop the owner of that port before retrying.`);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
