import { afterEach, describe, expect, it } from 'vitest';
import { applyManualReview, evaluateAcceptance } from '../src/acceptance/index.js';
import { readSourceReports } from '../src/acceptance/source-reports.js';
import { readAcceptanceSnapshot } from '../src/bootstrap/acceptance-reader.js';
import { createAcceptanceFixture } from './fixtures/acceptance-cases.js';
import { startScriptedAcceptanceRuntime, type ScriptedAcceptanceRuntime } from './fixtures/scripted-acceptance-runtime.js';

const active: ScriptedAcceptanceRuntime[] = [];

afterEach(async () => {
  await Promise.all(active.splice(0).map((runtime) => runtime.close()));
});

describe('scripted combined-source acceptance fixtures', () => {
  it.each(['normal', 'settlement_failure', 'low_sample', 'logs_offline', 'capture_window_mismatch'] as const)(
    'keeps deterministic facts, downgrade codes, ownership, and lifecycle auditable for %s',
    (caseId) => {
      const input = createAcceptanceFixture(caseId);
      const report = evaluateAcceptance(input);
      const reviewed = applyManualReview(report, { status: 'approved', unsupportedClaimCount: 0 });

      expect(reviewed.verdict).toBe('passed');
      expect(reviewed.usage).toMatchObject({ completeness: 'complete' });
      expect(reviewed.childRunIds).toHaveLength(2);
      expect(input.evidence.every((item) => item.retrievable === false)).toBe(true);
      expect(JSON.stringify(reviewed)).not.toContain('TimeoutException');
      expect(JSON.stringify(reviewed)).not.toContain('rawSha256');
    },
  );
});

