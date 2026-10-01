import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const agentUrl = process.env.AGENTOPS_E2E_AGENT_URL ?? `http://127.0.0.1:${process.env.AGENTOPS_E2E_AGENT_PORT ?? '45100'}`;

test('creates a Run, handles guarded confirmation, resumes explicitly, and reloads history', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '巡检 Agent 工作台' })).toBeVisible();

  await page.getByLabel('巡检问题').fill('检查结算失败率，并收集一份可审计的模拟指标证据。');
  await page.getByRole('button', { name: '开始巡检' }).click();

  await expect(page.getByRole('heading', { name: '需要你的确认' })).toBeVisible();
  await expect(page.getByText('等待确认')).toBeVisible();
  await page.getByRole('button', { name: '批准' }).click();
  await expect(page.getByRole('button', { name: '继续调查' })).toBeVisible();

  await page.getByRole('button', { name: '继续调查' }).click();
  await expect(page.getByText('模拟诊断完成：结算失败率已核验。')).toBeVisible();
  await expect(page.getByText('工具结果')).toBeVisible();
  await expect(page.getByText('已完成')).toBeVisible();
  await expect(page.locator('.run-card')).toHaveCount(1);

  await page.reload();
  await expect(page.locator('.run-card')).toHaveCount(1);
  await page.locator('.run-card').click();
  await expect(page.getByText('模拟诊断完成：结算失败率已核验。')).toBeVisible();
});

test('rejects a guarded call, then requires an explicit resume before finishing', async ({ page }) => {
  await startPendingRun(page, '拒绝一次模拟指标查询并验证恢复状态。');

  await page.getByRole('button', { name: '拒绝' }).click();
  await expect(page.getByRole('button', { name: '继续调查' })).toBeVisible();

  await page.getByRole('button', { name: '继续调查' }).click();
  await expect(page.getByText('模拟诊断完成：结算失败率已核验。')).toBeVisible();
  await expect(page.getByText('已完成')).toBeVisible();
});

test('keeps two pending Runs isolated when switching the selected Run', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '巡检 Agent 工作台' })).toBeVisible();

  const firstRunId = await startPendingRun(page, '隔离 Run 一：等待指标确认。');
  await page.getByLabel('巡检问题').fill('隔离 Run 二：等待另一份指标确认。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByRole('heading', { name: '需要你的确认' })).toBeVisible();
  const secondRunId = await selectedRunId(page);

  expect(secondRunId).not.toBe(firstRunId);
  await expect.poll(async () => page.locator('.run-card').count()).toBeGreaterThanOrEqual(2);
  await page.locator('.run-card').filter({ hasText: firstRunId }).click();
  await expect(page.locator('.confirmation-copy code')).toContainText(firstRunId);
  await page.locator('.run-card').filter({ hasText: secondRunId }).click();
  await expect(page.locator('.confirmation-copy code')).toContainText(secondRunId);
});

test('serializes duplicate confirmation commands with a revision conflict', async ({ page }) => {
  await startPendingRun(page, '验证同一确认请求的重复提交。');
  const runId = await selectedRunId(page);
  const confirmationResponse = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(runId)}/confirmation`);
  expect(confirmationResponse.ok()).toBe(true);
  const confirmation = readConfirmation(await confirmationResponse.json() as unknown);

  const decide = () => page.request.post(`${agentUrl}/runs/${encodeURIComponent(runId)}/confirmation`, {
    data: { toolCallId: confirmation.toolCallId, confirmed: true, expectedRevision: confirmation.expectedRevision },
  });
  const [first, second] = await Promise.all([decide(), decide()]);
  expect([first.status(), second.status()].sort()).toEqual([200, 409]);

  const resume = await page.request.post(`${agentUrl}/runs/${encodeURIComponent(runId)}/resume`);
  expect(resume.status()).toBe(202);
  await expect.poll(async () => {
    const response = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(runId)}`);
    return readRunStatus(await response.json() as unknown);
  }).toBe('completed');
});

async function startPendingRun(page: Page, message: string): Promise<string> {
  if (page.url() === 'about:blank') await page.goto('/');
  await page.getByLabel('巡检问题').fill(message);
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByRole('heading', { name: '需要你的确认' })).toBeVisible();
  return selectedRunId(page);
}

async function selectedRunId(page: Page): Promise<string> {
  const value = await page.locator('.run-card.selected code').textContent();
  if (value === null) throw new Error('No selected Run card.');
  return value.trim();
}

function readConfirmation(value: unknown): { toolCallId: string; expectedRevision: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid confirmation response.');
  const record = value as Record<string, unknown>;
  if (typeof record.toolCallId !== 'string' || typeof record.expectedRevision !== 'number') throw new Error('Invalid confirmation response.');
  return { toolCallId: record.toolCallId, expectedRevision: record.expectedRevision };
}

function readRunStatus(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Run response.');
  const status = (value as Record<string, unknown>).status;
  if (typeof status !== 'string') throw new Error('Invalid Run status.');
  return status;
}
