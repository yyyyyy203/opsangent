import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvidenceCaptureBudget, EvidenceSourcePage, Tool, ToolResponse } from '../src/contracts/index.js';
import type { RuntimeToolPorts } from '../src/application/create-runtime.js';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { createLogEvidenceTools } from '../src/bootstrap/log-evidence-tools.js';
import { LocalEvidenceReader } from '../src/infrastructure/elk/local-evidence-reader.js';
import { SourceFailure } from '../src/mcp/resilience.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const roots: string[] = [];
const cursorSecret = 'durable-logs-cursor-secret-0123456789';
const budget: EvidenceCaptureBudget = {
  maxSourceBytes: 64 * 1024 * 1024,
  maxRecords: 50_000,
  maxDurationMs: 60_000,
  maxModelSummaryBytes: 16 * 1024,
  maxSamples: 3,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Logs Web durable evidence acceptance', () => {
  it('replays a committed capture after restart without duplicate evidence or another source read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-logs-web-durable-'));
    roots.push(root);
    const sqlitePath = join(root, 'runtime.sqlite');
    const blobRoot = join(root, 'evidence-blobs');
    let sourcePagesRead = 0;
    let currentPorts: RuntimeToolPorts | undefined;
    const source = {
      pages: async function* (): AsyncIterable<EvidenceSourcePage> {
        await Promise.resolve();
        sourcePagesRead += 1;
        const records = [{
          timestamp: '2026-10-04T11:59:00.000Z',
          service: 'checkout',
          level: 'ERROR',
          message: 'safe persisted log evidence',
        }, {
          timestamp: '2026-10-04T11:59:30.000Z',
          service: 'checkout',
          level: 'ERROR',
          message: 'second safe persisted log evidence',
        }];
        yield { records, encodedBytes: Buffer.byteLength(JSON.stringify(records)), sourceSnapshotId: 'snapshot-durable' };
      },
    };
    const toolFactory = (ports: RuntimeToolPorts): readonly Tool[] => {
      currentPorts = ports;
      if (ports.evidenceBlobs === undefined || ports.evidenceManifests === undefined
        || ports.streamingEvidenceRecorder === undefined) throw new Error('Logs evidence data plane is unavailable');
      return createLogEvidenceTools({
        source,
        recorder: ports.streamingEvidenceRecorder,
        manifests: ports.evidenceManifests,
        reader: new LocalEvidenceReader({
          blobStore: ports.evidenceBlobs,
          manifests: ports.evidenceManifests,
          cursorSecret,
        }),
        budget,
        clock: ports.clock,
      });
    };
    const runtimeOptions = {
      sqlitePath,
      evidenceBlobRootPath: blobRoot,
      workspaceRoots: [],
      allowedToolNames: ['logs.capture', 'logs.search_evidence', 'logs.aggregate_evidence', 'logs.read_evidence_slice'],
      toolFactories: [toolFactory],
    };
    const input = {
      service: 'checkout',
      start: '2026-10-04T11:55:00.000Z',
      end: '2026-10-04T12:00:00.000Z',
    };
    const call = async (tool: Tool, value: Record<string, unknown>, runId: string, toolCallId: string): Promise<ToolResponse> => {
      const returned = tool.call?.(value, {
        runId,
        stepId: `step-${toolCallId}`,
        toolCallId,
        signal: new AbortController().signal,
        mode: 'dry_run',
      });
      if (returned === undefined || (typeof returned === 'object' && returned !== null && Symbol.asyncIterator in returned)) {
        throw new Error('logs.capture returned an unexpected streaming response');
      }
      return returned;
    };

    const first = createInspectionRuntime({ ...runtimeOptions, model: new ScriptedModel([]) });
    let evidenceId: string;
    let nextCursor: string | undefined;
    try {
      await first.ready;
      const tool = first.toolkit.get('logs.capture');
      if (tool === undefined) throw new Error('logs.capture was not registered');
      const response = await call(tool, input, 'durable-run', 'call-stable');
      evidenceId = response.evidenceIds?.[0] ?? '';
      expect(evidenceId).not.toBe('');
      expect(sourcePagesRead).toBe(1);
      const search = first.toolkit.get('logs.search_evidence');
      if (search === undefined) throw new Error('logs.search_evidence was not registered');
      const firstPage = await call(search, { evidenceId, limit: 1 }, 'durable-run', 'search-first');
      const firstJson = firstPage.blocks.find((block) => block.type === 'json');
      if (firstJson?.type !== 'json' || typeof firstJson.value !== 'object' || firstJson.value === null) {
        throw new Error('durable evidence first page is not JSON');
      }
      const cursorValue = (firstJson.value as { nextCursor?: unknown }).nextCursor;
      expect(cursorValue).toEqual(expect.any(String));
      if (typeof cursorValue === 'string') nextCursor = cursorValue;
    } finally {
      await first.close();
    }

    const second = createInspectionRuntime({ ...runtimeOptions, model: new ScriptedModel([]) });
    try {
      await second.ready;
      const tool = second.toolkit.get('logs.capture');
      if (tool === undefined) throw new Error('logs.capture was not restored');
      const response = await call(tool, input, 'durable-run', 'call-stable');
      expect(response.evidenceIds).toEqual([evidenceId]);
      expect(sourcePagesRead).toBe(1);
      const visible = await second.queries?.listEvidence('durable-run', { limit: 10 });
      expect(visible?.items).toHaveLength(1);
      expect(visible?.items[0]).toMatchObject({ evidenceId, source: 'log', state: 'committed', retrievable: false });

      const aggregate = second.toolkit.get('logs.aggregate_evidence');
      if (aggregate === undefined) throw new Error('logs.aggregate_evidence was not restored');
      const aggregateResponse = await call(aggregate, { evidenceId }, 'durable-run', 'aggregate-local');
      expect(JSON.stringify(aggregateResponse)).toContain('"recordCount":2');
      const search = second.toolkit.get('logs.search_evidence');
      if (search === undefined || nextCursor === undefined) throw new Error('logs search cursor was not preserved');
      const resumed = await call(search, { evidenceId, cursor: nextCursor, limit: 1 }, 'durable-run', 'search-resume');
      expect(JSON.stringify(resumed)).toContain('second safe persisted log evidence');
      if (currentPorts?.evidenceBlobs === undefined || currentPorts.evidenceManifests === undefined) {
        throw new Error('restarted Logs data plane is unavailable');
      }
      const wrongSecretReader = new LocalEvidenceReader({
        blobStore: currentPorts.evidenceBlobs,
        manifests: currentPorts.evidenceManifests,
        cursorSecret: 'different-cursor-secret-012345678901',
      });
      await expect(wrongSecretReader.search({
        evidenceId,
        runId: 'durable-run',
        cursor: nextCursor,
        limit: 1,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
      await expect(aggregate.call?.({ evidenceId }, {
        runId: 'different-run',
        stepId: 'step-other',
        toolCallId: 'call-other',
        signal: new AbortController().signal,
        mode: 'dry_run',
      })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    } finally {
      await second.close();
    }
  });

  it.each(['MCP_AUTH_ERROR', 'MCP_TIMEOUT'] as const)(
    'preserves %s when the source fails before its first page instead of reporting STORAGE_ERROR',
    async (code) => {
      const root = await mkdtemp(join(tmpdir(), 'agentops-logs-source-error-'));
      roots.push(root);
      const runtime = createInspectionRuntime({
        model: new ScriptedModel([{ text: 'ready for source error acceptance', toolCalls: [] }]),
        workspaceRoots: [],
        sqlitePath: join(root, 'runtime.sqlite'),
        evidenceBlobRootPath: join(root, 'evidence-blobs'),
        allowedToolNames: ['logs.capture', 'logs.search_evidence', 'logs.aggregate_evidence', 'logs.read_evidence_slice'],
        toolFactories: [(ports) => {
          if (ports.evidenceBlobs === undefined || ports.evidenceManifests === undefined
            || ports.streamingEvidenceRecorder === undefined) throw new Error('Logs evidence data plane is unavailable');
          return createLogEvidenceTools({
            source: { pages: () => failedPages(code) },
            recorder: ports.streamingEvidenceRecorder,
            manifests: ports.evidenceManifests,
            reader: new LocalEvidenceReader({
              blobStore: ports.evidenceBlobs,
              manifests: ports.evidenceManifests,
              cursorSecret,
            }),
            budget,
            clock: ports.clock,
          });
        }],
      });
      try {
        await runtime.ready;
        const run = await runtime.agent.reply({ message: 'initialize the run for source failure acceptance', profileId: 'simulation' });
        const tool = runtime.toolkit.get('logs.capture');
        if (tool === undefined) throw new Error('logs.capture was not registered');
        await expect(tool.call?.({
          service: 'checkout',
          start: '2026-10-04T11:55:00.000Z',
          end: '2026-10-04T12:00:00.000Z',
        }, {
          runId: run.runId,
          stepId: 'source-error-step',
          toolCallId: `source-error-${code}`,
          signal: new AbortController().signal,
          mode: 'dry_run',
        })).rejects.toMatchObject({ code });
        expect((await runtime.queries?.listEvidence(run.runId, { limit: 10 }))?.items).toHaveLength(0);
      } finally {
        await runtime.close();
      }
    },
  );

  it('keeps an aborted multi-page capture invisible even after one Blob chunk was committed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-logs-aborted-capture-'));
    roots.push(root);
    const controller = new AbortController();
    const evidenceId = 'aborted-log-capture';
    const runtime = createInspectionRuntime({
      model: new ScriptedModel([{ text: 'ready for abort acceptance', toolCalls: [] }]),
      workspaceRoots: [],
      sqlitePath: join(root, 'runtime.sqlite'),
      evidenceBlobRootPath: join(root, 'evidence-blobs'),
      allowedToolNames: ['logs.capture', 'logs.search_evidence', 'logs.aggregate_evidence', 'logs.read_evidence_slice'],
      toolFactories: [(ports) => {
        if (ports.evidenceBlobs === undefined || ports.evidenceManifests === undefined
          || ports.streamingEvidenceRecorder === undefined) throw new Error('Logs evidence data plane is unavailable');
        const source = {
          pages: async function* (): AsyncIterable<EvidenceSourcePage> {
            await Promise.resolve();
            const first = [{ timestamp: '2026-10-04T11:58:00.000Z', service: 'checkout', level: 'ERROR', message: 'first chunk' }];
            yield { records: first, encodedBytes: Buffer.byteLength(JSON.stringify(first)), nextCursor: 'cursor-1' };
            controller.abort();
            const second = [{ timestamp: '2026-10-04T11:59:00.000Z', service: 'checkout', level: 'ERROR', message: 'must not become visible' }];
            yield { records: second, encodedBytes: Buffer.byteLength(JSON.stringify(second)) };
          },
        };
        return createLogEvidenceTools({
          source,
          recorder: ports.streamingEvidenceRecorder,
          manifests: ports.evidenceManifests,
          reader: new LocalEvidenceReader({ blobStore: ports.evidenceBlobs, manifests: ports.evidenceManifests, cursorSecret }),
          budget,
          id: () => evidenceId,
          clock: ports.clock,
        });
      }],
    });
    try {
      await runtime.ready;
      const run = await runtime.agent.reply({ message: 'initialize the run for abort acceptance', profileId: 'simulation' });
      const tool = runtime.toolkit.get('logs.capture');
      if (tool === undefined || runtime.evidenceManifests === undefined) throw new Error('Logs capture data plane is unavailable');
      await expect(tool.call?.({
        service: 'checkout',
        start: '2026-10-04T11:55:00.000Z',
        end: '2026-10-04T12:00:00.000Z',
      }, {
        runId: run.runId,
        stepId: 'abort-step',
        toolCallId: 'abort-call',
        signal: controller.signal,
        mode: 'dry_run',
      })).rejects.toMatchObject({ code: 'ABORTED' });
      expect(await runtime.evidenceManifests.get(evidenceId)).toMatchObject({ state: 'failed', chunks: [expect.any(Object)] });
      expect(await runtime.evidenceManifests.getVisible(evidenceId)).toBeNull();
      expect((await runtime.queries?.listEvidence(run.runId, { limit: 10 }))?.items).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });
});

function failedPages(code: 'MCP_AUTH_ERROR' | 'MCP_TIMEOUT'): AsyncIterable<EvidenceSourcePage> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<EvidenceSourcePage>> => Promise.reject(new SourceFailure(code)),
    }),
  };
}
