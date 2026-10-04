import { expect, test } from '@playwright/test';
import type { Page, Request, Response, TestInfo } from '@playwright/test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentUrl = 'http://127.0.0.1:45200';
const controlUrl = 'http://127.0.0.1:45201';
const forbidden = [
  'RAW_LOG_CANARY', 'Checkout settled', 'SQLTimeoutException', 'pit-',
  'test-only-logs-lab-hmac-canary-0123456789',
  'test-only-evidence-cursor-canary-9876543210',
];

interface RunDetail {
  runId: string;
  status: string;
  parentRunId?: string;
  childRunIds: string[];
  evidenceIds: string[];
  missingEvidence: string[];
  usage?: { completeness: string; inputTokens?: number; outputTokens?: number };
  failure?: { code: string; message: string };
}

interface EvidenceView {
  evidenceId: string;
  runId: string;
  source: string;
  summary: Record<string, unknown>;
  state: string;
  coverage?: number;
  recordCount?: number;
  retrievable: boolean;
}

interface FixtureState {
  calls: { parent: number; metrics: number; logs: number };
  observed: { recordCount: number; exceptionCount: number }[];
  reportReceipts: { runId: string; accepted: boolean; status: string; errorCode: string | null }[];
  ready: boolean;
  logsOffline: boolean;
  pauseParent: boolean;
}

