import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeToolPorts } from '../src/application/create-runtime.js';
import { createLogEvidenceTools, type LogEvidencePageSource } from '../src/bootstrap/log-evidence-tools.js';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { LocalEvidenceReader } from '../src/infrastructure/elk/local-evidence-reader.js';
import type { EvidenceRecorder } from '../src/application/evidence-recorder.js';
import type {
  EvidenceCaptureBudget,
  EvidenceSourcePage,
  NormalizedLogRecord,
  Tool,
  ToolResponse,
} from '../src/contracts/index.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function metricsTool(getRecorder: () => EvidenceRecorder | undefined): Tool {
  return {
    name: 'metrics.settlement',
    description: 'Read settlement metrics and persist the source evidence.',
    kind: 'evidence',
    source: 'mcp',
    inputSchema: z.object({ service: z.literal('checkout') }),
    isConcurrencySafe: () => true,
    recoveryPolicy: 'replay_safe',
    async call(_input, options) {
      const recorder = getRecorder();
      if (recorder === undefined || options.toolCallId === undefined) throw new Error('metrics recorder is not ready');
      const evidenceId = 'metrics-evidence-1';
      await recorder.capture({
        record: {
          evidenceId,
          runId: options.runId,
          source: 'metric',
          summary: { status: 'breached', failureRate: 0.15, missingEvidence: ['logs', 'traces'] },
          raw: { marker: 'raw-only-marker', series: [{ failed: 15, total: 100 }] },
          businessTraceIds: [],
          capturedAt: '2026-09-14T00:00:00.000Z',
          toolCallId: options.toolCallId,
          captureKey: `metric:${options.runId}:${options.toolCallId}`,
        },
        stepId: options.stepId,
        toolCallId: options.toolCallId,
        coverage: 1,
        publicSummary: '结算指标已持久化，失败率为 15.00%。',
      });
      return {
        blocks: [
          { type: 'json', value: { status: 'breached', failureRate: 0.15 } },
          { type: 'evidence_ref', evidenceId },
        ],
        evidenceIds: [evidenceId],
      };
    },
  };
}

const logBudget: EvidenceCaptureBudget = {
  maxSourceBytes: 64 * 1024 * 1024,
  maxRecords: 50_000,
  maxDurationMs: 60_000,
  maxModelSummaryBytes: 16 * 1024,
  maxSamples: 20,
};

const logRecords: NormalizedLogRecord[] = [
  {
    timestamp: '2026-09-14T00:00:01.000Z',
    service: 'checkout',
    level: 'ERROR',
    message: 'safe public log one',
    fields: { privateMarker: 'raw-only-marker' },
  },
  {
    timestamp: '2026-09-14T00:00:02.000Z',
    service: 'checkout',
    level: 'ERROR',
    message: 'safe public log two',
  },
];

function logSource(): LogEvidencePageSource {
  return {
    pages: async function* (): AsyncIterable<EvidenceSourcePage> {
      await Promise.resolve();
      yield {
        records: logRecords,
        encodedBytes: Buffer.byteLength(JSON.stringify(logRecords), 'utf8'),
      };
    },
  };
}

function logToolFactory() {
  return (ports: RuntimeToolPorts) => {
    if (ports.evidenceBlobs === undefined || ports.evidenceManifests === undefined || ports.streamingEvidenceRecorder === undefined) {
      throw new Error('durable log evidence ports are required');
    }
    return createLogEvidenceTools({
      source: logSource(),
      recorder: ports.streamingEvidenceRecorder,
      manifests: ports.evidenceManifests,
      reader: new LocalEvidenceReader({
        blobStore: ports.evidenceBlobs,
        manifests: ports.evidenceManifests,
        cursorSecret: 'durable-evidence-cursor-secret',
      }),
      budget: logBudget,
      id: () => 'log-evidence-1',
    });
  };
}

async function callTool(tool: Tool, input: Record<string, unknown>, runId: string, toolCallId: string): Promise<ToolResponse> {
  const returned = tool.call?.(input, {
    runId,
    stepId: 'step-1',
    toolCallId,
    signal: new AbortController().signal,
    mode: 'dry_run',
  });
  if (returned === undefined) throw new Error(`tool has no local call: ${tool.name}`);
  if (typeof returned === 'object' && returned !== null && Symbol.asyncIterator in returned) {
    const iterator = (returned as AsyncGenerator<unknown, ToolResponse>)[Symbol.asyncIterator]();
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
    return next.value;
  }
  return await returned;
}

