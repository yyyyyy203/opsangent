import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const controlUrl = `http://127.0.0.1:${process.env.AGENTOPS_E2E_CONTROL_PORT ?? '45101'}`;

test('renders real Prometheus evidence, child Run history, and survives Web restart', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '巡检 Agent 工作台' })).toBeVisible();

  await page.getByLabel('巡检问题').fill('核验真实 Prometheus 中的结算失败率。');
  await page.getByRole('button', { name: '开始巡检' }).click();

  await expect(page.getByText('证据摘要')).toBeVisible();
  await expect(page.getByText('status: breached')).toBeVisible();
  await expect(page.getByText('failed: 15')).toBeVisible();
  await expect(page.getByText('Source Subagent')).toBeVisible();
  await expect(page.getByText('settlement_window_requests')).toHaveCount(0);

  const parentRunId = await selectedRunId(page);
  const childButton = page.locator('.child-list button').first();
  await expect(childButton).toBeVisible();
  await childButton.click();
  await expect(page.getByText('来源报告已提交。')).toBeVisible();
  await expect(page.getByText('status: breached')).toBeVisible();

  const restart = await page.request.post(`${controlUrl}/__restart`);
  expect(restart.status()).toBe(200);
  await page.reload();
  await expect(page.locator('.run-card')).toHaveCount(2);
  await page.locator('.run-card').filter({ hasText: parentRunId }).click();
  await expect(page.getByText('status: breached')).toBeVisible();
  await expect(page.getByText('failed: 15')).toBeVisible();
});

async function selectedRunId(page: Page): Promise<string> {
  const value = await page.locator('.run-card.selected code').textContent();
  if (value === null) throw new Error('No selected Run card.');
  return value.trim();
}