test('shows bounded Metrics and Logs evidence, reconnects, and restores the Run tree without replay', async ({ page }, testInfo) => {
  const capture = capturePublicResponses(page);
  const sse = observeSse(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '巡检 Agent 工作台' })).toBeVisible();
  await page.getByLabel('巡检问题').fill('检查结算失败与日志异常是否相关。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  const parentId = await selectedRunId(page);
  await expect.poll(() => sse.responses.filter((response) => isRunSse(response.url(), parentId)).length).toBeGreaterThan(0);
  const firstSse = sse.requests.find((request) => isRunSse(request.url(), parentId));
  expect(firstSse).toBeDefined();
  expect(sse.responses.find((response) => isRunSse(response.url(), parentId))?.headers()['content-type']).toContain('text/event-stream');
  await expect.poll(async () => (await getRun(page, parentId)).status).toBe('completed');
  const parent = await getRun(page, parentId);
  expect(parent.childRunIds).toHaveLength(2);
  expect(parent.evidenceIds).toHaveLength(2);
  expect(parent.usage).toEqual({ completeness: 'complete', inputTokens: 21, outputTokens: 9 });

  const children = await Promise.all(parent.childRunIds.map(async (id) => ({ detail: await getRun(page, id), evidence: await getEvidence(page, id) })));
  const metric = children.find((child) => child.evidence.some((item) => item.source === 'metric'));
  const logs = children.find((child) => child.evidence.some((item) => item.source === 'log'));
  expect(metric?.detail).toMatchObject({ parentRunId: parentId, status: 'completed' });
  expect(logs?.detail).toMatchObject({ parentRunId: parentId, status: 'completed' });
  expect(metric?.evidence).toHaveLength(1);
  expect(logs?.evidence).toHaveLength(1);
  expect(metric?.evidence[0]).toMatchObject({ retrievable: false });
  expect(logs?.evidence[0]).toMatchObject({ recordCount: 100, retrievable: false, state: 'committed' });
  expect(logs?.evidence[0]?.coverage).toBe(1);
  expect(metric?.detail.usage).toEqual({ completeness: 'complete', inputTokens: 15, outputTokens: 6 });
  expect(logs?.detail.usage).toEqual({ completeness: 'complete', inputTokens: 24, outputTokens: 16 });
  const logId = logs?.evidence[0]?.evidenceId;
  if (!logId) throw new Error('Logs evidence reference is missing.');
  const logDetail = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(logs.detail.runId)}/evidence/${encodeURIComponent(logId)}`);
  expect(logDetail.ok()).toBe(true);
  expect((await logDetail.json() as EvidenceView).retrievable).toBe(false);
  const privateState = await state(page);
  expect(privateState.ready).toBe(true);
  expect(privateState.observed).toEqual([{ recordCount: 100, exceptionCount: 15 }]);

  await expect(page.getByRole('heading', { name: '证据摘要' })).toBeVisible();
  await expect(page.locator('.evidence-card')).toHaveCount(2);
  await expect(page.locator('.evidence-card').filter({ hasText: logId })).toContainText('100 条记录');
  await expect(page.getByRole('heading', { name: '子调查' })).toBeVisible();
  await expect(page.locator('.child-list button')).toHaveCount(2);
  await expect(page.getByText('整棵调用链')).toBeVisible();
  await expect(page.locator('.token-usage')).toContainText('输入 21 · 输出 9');
  await expect(page.locator('.token-usage')).toContainText('输入 39 · 输出 22');
  await expect(page.locator('.token-usage')).toContainText('输入 60 · 输出 31');
  const publicBodies = [JSON.stringify({ parent, children }), ...await readPublicTree(page, parentId, children.map((child) => child.detail.runId))];
  const evidenceDetails = await Promise.all(children.flatMap((child) => child.evidence.map(async (evidence) => ({
    runId: child.detail.runId,
    evidenceId: evidence.evidenceId,
    detail: await getPublicJson(page, `/runs/${child.detail.runId}/evidence/${evidence.evidenceId}`),
  }))));
  publicBodies.push(...await readSseFrames(parentId));
  for (const child of children) publicBodies.push(...await readSseFrames(child.detail.runId));
  await capture.settle();
  await assertPublicOnly(page, [...publicBodies, ...capture.bodies]);
  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach('logs-web-sanitized', { body: screenshot, contentType: 'image/png' });
  const retainedScreenshot = fileURLToPath(new URL('../../test-results/logs-web-snapshots/logs-web-sanitized.png', import.meta.url));
  await mkdir(dirname(retainedScreenshot), { recursive: true });
  await writeFile(retainedScreenshot, screenshot);
  expect((await stat(retainedScreenshot)).size).toBeGreaterThan(1_000);

  await page.reload(); // Closes the browser SSE connection and rehydrates from public snapshots.
  await expect.poll(() => sse.failed.includes(firstSse!)).toBe(true);
  await expect(page.locator('.run-card').filter({ hasText: parentId })).toBeVisible();
  await page.locator('.run-card').filter({ hasText: parentId }).click();
  await expect.poll(() => sse.requests.filter((request) => isRunSse(request.url(), parentId)).length).toBeGreaterThan(1);
  const secondSse = sse.requests.filter((request) => isRunSse(request.url(), parentId)).at(-1);
  expect(secondSse).not.toBe(firstSse);
  await expect.poll(() => sse.responses.filter((response) => isRunSse(response.url(), parentId)).length).toBeGreaterThan(1);
  await expect(page.locator('.evidence-card')).toHaveCount(2);
  await expect(page.locator('.message-card')).not.toHaveCount(0);
  const reconnectedParent = await getRun(page, parentId);
  const afterReconnectState = await state(page);
  expect(reconnectedParent.usage).toEqual(parent.usage);
  expect(afterReconnectState.calls).toEqual(privateState.calls);

  const restart = await page.request.post(`${controlUrl}/__restart`);
  expect(restart.status()).toBe(200);
  await page.reload();
  await page.locator('.run-card').filter({ hasText: parentId }).click();
  await expect(page.locator('.evidence-card')).toHaveCount(2);
  const restored = await getRun(page, parentId);
  expect(restored.childRunIds).toEqual(parent.childRunIds);
  expect(restored.evidenceIds).toEqual(parent.evidenceIds);
  expect(restored.usage).toEqual(parent.usage);
  const restoredChildren = [];
  for (const child of children) {
    const restoredDetail = await getRun(page, child.detail.runId);
    const restoredEvidence = await getEvidence(page, child.detail.runId);
    expect(restoredDetail).toEqual(child.detail);
    expect(restoredEvidence).toEqual(child.evidence);
    restoredChildren.push({ detail: restoredDetail, evidence: restoredEvidence });
    for (const evidence of child.evidence) {
      const detail = await getPublicJson(page, `/runs/${child.detail.runId}/evidence/${evidence.evidenceId}`);
      expect(detail).toEqual(evidenceDetails.find((item) => item.runId === child.detail.runId && item.evidenceId === evidence.evidenceId)?.detail);
    }
  }
  const afterRestartState = await state(page);
  expect(afterRestartState.calls).toEqual(privateState.calls);
  await capture.settle();
  await assertPublicOnly(page, [...publicBodies, ...capture.bodies]);
  await saveAcceptanceArtifact(testInfo, 'logs-web-complete-acceptance.json', {
    scenario: 'settlement_failure_with_metrics_and_logs',
    parentRun: { runId: parent.runId, childRunIds: parent.childRunIds, evidenceIds: parent.evidenceIds, missingEvidence: parent.missingEvidence, usage: parent.usage },
    children: children.map((child) => ({
      runId: child.detail.runId,
      source: child.evidence[0]?.source ?? (child.detail.runId === metric?.detail.runId ? 'metric' : child.detail.runId === logs?.detail.runId ? 'log' : null),
      evidenceIds: child.evidence.map((evidence) => evidence.evidenceId),
      coverage: child.evidence.map((evidence) => evidence.coverage ?? null),
      usage: child.detail.usage,
    })),
    reconnect: {
      establishedAgain: secondSse !== firstSse,
      callsBefore: privateState.calls,
      callsAfter: afterReconnectState.calls,
      modelCallsUnchanged: JSON.stringify(privateState.calls) === JSON.stringify(afterReconnectState.calls),
    },
    restart: {
      parentRestored: restored.childRunIds.join(',') === parent.childRunIds.join(',') && restored.evidenceIds.join(',') === parent.evidenceIds.join(','),
      childrenRestored: restoredChildren.length === children.length,
      evidenceDetailsRestored: evidenceDetails.length === children.reduce((count, child) => count + child.evidence.length, 0),
      callsBefore: privateState.calls,
      callsAfter: afterRestartState.calls,
      modelCallsUnchanged: JSON.stringify(privateState.calls) === JSON.stringify(afterRestartState.calls),
    },
  });
});

test('shows Logs source failure while retaining Metrics and resynchronizes after browser disconnect', async ({ page }, testInfo) => {
  const capture = capturePublicResponses(page);
  const sse = observeSse(page);
  const offline = await page.request.post(`${controlUrl}/__mode`, { data: { logsOffline: true } });
  expect(offline.status()).toBe(200);
  await page.goto('/');
  await page.getByLabel('巡检问题').fill('检查当前结算情况及缺失的日志证据。');
  await page.getByRole('button', { name: '开始巡检' }).click();
  const parentId = await selectedRunId(page);
  await expect.poll(() => sse.responses.filter((response) => isRunSse(response.url(), parentId)).length).toBeGreaterThan(0);
  const firstSse = sse.requests.find((request) => isRunSse(request.url(), parentId));
  expect(firstSse).toBeDefined();
  await page.goto('/'); // Explicit browser navigation disconnects SSE, not the underlying Run.
  await expect.poll(() => sse.failed.includes(firstSse!)).toBe(true);
  await expect.poll(async () => (await getRun(page, parentId)).status).toBe('completed');
  await page.locator('.run-card').filter({ hasText: parentId }).click();
  await expect.poll(() => sse.requests.filter((request) => isRunSse(request.url(), parentId)).length).toBeGreaterThan(1);
  await expect.poll(() => sse.responses.filter((response) => isRunSse(response.url(), parentId)).length).toBeGreaterThan(1);
  const parent = await getRun(page, parentId);
  expect(parent.childRunIds).toHaveLength(2);
  const children = await Promise.all(parent.childRunIds.map(async (id) => ({ detail: await getRun(page, id), evidence: await getEvidence(page, id) })));
  expect(children.flatMap((child) => child.evidence).filter((item) => item.source === 'metric')).toHaveLength(1);
  expect(children.flatMap((child) => child.evidence).filter((item) => item.source === 'log')).toHaveLength(0);
  const logsChild = children.find((child) => child.evidence.length === 0);
  expect(logsChild).toBeDefined();
  const logsMessages = await getMessages(page, logsChild!.detail.runId);
  expect(JSON.stringify(logsMessages)).toContain('日志来源不可用，缺少日志证据。');
  // With no captured evidence, LogsSourceReportCollector rejects an uncited report.
  expect((await state(page)).reportReceipts).toContainEqual({
    runId: logsChild!.detail.runId, accepted: false, status: 'failed', errorCode: 'TOOL_ERROR',
  });
  expect(parent.missingEvidence).toContain('logs_capture_unavailable');
  expect(parent.missingEvidence).toContain('traces');
  expect(logsChild!.detail.missingEvidence).toEqual([]);
  expect(logsChild!.detail.usage).toEqual({ completeness: 'complete', inputTokens: 18, outputTokens: 12 });
  expect(parent.usage).toEqual({ completeness: 'complete', inputTokens: 21, outputTokens: 9 });
  const metricChild = children.find((child) => child.evidence.some((item) => item.source === 'metric'));
  expect(metricChild?.detail.usage).toEqual({ completeness: 'complete', inputTokens: 15, outputTokens: 6 });
  await expect(page.locator('.token-usage')).toContainText('输入 54 · 输出 27');
  await expect(page.locator('.message-card')).not.toHaveCount(0);
  await expect(page.locator('.evidence-card')).toHaveCount(1);
  await expect(page.locator('.missing-box')).toContainText('logs_capture_unavailable');
  const bodies = [JSON.stringify({ parent, children, logsMessages }), ...await readPublicTree(page, parentId, parent.childRunIds), ...await readSseFrames(parentId)];
  for (const childRunId of parent.childRunIds) bodies.push(...await readSseFrames(childRunId));
  await page.locator('.child-list button').filter({ hasText: logsChild!.detail.runId }).click();
  await expect(page.locator('.message-list')).toContainText('日志来源不可用，缺少日志证据。');
  await capture.settle();
  await assertPublicOnly(page, [...bodies, ...capture.bodies]);
  await saveAcceptanceArtifact(testInfo, 'logs-web-offline-acceptance.json', {
    scenario: 'logs_source_unavailable_metrics_retained',
    parentRun: { runId: parent.runId, childRunIds: parent.childRunIds, evidenceIds: parent.evidenceIds, missingEvidence: parent.missingEvidence, usage: parent.usage },
    children: children.map((child) => ({
      runId: child.detail.runId,
      source: child.detail.runId === metricChild?.detail.runId ? 'metric' : child.detail.runId === logsChild?.detail.runId ? 'log' : null,
      evidenceIds: child.evidence.map((evidence) => evidence.evidenceId),
      coverage: child.evidence.map((evidence) => evidence.coverage ?? null),
      missingEvidence: child.detail.missingEvidence,
      usage: child.detail.usage,
    })),
  });
});

test('cancels an active Run through the public UI and persists the cancelled checkpoint', async ({ page }, testInfo) => {
  const capture = capturePublicResponses(page);
  const mode = await page.request.post(`${controlUrl}/__mode`, { data: { logsOffline: false, pauseParent: true } });
  expect(mode.status()).toBe(200);
  const before = await state(page);
  let runId: string | undefined;
  try {
    await page.goto('/');
    await page.getByLabel('巡检问题').fill('验证运行中止后状态可审计。');
    await page.getByRole('button', { name: '开始巡检' }).click();
    runId = await selectedRunId(page);
    await expect.poll(async () => (await state(page)).calls.parent).toBe(before.calls.parent + 1);
    await expect(page.getByRole('button', { name: '取消运行' })).toBeVisible();
    await page.getByRole('button', { name: '取消运行' }).click();
    await expect.poll(async () => (await getRun(page, runId!)).status).toBe('cancelled');
    const cancelled = await getRun(page, runId);
    expect(cancelled.failure?.code).toBe('ABORTED');
    await expect(page.locator('.status-hero')).toContainText('已取消');
    await expect(page.getByRole('button', { name: '取消运行' })).toHaveCount(0);

    const sseFrames = await readSseFrames(runId);
    expect(sseFrames.some((frame) => /^event: RUN_CANCELLED$/mu.test(frame))).toBe(true);
    const after = await state(page);
    expect(after.calls.parent).toBe(before.calls.parent + 1);
    expect(after.calls.metrics).toBe(before.calls.metrics);
    expect(after.calls.logs).toBe(before.calls.logs);
    const publicBodies = [JSON.stringify(cancelled), ...await readPublicTree(page, runId, []), ...sseFrames];
    await capture.settle();
    await assertPublicOnly(page, [...publicBodies, ...capture.bodies]);
    await saveAcceptanceArtifact(testInfo, 'logs-web-cancellation-acceptance.json', {
      scenario: 'active_run_cancelled_before_subagent_execution',
      run: { runId: cancelled.runId, status: cancelled.status, failureCode: cancelled.failure?.code ?? null },
      modelCalls: {
        before: before.calls,
        after: after.calls,
        downstreamCallsUnchanged: before.calls.metrics === after.calls.metrics && before.calls.logs === after.calls.logs,
      },
      terminalEvent: 'RUN_CANCELLED',
    });
  } finally {
    if (runId !== undefined) {
      try {
        const current = await getRun(page, runId);
        if (current.status === 'running') await page.request.post(`${agentUrl}/runs/${encodeURIComponent(runId)}/cancel`);
      } catch { /* Preserve the test failure; fixture shutdown also closes the active Run. */ }
    }
    try { await page.request.post(`${controlUrl}/__mode`, { data: { pauseParent: false } }); }
    catch { /* Preserve the test failure if the fixture has already shut down. */ }
  }
});

async function selectedRunId(page: Page): Promise<string> {
  const selected = page.locator('.run-card.selected code');
  await expect(selected).toBeVisible();
  return (await selected.textContent())!.trim();
}

async function getRun(page: Page, id: string): Promise<RunDetail> {
  const response = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(id)}`);
  expect(response.ok()).toBe(true);
  return await response.json() as RunDetail;
}

