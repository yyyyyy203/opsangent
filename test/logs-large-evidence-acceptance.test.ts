import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvidenceCaptureBudget, EvidenceSourcePage, NormalizedLogRecord, Tool, ToolResponse } from '../src/contracts/index.js';
import type { RuntimeToolPorts } from '../src/application/create-runtime.js';
import { SourceFailure } from '../src/mcp/resilience.js';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { createLogEvidenceTools } from '../src/bootstrap/log-evidence-tools.js';
import { LocalEvidenceReader } from '../src/infrastructure/elk/local-evidence-reader.js';
import { canonicalJson } from '../src/contracts/stable-json.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { generateLargeLogRecords } from './fixtures/generated-log-pages.js';

const roots: string[] = [];
const start = '2026-10-04T11:00:00.000Z';
const end = '2026-10-04T12:00:00.000Z';
const maxPageBytes = 512 * 1024;
const budget: EvidenceCaptureBudget = {
  maxSourceBytes: 64 * 1024 * 1024,
  maxRecords: 50_000,
  maxDurationMs: 10 * 60_000,
  maxModelSummaryBytes: 16 * 1024,
  maxSamples: 3,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('large Logs evidence acceptance', () => {
  it('streams 14,000 records through bounded pages/chunks and exposes only a bounded public summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-large-log-evidence-'));
    roots.push(root);
    let runtimePorts: RuntimeToolPorts | undefined;
    const stats = { pageCount: 0, pageHighWaterBytes: 0, pageHighWaterRecords: 0 };
    let passedLedger: { remaining: number } | undefined;
    const source = {
      pages: (_query: unknown, options?: { networkAttemptBudget?: { remaining: number } }) => {
        passedLedger = options?.networkAttemptBudget;
        return packPages(generateLargeLogRecords({ count: 14_000, paddingBytes: 4_096, start, end }), stats);
      },
    };
    const runtime = createInspectionRuntime({
      model: new ScriptedModel([{ text: 'ready for bounded evidence acceptance', toolCalls: [] }]),
      workspaceRoots: [],
      sqlitePath: join(root, 'runtime.sqlite'),
      evidenceBlobRootPath: join(root, 'evidence-blobs'),
      allowedToolNames: ['logs.capture', 'logs.search_evidence', 'logs.aggregate_evidence', 'logs.read_evidence_slice'],
      toolFactories: [(ports) => {
        runtimePorts = ports;
        if (ports.evidenceBlobs === undefined || ports.evidenceManifests === undefined
          || ports.streamingEvidenceRecorder === undefined) throw new Error('Logs evidence data plane is unavailable');
        return createLogEvidenceTools({
          source,
          recorder: ports.streamingEvidenceRecorder,
          manifests: ports.evidenceManifests,
          reader: new LocalEvidenceReader({ blobStore: ports.evidenceBlobs, manifests: ports.evidenceManifests, cursorSecret: 'large-evidence-cursor-secret-0123456789' }),
          budget,
          clock: ports.clock,
        });
      }],
    });
    try {
      await runtime.ready;
      const run = await runtime.agent.reply({ message: 'initialize the run for large evidence acceptance', profileId: 'simulation' });
      expect(run.status).toBe('completed');
      const capture = runtime.toolkit.get('logs.capture');
      if (capture === undefined) throw new Error('logs.capture was not registered');
      const ledger = { remaining: 1_024 };
      const response = await invoke(capture, {
        service: 'checkout', start, end,
      }, run.runId, 'large-capture', ledger);
      const evidenceId = response.evidenceIds?.[0];
      if (evidenceId === undefined || runtimePorts?.evidenceManifests === undefined || runtime.queries === undefined) {
        throw new Error('large evidence acceptance did not produce its query ports');
      }

      const manifest = await runtimePorts.evidenceManifests.get(evidenceId);
      const publicEvidence = await runtime.queries.getEvidence(run.runId, evidenceId);
      expect(manifest).toMatchObject({ state: 'committed', recordCount: 14_000 });
      expect(manifest?.sourceBytes).toBeGreaterThanOrEqual(50 * 1024 * 1024);
      expect(manifest?.sourceBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(manifest?.chunks.length).toBeGreaterThan(1);
      expect(manifest?.chunks.every((chunk) => chunk.sourceBytes <= 4 * 1024 * 1024)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(16 * 1024);
      expect(passedLedger).toBe(ledger);
      expect(stats.pageCount).toBeGreaterThan(1);
      expect(stats.pageHighWaterBytes).toBeLessThanOrEqual(maxPageBytes);
      expect(stats.pageHighWaterRecords).toBeLessThanOrEqual(130);
      expect(publicEvidence).toMatchObject({ evidenceId, retrievable: false, state: 'committed' });
      expect(JSON.stringify(publicEvidence)).not.toContain('RAW_LOG_CANARY');
      expect(JSON.stringify(publicEvidence)).not.toContain('storageKey');
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it('preserves already committed pages as partial evidence when a two-attempt source budget is exhausted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-partial-log-evidence-'));
    roots.push(root);
    let runtimePorts: RuntimeToolPorts | undefined;
    const runtime = createInspectionRuntime({
      model: new ScriptedModel([{ text: 'ready for partial capture acceptance', toolCalls: [] }]),
      workspaceRoots: [],
      sqlitePath: join(root, 'runtime.sqlite'),
      evidenceBlobRootPath: join(root, 'evidence-blobs'),
      allowedToolNames: [],
      toolFactories: [(ports) => { runtimePorts = ports; return []; }],
    });
    try {
      await runtime.ready;
      const run = await runtime.agent.reply({ message: 'initialize the run for partial acceptance', profileId: 'simulation' });
      if (runtimePorts?.evidenceBlobs === undefined || runtimePorts.evidenceManifests === undefined
        || runtimePorts.streamingEvidenceRecorder === undefined) throw new Error('Logs evidence data plane is unavailable');
      const partialBudget = { ...budget, maxRecords: 50 };
      const source = {
        pages: (_query: unknown, options?: { networkAttemptBudget?: { remaining: number } }) => twoAttemptPages(options?.networkAttemptBudget),
      };
      const tools = createLogEvidenceTools({
        source,
        recorder: runtimePorts.streamingEvidenceRecorder,
        manifests: runtimePorts.evidenceManifests,
        reader: new LocalEvidenceReader({
          blobStore: runtimePorts.evidenceBlobs,
          manifests: runtimePorts.evidenceManifests,
          cursorSecret: 'partial-evidence-cursor-secret-0123456789',
        }),
        budget: partialBudget,
        clock: runtimePorts.clock,
      });
      const ledger = { remaining: 2 };
      const response = await invoke(findTool(tools, 'logs.capture'), { service: 'checkout', start, end }, run.runId, 'partial-capture', ledger);
      const resultBlock = response.blocks.find((block) => block.type === 'json');
      const evidenceId = response.evidenceIds?.[0];
      if (resultBlock?.type !== 'json' || typeof resultBlock.value !== 'object' || resultBlock.value === null
        || evidenceId === undefined) throw new Error('partial capture response is incomplete');
      expect((resultBlock.value as { status?: unknown }).status).toBe('partial');
      expect((resultBlock.value as { missingEvidence?: unknown }).missingEvidence).toContain('ELK_SOURCE_FAILED');
      expect(ledger.remaining).toBe(0);
      expect(await runtimePorts.evidenceManifests.getVisible(evidenceId)).toMatchObject({ state: 'partial', recordCount: 2 });
    } finally {
      await runtime.close();
    }
  });
});

