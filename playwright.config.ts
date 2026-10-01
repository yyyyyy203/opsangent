import { defineConfig } from '@playwright/test';

const agentPort = process.env.AGENTOPS_E2E_AGENT_PORT ?? '45100';
const webPort = process.env.AGENTOPS_E2E_WEB_PORT ?? '45173';
const fixtureEnv = {
  ...process.env,
  AGENTOPS_E2E_AGENT_PORT: agentPort,
  AGENTOPS_E2E_WEB_PORT: webPort,
} as Record<string, string>;
const realMetrics = process.env.AGENTOPS_REAL_PROMETHEUS_WEB === '1';
const controlPort = process.env.AGENTOPS_E2E_CONTROL_PORT ?? '45101';
const fixtureCommand = realMetrics ? 'node test/e2e/metrics-fixture-server.mjs' : 'node test/e2e/fixture-server.mjs';
const realFixtureEnv = {
  ...fixtureEnv,
  AGENTOPS_E2E_CONTROL_PORT: controlPort,
} as Record<string, string>;
const webEnv = {
  ...fixtureEnv,
  VITE_AGENT_API_URL: `http://127.0.0.1:${agentPort}`,
};

const projects = realMetrics
  ? [
      { name: 'fixed-tools', testIgnore: /metrics-web\.spec\.ts/ },
      { name: 'real-metrics', testMatch: /metrics-web\.spec\.ts/ },
    ]
  : [{ name: 'fixed-tools', testIgnore: /metrics-web\.spec\.ts/ }];

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: 'list',
  projects,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: fixtureCommand,
      url: `http://127.0.0.1:${agentPort}/health`,
      env: realMetrics ? realFixtureEnv : fixtureEnv,
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