async function getEvidence(page: Page, id: string): Promise<EvidenceView[]> {
  const response = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(id)}/evidence`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { items: EvidenceView[] }).items;
}

async function getMessages(page: Page, id: string): Promise<unknown> {
  const response = await page.request.get(`${agentUrl}/runs/${encodeURIComponent(id)}/messages?limit=50`);
  expect(response.ok()).toBe(true);
  return await response.json() as unknown;
}

function isRunSse(url: string, runId: string): boolean {
  return url.startsWith(`${agentUrl}/runs/${encodeURIComponent(runId)}/events`);
}

function observeSse(page: Page): { requests: Request[]; responses: Response[]; failed: Request[] } {
  const observed = { requests: [] as Request[], responses: [] as Response[], failed: [] as Request[] };
  page.on('request', (request) => { if (request.url().includes('/events')) observed.requests.push(request); });
  page.on('response', (response) => { if (response.url().includes('/events')) observed.responses.push(response); });
  page.on('requestfailed', (request) => { if (request.url().includes('/events')) observed.failed.push(request); });
  return observed;
}

function capturePublicResponses(page: Page): { bodies: string[]; settle: () => Promise<void> } {
  const bodies: string[] = [];
  const pending = new Set<Promise<void>>();
  page.on('response', (response) => {
    if (!response.url().startsWith(agentUrl) || !response.headers()['content-type']?.includes('application/json')) return;
    const task = response.body().then((body) => {
      expect(body.byteLength).toBeLessThanOrEqual(128 * 1024);
      bodies.push(body.toString('utf8'));
    }).catch((error: unknown) => {
      // Navigation can cancel an in-flight snapshot. Completed responses are still checked.
      if (!page.isClosed() && !(error instanceof Error && /aborted|closed|cancelled/i.test(error.message))) throw error;
    });
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
  });
  return { bodies, settle: async () => { while (pending.size > 0) await Promise.all([...pending]); } };
}

async function getPublicJson(page: Page, path: string): Promise<unknown> {
  const response = await page.request.get(`${agentUrl}${path}`);
  expect(response.ok()).toBe(true);
  const body = await response.body();
  expect(body.byteLength).toBeLessThanOrEqual(128 * 1024);
  return JSON.parse(body.toString('utf8')) as unknown;
}

async function readPublicTree(page: Page, parentId: string, childIds: string[]): Promise<string[]> {
  const bodies: string[] = [];
  for (const runId of [parentId, ...childIds]) {
    bodies.push(JSON.stringify(await getPublicJson(page, `/runs/${runId}`)));
    bodies.push(JSON.stringify(await getPublicJson(page, `/runs/${runId}/messages?limit=50`)));
    const evidencePage = await getPublicJson(page, `/runs/${runId}/evidence?limit=50`) as { items: EvidenceView[] };
    bodies.push(JSON.stringify(evidencePage));
    for (const evidence of evidencePage.items) {
      expect(evidence.runId).toBe(runId);
      bodies.push(JSON.stringify(await getPublicJson(page, `/runs/${runId}/evidence/${evidence.evidenceId}`)));
    }
  }
  return bodies;
}

async function readSseFrames(runId: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${agentUrl}/runs/${encodeURIComponent(runId)}/events`, { signal: controller.signal });
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE response has no body');
    const decoder = new TextDecoder();
    const frames: string[] = [];
    let pending = '';
    let totalBytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) pending += decoder.decode();
      else {
        totalBytes += chunk.value.byteLength;
        expect(totalBytes).toBeLessThanOrEqual(1024 * 1024);
        pending += decoder.decode(chunk.value, { stream: true });
      }
      while (true) {
        const separator = /\r?\n\r?\n/u.exec(pending);
        if (separator === null) break;
        const frame = pending.slice(0, separator.index);
        pending = pending.slice(separator.index + separator[0].length);
        expect(Buffer.byteLength(frame, 'utf8')).toBeLessThanOrEqual(128 * 1024);
        frames.push(frame);
      }
      if (frames.some(isTerminalSseFrame)) return frames;
      if (chunk.done) break;
    }
    throw new Error('SSE response ended without a terminal Run event.');
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

