import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import {
  createLogsSubagentTool,
  type LogEvidencePageSource,
} from '../src/bootstrap/logs-subagent.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import type {
  EvidenceCaptureBudget,
  EvidenceCaptureResult,
  EvidenceManifestStore,
  LogEvidenceReader,
  StreamingEvidenceCaptureRequest,
  StreamingEvidenceRecorder,
  Tool,
  ToolResponse,
} from '../src/contracts/index.js';
import type { SourceChildAgentFactory } from '../src/application/source-subagent-runner.js';

const budget: EvidenceCaptureBudget = {
  maxSourceBytes: 64 * 1024 * 1024,
  maxRecords: 50_000,
  maxDurationMs: 60_000,
  maxModelSummaryBytes: 16 * 1024,
  maxSamples: 20,
};

describe('logs_subagent runtime composition', () => {
  it('exposes only the canonical parent Tool and runs the child through AgentHarness', async () => {
    let childTools: readonly Tool[] = [];
    const childFactory: SourceChildAgentFactory = {
      create: (input) => {
        childTools = input.tools;
        return createAgentRuntime({
          model: new ScriptedModel([
            { toolCalls: [{ id: 'capture-1', name: 'logs.capture', input: { service: 'checkout', start: '2026-09-14T00:00:00.000Z', end: '2026-09-14T01:00:00.000Z' } }] },
            { toolCalls: [{ id: 'report-1', name: 'source_report', input: {
              summary: '发现结算超时日志。',
              findings: [{ kind: 'observation', statement: '结算调用出现超时。', evidenceIds: ['evidence-1'] }],
              businessTraceIds: ['trace-1'],
              missingEvidence: [],
            } }] },
            { text: '已完成日志取证。', toolCalls: [] },
          ]),
          workspaceRoots: [],
          includeExternalBash: false,
          tools: [...input.tools],
        }).agent;
      },
    };
    const parentTool = createLogsSubagentTool({
      ...evidenceOptions(),
      childAgentFactory: childFactory,
    });
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'logs-call-1', name: 'logs_subagent', input: {
          profileId: 'group-buy-market', service: 'checkout', start: '2026-09-14T00:00:00.000Z', end: '2026-09-14T01:00:00.000Z', question: '定位结算失败原因',
        } }] },
        { text: '根据日志，结算请求存在超时。', toolCalls: [] },
      ]),
      workspaceRoots: [],
      includeExternalBash: false,
      sourceSubagentTools: [parentTool],
    });

    expect(runtime.toolkit.get('logs_subagent')).toBe(parentTool);
    expect(runtime.toolkit.get('logs.capture')).toBeUndefined();
    const result = await runtime.agent.reply({ message: '检查结算失败', profileId: 'group-buy-market' });
    expect(result.status).toBe('completed');
    expect(childTools.map((tool) => tool.name)).toEqual([
      'logs.capture', 'logs.search_evidence', 'logs.aggregate_evidence', 'logs.read_evidence_slice', 'source_report',
    ]);
    expect(childTools.some((tool) => tool.name === 'bash' || tool.name.endsWith('_subagent'))).toBe(false);
    await runtime.close();
  });

  it('rejects a parent evidence hint that belongs to another Run before creating a child', async () => {
    let created = false;
    const tool = createLogsSubagentTool({
      ...evidenceOptions(),
      childAgentFactory: { create: () => {
        created = true;
        throw new Error('child must not be created');
      } },
    });
    await expect(drainTool(tool, {
      profileId: 'group-buy-market', service: 'checkout', start: '2026-09-14T00:00:00.000Z', end: '2026-09-14T01:00:00.000Z', question: '调查', evidenceIds: ['evidence-1'],
    }, 'parent-run-1')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(created).toBe(false);
  });
});

function evidenceOptions() {
  const manifest = {
    manifestId: 'manifest-1',
    evidenceId: 'evidence-1',
    runId: 'child-run',
    stepId: 'capture-step',
    toolCallId: 'capture-1',
    captureKey: 'capture-key',
    source: 'log' as const,
    state: 'committed' as const,
    queryDigest: 'digest',
    timeRange: { start: '2026-09-14T00:00:00.000Z', end: '2026-09-14T01:00:00.000Z' },
    recordCount: 1,
    sourceBytes: 100,
    storedBytes: 80,
    chunkCount: 1,
    rawSha256: 'sha256',
    compression: 'gzip_ndjson' as const,
    coverage: 1,
    truncated: false,
    missingEvidence: [],
    redactionPolicyVersion: 'redaction/v1',
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:01.000Z',
    committedAt: '2026-09-14T00:00:01.000Z',
  };
  const manifests: EvidenceManifestStore = {
    createPending: () => Promise.resolve({ ...manifest, chunks: [] }),
    recordChunk: () => Promise.resolve({ ...manifest, chunks: [] }),
    commit: () => Promise.resolve({ ...manifest, chunks: [] }),
    markFailed: () => Promise.resolve({ ...manifest, state: 'failed' as const, chunks: [] }),
    get: () => Promise.resolve({ ...manifest, chunks: [] }),
    getVisible: (evidenceId) => Promise.resolve(evidenceId === manifest.evidenceId ? manifest : null),
  };
  const recorder: StreamingEvidenceRecorder = {
    capture: (request: StreamingEvidenceCaptureRequest): Promise<EvidenceCaptureResult> => Promise.resolve({
      evidenceId: request.evidenceId,
      summary: {
        recordCount: 1,
        sourceBytes: 100,
        firstTimestamp: request.timeRange.start,
        lastTimestamp: request.timeRange.start,
        levels: [{ value: 'ERROR', count: 1 }],
        services: [{ value: 'checkout', count: 1 }],
        exceptionSignatures: [],
        traceIds: ['trace-1'],
        samples: [{ timestamp: request.timeRange.start, service: 'checkout', level: 'ERROR', message: 'timeout' }],
      },
      manifest: { ...manifest, evidenceId: request.evidenceId, runId: request.runId, toolCallId: request.toolCallId },
      coverage: 1,
      truncated: false,
      missingEvidence: [],
    }),
  };
  const source: LogEvidencePageSource = {
    pages: async function* () { /* source pages are not read by this deterministic recorder */ },
  };
  const reader: LogEvidenceReader = {
    search: () => Promise.resolve({ records: [] }),
    aggregate: () => Promise.resolve({ recordCount: 0, levels: [], services: [], exceptionSignatures: [], traceIds: [] }),
    readSlice: () => Promise.resolve({ records: [] }),
  };
  return { source, recorder, manifests, reader, budget, id: () => 'evidence-1' };
}

async function drainTool(tool: Tool, input: Record<string, unknown>, runId: string): Promise<ToolResponse> {
  const value = tool.call?.(input, {
    toolCallId: 'parent-tool-1', runId, stepId: 'step-1', profileId: 'group-buy-market',
    signal: new AbortController().signal, mode: 'execute', remainingToolCalls: 8,
  });
  if (value === undefined || typeof value !== 'object' || !(Symbol.asyncIterator in value)) throw new Error('expected Tool stream');
  const stream = value as AsyncGenerator<unknown, ToolResponse>;
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
