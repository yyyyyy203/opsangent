import { defineConfig } from '@playwright/test';

const agentPort = process.env.AGENTOPS_E2E_AGENT_PORT ?? '45100';
const webPort = process.env.AGENTOPS_E2E_WEB_PORT ?? '45173';
const fixtureEnv = {
  ...process.env,
  AGENTOPS_E2E_AGENT_PORT: agentPort,
  AGENTOPS_E2E_WEB_PORT: webPort,
} as Record<string, string>;
const webEnv = {
  ...fixtureEnv,
  VITE_AGENT_API_URL: `http://127.0.0.1:${agentPort}`,
};

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node test/e2e/fixture-server.mjs',
      url: `http://127.0.0.1:${agentPort}/health`,
      env: fixtureEnv,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `pnpm --dir apps/agent-web dev --host 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      env: webEnv,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