function isTerminalSseFrame(frame: string): boolean {
  return /^event: (?:RUN_FINISHED|RUN_FAILED|RUN_PAUSED|RUN_CANCELLED)$/mu.test(frame);
}

async function state(page: Page): Promise<FixtureState> {
  const response = await page.request.get(`${controlUrl}/__state`);
  expect(response.ok()).toBe(true);
  return await response.json() as FixtureState;
}

async function assertPublicOnly(page: Page, bodies: string[]): Promise<void> {
  const visible = await page.locator('body').innerText();
  expect(Buffer.byteLength(visible, 'utf8')).toBeLessThanOrEqual(128 * 1024);
  for (const secret of forbidden) {
    expect(JSON.stringify(bodies)).not.toContain(secret);
    expect(visible).not.toContain(secret);
  }
  expect(visible).not.toContain('下载原始');
}

async function saveAcceptanceArtifact(testInfo: TestInfo, fileName: string, data: unknown): Promise<void> {
  const body = JSON.stringify(data, null, 2);
  expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(16 * 1024);
  await testInfo.attach(fileName, { body: Buffer.from(body, 'utf8'), contentType: 'application/json' });
  const artifact = fileURLToPath(new URL(`../../test-results/logs-web-snapshots/${fileName}`, import.meta.url));
  await mkdir(dirname(artifact), { recursive: true });
  await writeFile(artifact, body, 'utf8');
}