async function* packPages(
  records: AsyncIterable<NormalizedLogRecord>,
  stats: { pageCount: number; pageHighWaterBytes: number; pageHighWaterRecords: number },
): AsyncIterable<EvidenceSourcePage> {
  let pageRecords: NormalizedLogRecord[] = [];
  let pageBytes = 0;
  for await (const record of records) {
    const bytes = Buffer.byteLength(canonicalJson(record) + '\n', 'utf8');
    if (pageRecords.length > 0 && pageBytes + bytes > maxPageBytes) {
      stats.pageCount += 1;
      stats.pageHighWaterBytes = Math.max(stats.pageHighWaterBytes, pageBytes);
      stats.pageHighWaterRecords = Math.max(stats.pageHighWaterRecords, pageRecords.length);
      yield { records: pageRecords, encodedBytes: pageBytes, nextCursor: `page-${stats.pageCount}`, sourceSnapshotId: 'large-snapshot' };
      pageRecords = [];
      pageBytes = 0;
    }
    pageRecords.push(record);
    pageBytes += bytes;
  }
  if (pageRecords.length > 0) {
    stats.pageCount += 1;
    stats.pageHighWaterBytes = Math.max(stats.pageHighWaterBytes, pageBytes);
    stats.pageHighWaterRecords = Math.max(stats.pageHighWaterRecords, pageRecords.length);
    yield { records: pageRecords, encodedBytes: pageBytes, sourceSnapshotId: 'large-snapshot' };
  }
}

async function* twoAttemptPages(ledger: { remaining: number } | undefined): AsyncIterable<EvidenceSourcePage> {
  await Promise.resolve();
  if (ledger === undefined) throw new Error('the source attempt ledger must be provided');
  for (let page = 1; page <= 2; page += 1) {
    if (ledger.remaining <= 0) throw new SourceFailure('BUDGET_EXCEEDED');
    ledger.remaining -= 1;
    const records = [{
      timestamp: `2026-10-04T11:00:0${page}.000Z`,
      service: 'checkout', level: 'ERROR', message: `committed-page-${page}`,
    }];
    yield { records, encodedBytes: Buffer.byteLength(canonicalJson(records)), nextCursor: `page-${page}`, sourceSnapshotId: 'budget-snapshot' };
  }
  throw new SourceFailure('BUDGET_EXCEEDED');
}

async function invoke(
  tool: Tool,
  input: Record<string, unknown>,
  runId: string,
  toolCallId: string,
  networkAttemptBudget: { remaining: number },
): Promise<ToolResponse> {
  const returned = tool.call?.(input, {
    runId,
    stepId: `step-${toolCallId}`,
    toolCallId,
    signal: new AbortController().signal,
    mode: 'dry_run',
    networkAttemptBudget,
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

function findTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool: ${name}`);
  return tool;
}
