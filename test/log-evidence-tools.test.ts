import { describe, expect, it } from 'vitest';
import type {
  EvidenceCaptureBudget,
  EvidenceCaptureResult,
  EvidenceManifest,
  EvidenceManifestStore,
  EvidenceSummary,
  NormalizedLogRecord,
  StreamingEvidenceCaptureRequest,
  StreamingEvidenceRecorder,
  Tool,
  ToolResponse,
} from '../src/contracts/index.js';
import {
  createLogEvidenceTools,
  type LogEvidenceAggregation,
  type LogEvidenceReader,
  type LogEvidenceReadPage,
} from '../src/bootstrap/log-evidence-tools.js';
import { PagedEvidenceSource, type ElkPageClient } from '../src/infrastructure/elk/paged-evidence-source.js';

const budget: EvidenceCaptureBudget = {
  maxSourceBytes: 64 * 1024 * 1024,
  maxRecords: 50_000,
  maxDurationMs: 60_000,
  maxModelSummaryBytes: 16 * 1024,
  maxSamples: 20,
};

const visible = {
  manifestId: 'manifest-1',
  evidenceId: 'evidence-log-1',
  runId: 'run-1',
  stepId: 'step-1',
  toolCallId: 'call-1',
  captureKey: 'capture-key',
  source: 'log' as const,
  state: 'committed' as const,
  queryDigest: 'digest',
  timeRange: { start: '2026-09-13T00:00:00.000Z', end: '2026-09-13T01:00:00.000Z' },
  recordCount: 1,
  sourceBytes: 100,
  storedBytes: 50,
  chunkCount: 1,
  rawSha256: 'sha256',
  compression: 'gzip_ndjson' as const,
  coverage: 1,
  truncated: false,
  missingEvidence: [] as string[],
  redactionPolicyVersion: 'redaction/v1',
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:01.000Z',
  committedAt: '2026-09-13T00:00:01.000Z',
};

function summary(): EvidenceSummary {
  return {
    recordCount: 1,
    sourceBytes: 100,
    firstTimestamp: '2026-09-13T00:00:00.000Z',
    lastTimestamp: '2026-09-13T00:00:00.000Z',
    levels: [{ value: 'ERROR', count: 1 }],
    services: [{ value: 'checkout', count: 1 }],
    exceptionSignatures: [],
    traceIds: [],
    samples: [{ timestamp: '2026-09-13T00:00:00.000Z', service: 'checkout', level: 'ERROR', message: 'safe' }],
  };
}

function manifestFor(runId: string): EvidenceManifest {
  return { ...visible, runId, state: 'committed', chunks: [], summary: summary() };
}

function createManifests(runId = 'run-1'): EvidenceManifestStore {
  return {
    createPending: () => Promise.resolve(manifestFor(runId)),
    recordChunk: () => Promise.resolve(manifestFor(runId)),
    commit: () => Promise.resolve(manifestFor(runId)),
    markFailed: () => Promise.resolve({ ...manifestFor(runId), state: 'failed' as const }),
    get: (evidenceId) => Promise.resolve(evidenceId === visible.evidenceId ? manifestFor(runId) : null),
    getVisible: (evidenceId) => Promise.resolve(evidenceId === visible.evidenceId && runId === 'run-1' ? visible : null),
  };
}

function record(message: string): NormalizedLogRecord {
  return { timestamp: '2026-09-13T00:00:00.000Z', service: 'checkout', level: 'ERROR', message };
}

function createReader(): LogEvidenceReader {
  const page: LogEvidenceReadPage = {
    records: [{ ...record('reader-result'), fields: { storageKey: 'must-not-leak', safe: 'ok' } }],
    nextCursor: 'opaque-page-cursor',
  };
  const aggregation: LogEvidenceAggregation = {
    recordCount: 1,
    levels: [{ value: 'ERROR', count: 1 }],
    services: [{ value: 'checkout', count: 1 }],
    exceptionSignatures: [],
    traceIds: [],
  };
  return {
    search: () => Promise.resolve(page),
    aggregate: () => Promise.resolve(aggregation),
    readSlice: () => Promise.resolve(page),
  };
}

function createRecorder(captured: StreamingEvidenceCaptureRequest[]): StreamingEvidenceRecorder {
  const result: EvidenceCaptureResult = {
    evidenceId: visible.evidenceId,
    summary: summary(),
    manifest: visible,
    coverage: 1,
    truncated: false,
    missingEvidence: [],
  };
  return {
    capture: (request) => {
      captured.push(request);
      return Promise.resolve(result);
    },
  };
}

function findTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool: ${name}`);
  return tool;
}

async function callTool(
  tool: Tool,
  input: Record<string, unknown>,
  overrides: { runId?: string; toolCallId?: string; omitToolCallId?: boolean } = {},
): Promise<ToolResponse> {
  const result = tool.call?.(input, {
    runId: overrides.runId ?? 'run-1',
    stepId: 'step-1',
    ...(overrides.omitToolCallId === true ? {} : { toolCallId: overrides.toolCallId ?? 'call-1' }),
    signal: new AbortController().signal,
    mode: 'dry_run',
  });
  if (result === undefined) throw new Error('tool has no local call');
  if (typeof result === 'object' && result !== null && Symbol.asyncIterator in result) {
    const iterator = (result as AsyncGenerator<unknown, ToolResponse>)[Symbol.asyncIterator]();
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
    return next.value;
  }
  return await result;
}

function source(): PagedEvidenceSource {
  const client: ElkPageClient = { fetchPage: () => Promise.resolve({ records: [record('captured')] }) };
  return new PagedEvidenceSource(client);
}

function options(captured: StreamingEvidenceCaptureRequest[]) {
  return {
    source: source(),
    recorder: createRecorder(captured),
    manifests: createManifests(),
    reader: createReader(),
    budget,
    id: () => visible.evidenceId,
    now: () => Date.parse('2026-09-13T00:00:01.000Z'),
  };
}

describe('log evidence Tools', () => {
  it('captures through the streaming recorder and returns only bounded evidence references', async () => {
    const captured: StreamingEvidenceCaptureRequest[] = [];
    const tools = createLogEvidenceTools(options(captured));
    const result = await callTool(findTool(tools, 'logs.capture'), {
      service: 'checkout',
      start: '2026-09-13T00:00:00.000Z',
      end: '2026-09-13T01:00:00.000Z',
    });

    expect(result.blocks).toContainEqual({ type: 'evidence_ref', evidenceId: visible.evidenceId });
    expect(result.evidenceIds).toEqual([visible.evidenceId]);
    expect(captured[0]?.source).toBe('log');
    expect(captured[0]?.queryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('storageKey');
  });

  it('exposes read, aggregate and slice tools with safe restart policies', async () => {
    const captured: StreamingEvidenceCaptureRequest[] = [];
    const tools = createLogEvidenceTools(options(captured));
    const search = findTool(tools, 'logs.search_evidence');
    const aggregate = findTool(tools, 'logs.aggregate_evidence');
    const slice = findTool(tools, 'logs.read_evidence_slice');

    expect(findTool(tools, 'logs.capture').recoveryPolicy).toBe('verify_before_retry');
    expect(search.recoveryPolicy).toBe('replay_safe');
    expect(aggregate.recoveryPolicy).toBe('replay_safe');
    expect(slice.recoveryPolicy).toBe('replay_safe');
    expect(findTool(tools, 'logs.capture').isConcurrencySafe?.({})).toBe(false);
    expect(search.isConcurrencySafe?.({})).toBe(true);

    const searchResult = await callTool(search, { evidenceId: visible.evidenceId, limit: 10 });
    const aggregateResult = await callTool(aggregate, { evidenceId: visible.evidenceId });
    const sliceResult = await callTool(slice, { evidenceId: visible.evidenceId, limit: 1 });

    expect(JSON.stringify({ searchResult, aggregateResult, sliceResult })).not.toContain('storageKey');
    expect(JSON.stringify(aggregateResult)).toContain('recordCount');
  });

  it('rejects evidence belonging to another run before invoking the reader', async () => {
    let invoked = false;
    const captured: StreamingEvidenceCaptureRequest[] = [];
    const reader: LogEvidenceReader = {
      search: () => { invoked = true; return Promise.resolve({ records: [] }); },
      aggregate: () => Promise.resolve({ recordCount: 0, levels: [], services: [], exceptionSignatures: [], traceIds: [] }),
      readSlice: () => Promise.resolve({ records: [] }),
    };
    const tools = createLogEvidenceTools({ ...options(captured), manifests: createManifests('run-2'), reader });

    await expect(callTool(findTool(tools, 'logs.search_evidence'), { evidenceId: visible.evidenceId })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(invoked).toBe(false);
  });

  it('does not silently accept a missing tool call identity for capture', async () => {
    const captured: StreamingEvidenceCaptureRequest[] = [];
    const tools = createLogEvidenceTools(options(captured));
    await expect(callTool(findTool(tools, 'logs.capture'), {
      service: 'checkout',
      start: '2026-09-13T00:00:00.000Z',
      end: '2026-09-13T01:00:00.000Z',
    }, { omitToolCallId: true })).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });
});