describe('durable evidence acceptance', () => {
  it('persists a metrics run, reopens it, and resolves evidence without raw data in public projections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-durable-evidence-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const recorderRef: { current?: EvidenceRecorder } = {};
    const tool = metricsTool(() => recorderRef.current);

    const first = createInspectionRuntime({
      sqlitePath,
      workspaceRoots: [],
      allowedToolNames: [tool.name],
      model: new ScriptedModel([
        { toolCalls: [{ id: 'metrics-1', name: tool.name, input: { service: 'checkout' } }] },
        { text: 'done', toolCalls: [] },
      ]),
      tools: [tool],
    });
    recorderRef.current = first.evidenceRecorder;
    const run = await first.agent.reply({ message: 'inspect settlement', profileId: 'group-buy-market' });
    expect(run.status).toBe('completed');
    expect(await first.evidence.get('metrics-evidence-1')).toMatchObject({
      runId: run.runId,
      raw: { marker: 'raw-only-marker' },
    });
    await first.close();

    const second = createInspectionRuntime({
      sqlitePath,
      workspaceRoots: [],
      allowedToolNames: [tool.name],
      model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]),
      tools: [tool],
    });
    try {
      await second.ready;
      expect(await second.checkpoints.load(run.runId)).toMatchObject({ runId: run.runId, status: 'completed' });
      expect(await second.evidence.get('metrics-evidence-1')).toMatchObject({
        runId: run.runId,
        raw: { marker: 'raw-only-marker' },
      });

      const controller = new AbortController();
      const publicFrames: unknown[] = [];
      try {
        for await (const frame of second.eventStreamV2.open({ runId: run.runId, signal: controller.signal })) {
          publicFrames.push(frame);
          if (frame.event === 'RUN_FINISHED') break;
        }
      } finally {
        controller.abort();
      }
      expect(publicFrames.length).toBeGreaterThan(0);
      expect(JSON.stringify(publicFrames)).not.toContain('raw-only-marker');
      expect(JSON.stringify(publicFrames)).not.toContain('storageKey');
    } finally {
      await second.close();
    }
  });

  it('reopens a committed log Blob and continues an opaque evidence cursor after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-durable-log-evidence-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const blobRoot = join(root, 'blobs');
    const runtimeOptions = {
      sqlitePath,
      evidenceBlobRootPath: blobRoot,
      workspaceRoots: [],
      allowedToolNames: ['logs.capture', 'logs.search_evidence', 'logs.aggregate_evidence', 'logs.read_evidence_slice'],
      toolFactories: [logToolFactory()],
    };

    const first = createInspectionRuntime({
      ...runtimeOptions,
      model: new ScriptedModel([
        {
          toolCalls: [{
            id: 'capture-log-1',
            name: 'logs.capture',
            input: {
              service: 'checkout',
              start: '2026-09-14T00:00:00.000Z',
              end: '2026-09-14T01:00:00.000Z',
            },
          }],
        },
        { text: 'done', toolCalls: [] },
      ]),
    });
    try {
      await first.ready;
      const run = await first.agent.reply({ message: 'capture checkout logs', profileId: 'group-buy-market' });
      expect(run.status).toBe('completed');

      const search = first.toolkit.get('logs.search_evidence');
      if (search === undefined) throw new Error('logs.search_evidence was not registered');
      const firstPage = await callTool(search, { evidenceId: 'log-evidence-1', limit: 1 }, run.runId, 'search-log-1');
      const firstJson = firstPage.blocks.find((block) => block.type === 'json');
      if (firstJson?.type !== 'json' || typeof firstJson.value !== 'object' || firstJson.value === null) {
        throw new Error('search result did not contain a JSON page');
      }
      const firstPageValue = firstJson.value as { records?: unknown; nextCursor?: unknown };
      expect(firstPageValue.records).toEqual([expect.objectContaining({ message: 'safe public log one' })]);
      expect(firstPageValue.nextCursor).toEqual(expect.any(String));
      expect(JSON.stringify(firstPage)).not.toContain('raw-only-marker');
      await first.close();

      const second = createInspectionRuntime({
        ...runtimeOptions,
        model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]),
      });
      try {
        await second.ready;
        expect(await second.evidenceManifests?.getVisible('log-evidence-1')).toMatchObject({
          runId: run.runId,
          source: 'log',
          state: 'committed',
        });
        const resumedSearch = second.toolkit.get('logs.search_evidence');
        if (resumedSearch === undefined) throw new Error('logs.search_evidence was not restored');
        const resumedPage = await callTool(resumedSearch, {
          evidenceId: 'log-evidence-1',
          cursor: firstPageValue.nextCursor,
          limit: 1,
        }, run.runId, 'search-log-2');
        expect(JSON.stringify(resumedPage)).not.toContain('raw-only-marker');
        expect(JSON.stringify(resumedPage)).not.toContain('storageKey');
        const resumedJson = resumedPage.blocks.find((block) => block.type === 'json');
        if (resumedJson?.type !== 'json' || typeof resumedJson.value !== 'object' || resumedJson.value === null) {
          throw new Error('resumed search result did not contain a JSON page');
        }
        const resumedValue = resumedJson.value as { records?: Array<{ message?: string }> };
        expect(resumedValue.records?.[0]?.message).toBe('safe public log two');
      } finally {
        await second.close();
      }
    } finally {
      if (first) await first.close().catch(() => undefined);
    }
  });
});