describe('scripted combined-source runtime acceptance', () => {
  it('runs both canonical source subagents and keeps evidence and LangSmith export free of raw canaries', async () => {
    const runtime = await startScriptedAcceptanceRuntime({ logs: 'available' });
    active.push(runtime);
    const runId = 'acceptance-runtime-parent';
    const started = await fetch(`${runtime.web.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, message: '检查 checkout 结算失败', profileId: 'simulation', maxToolCalls: 12 }),
    });
    expect(started.status).toBe(202);
    await waitForTerminal(runtime.web.url, runId, 'completed');
    await runtime.web.flushEventObservability();

    const parent = await readJson<PublicRunPayload>(`${runtime.web.url}/runs/${runId}`);
    expect(parent.childRunIds).toHaveLength(2);
    expect(parent.evidenceIds).toHaveLength(2);
    const publicResponses = [
      JSON.stringify(parent), await readCompletedEventStream(`${runtime.web.url}/runs/${runId}/events`),
    ];
    for (const childRunId of parent.childRunIds) {
      const child = await readJson<PublicRunPayload>(`${runtime.web.url}/runs/${childRunId}`);
      const childPage = await readJson<EvidencePage>(`${runtime.web.url}/runs/${childRunId}/evidence`);
      expect(childPage.items.length).toBeGreaterThan(0);
      expect(child.evidenceIds).toEqual(childPage.items.map((item) => item.evidenceId));
      for (const evidence of childPage.items) {
        const detail = await readJson<EvidenceItem>(`${runtime.web.url}/runs/${childRunId}/evidence/${evidence.evidenceId}`);
        expect(detail.retrievable).toBe(false);
        publicResponses.push(JSON.stringify(detail));
      }
      publicResponses.push(await readCompletedEventStream(`${runtime.web.url}/runs/${childRunId}/events`));
    }
    const publicPayload = publicResponses.join('\n');
    expect(publicPayload).not.toContain(runtime.rawMetricsCanary);
    expect(publicPayload).not.toContain(runtime.rawLogsCanary);
    expect(runtime.exportBodies.join('\n')).not.toContain(runtime.rawMetricsCanary);
    expect(runtime.exportBodies.join('\n')).not.toContain(runtime.rawLogsCanary);
    expect(runtime.exportBodies.length).toBeGreaterThan(0);
    expect(runtime.metricsQueries()).toBe(1);
    expect(runtime.logsQueries()).toBe(1);
  });

  it('preserves explicit source degradation when the local Logs MCP is unavailable', async () => {
    const runtime = await startScriptedAcceptanceRuntime({ logs: 'unavailable' });
    active.push(runtime);
    const runId = 'acceptance-runtime-logs-offline';
    const started = await fetch(`${runtime.web.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, message: '检查 checkout 结算失败', profileId: 'simulation', maxToolCalls: 12 }),
    });
    expect(started.status).toBe(202);
    await waitForTerminal(runtime.web.url, runId, 'completed');
    const parent = await readJson<PublicRunPayload>(`${runtime.web.url}/runs/${runId}`);
    expect(parent.childRunIds).toHaveLength(2);
    const logsChildRunId = parent.childRunIds[1];
    if (logsChildRunId === undefined) throw new Error('SCRIPTED_ACCEPTANCE_LOGS_CHILD_MISSING');
    const logsEvents = await readCompletedEventStream(`${runtime.web.url}/runs/${logsChildRunId}/events`);
    expect(logsEvents).toContain('MCP_AUTH_ERROR');
    const logsMessages = await readJson<MessagePage>(`${runtime.web.url}/runs/${logsChildRunId}/messages`);
    expect(JSON.stringify(logsMessages)).toContain('日志来源当前不可用');
    expect(runtime.logsQueries()).toBe(1);
    expect(runtime.exportBodies.join('\n')).not.toContain(runtime.rawLogsCanary);
  }, 20_000);

  it('downgrades evidence when the captured log window differs from the requested window', async () => {
    const runtime = await startScriptedAcceptanceRuntime({ logs: 'available', captureWindow: 'mismatch' });
    active.push(runtime);
    const runId = 'acceptance-runtime-window-mismatch';
    const started = await fetch(`${runtime.web.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, message: '检查 checkout 结算失败', profileId: 'simulation', maxToolCalls: 12 }),
    });
    expect(started.status).toBe(202);
    await waitForTerminal(runtime.web.url, runId, 'completed');

    const parent = await readJson<PublicRunPayload>(`${runtime.web.url}/runs/${runId}`);
    const logsChildRunId = parent.childRunIds[1];
    if (logsChildRunId === undefined) throw new Error('SCRIPTED_ACCEPTANCE_LOGS_CHILD_MISSING');
    const logEvidence = await readJson<EvidencePage>(`${runtime.web.url}/runs/${logsChildRunId}/evidence`);
    expect(logEvidence.items[0]?.timeRange).toEqual({
      start: '2026-10-04T11:50:00.000Z',
      end: '2026-10-04T11:55:00.000Z',
    });
    const snapshot = await readAcceptanceSnapshot({ dataDirectory: runtime.dataDirectory, runId });
    const logsReport = readSourceReports(snapshot.events).find((report) => report.source === 'logs');
    expect(logsReport?.status).toBe('partial');
    expect(logsReport?.missingEvidence).toContain('capture_window_mismatch');
    expect(runtime.logsQueries()).toBe(1);
  });

  it('cancels an in-flight scripted parent Run and persists the cancellation event', async () => {
    const runtime = await startScriptedAcceptanceRuntime({ logs: 'available', parentBehavior: 'wait_for_abort' });
    active.push(runtime);
    const runId = 'acceptance-runtime-cancelled';
    const started = await fetch(`${runtime.web.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, message: '检查 checkout 结算失败', profileId: 'simulation', maxToolCalls: 12 }),
    });
    expect(started.status).toBe(202);
    await runtime.parentModelStarted();

    const cancelled = await fetch(`${runtime.web.url}/runs/${runId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(202);
    await waitForTerminal(runtime.web.url, runId, 'cancelled');

    const snapshot = await readAcceptanceSnapshot({ dataDirectory: runtime.dataDirectory, runId });
    expect(snapshot.events.some((event) => event.type === 'RUN_CANCELLED')).toBe(true);
  }, 20_000);
});

async function waitForTerminal(baseUrl: string, runId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}`);
    if (response.ok) {
      const detail = await response.json() as { status: string };
      if (detail.status === expected) return;
      if (['completed', 'failed', 'cancelled'].includes(detail.status)) {
        throw new Error(`SCRIPTED_ACCEPTANCE_RUN_${detail.status.toUpperCase()}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('SCRIPTED_ACCEPTANCE_RUN_TIMEOUT');
}

async function readCompletedEventStream(url: string): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || response.body === null) throw new Error(`SCRIPTED_ACCEPTANCE_SSE_${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  try {
    while (!output.includes('RUN_FINISHED')) {
      const item = await reader.read();
      if (item.done) break;
      output += decoder.decode(item.value, { stream: true });
    }
    return output;
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}

interface PublicRunPayload {
  readonly childRunIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly missingEvidence: readonly string[];
}

interface EvidenceItem {
  readonly evidenceId: string;
  readonly retrievable?: boolean;
  readonly timeRange?: { readonly start: string; readonly end: string };
}

interface EvidencePage {
  readonly items: readonly EvidenceItem[];
}

interface MessagePage {
  readonly items: readonly { readonly message: { readonly blocks: readonly { readonly text?: string }[] } }[];
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`SCRIPTED_ACCEPTANCE_HTTP_${response.status}`);
  return response.json() as Promise<T>;
}
