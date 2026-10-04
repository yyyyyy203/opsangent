import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import {
  createLogsSubagentTool,
  type LogEvidencePageSource,
} from '../src/bootstrap/logs-subagent.js';
import { createSourceReportTool } from '../src/bootstrap/source-report-tool.js';
import { stableSourceChildRunId } from '../src/bootstrap/source-subagent-identity.js';
import { DefaultSourceReportCollector, type SourceReportCollector } from '../src/application/source-report-collector.js';
import { LogsSourceReportCollector } from '../src/application/logs-source-report-collector.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import type {
  EvidenceCaptureBudget,
  EvidenceCaptureResult,
  EvidenceManifestSummary,
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

  it('forwards optional request validation and collector factories without changing the generic default', async () => {
    let validated = false;
    let collectedRequest: unknown;
    let collectorCreated = false;
    const injectedCollector: SourceReportCollector = {
      observeToolResult: () => undefined,
      acceptReport: () => undefined,
      finalize: () => ({
        source: 'logs', status: 'unavailable', summary: 'collector-injected', findings: [], evidenceIds: [],
        businessTraceIds: [], missingEvidence: [], coverage: 0, toolCallsUsed: 0, durationMs: 0,
      }),
    };
    const tool = createLogsSubagentTool({
      ...evidenceOptions(),
      childAgentFactory: { create: (input) => createAgentRuntime({
        model: new ScriptedModel([{ text: 'no evidence collected', toolCalls: [] }]),
        workspaceRoots: [], includeExternalBash: false, tools: [...input.tools],
      }).agent },
      validateRequest: (value) => { validated = true; expect(value.service).toBe('checkout'); },
      collector: (input) => { collectorCreated = true; collectedRequest = input.request; return injectedCollector; },
    });

    const result = await drainTool(tool, {
      profileId: 'group-buy-market', service: 'checkout', start: '2026-09-14T00:00:00.000Z',
      end: '2026-09-14T01:00:00.000Z', question: '调查结算日志',
    }, 'parent-run-1');
    const report = result.blocks.find((block) => block.type === 'json');

    expect(validated).toBe(true);
    expect(collectorCreated).toBe(true);
    expect(collectedRequest).toMatchObject({ service: 'checkout', profileId: 'group-buy-market' });
    if (report?.type !== 'json' || typeof report.value !== 'object' || report.value === null) {
      throw new Error('expected source report JSON');
    }
    expect((report.value as Record<string, unknown>).summary).toBe('collector-injected');
  });

  it('binds capture-window observations to the actual child Tool input', async () => {
    const tool = createLogsSubagentTool({
      ...evidenceOptions(),
      childAgentFactory: { create: (input) => createAgentRuntime({
        model: new ScriptedModel([
          { toolCalls: [{ id: 'capture-mismatch', name: 'logs.capture', input: {
            service: 'checkout', start: '2026-09-14T00:10:00.000Z', end: '2026-09-14T00:20:00.000Z',
          } }] },
          { toolCalls: [{ id: 'report-mismatch', name: 'source_report', input: {
            summary: '模型称已验证完整调用链和根因。',
            findings: [{ kind: 'inference', statement: '数据库是根因', evidenceIds: ['evidence-1'] }],
            businessTraceIds: ['trace-1'], missingEvidence: [],
          } }] },
          { text: '取证完成。', toolCalls: [] },
        ]),
        workspaceRoots: [], includeExternalBash: false, tools: [...input.tools],
      }).agent },
      collector: ({ request }) => new LogsSourceReportCollector({ request }),
    });

    const response = await drainTool(tool, {
      profileId: 'group-buy-market', service: 'checkout', start: '2026-09-14T00:00:00.000Z',
      end: '2026-09-14T01:00:00.000Z', question: '调查结算日志',
    }, 'parent-run-1');
    const block = response.blocks.find((item) => item.type === 'json');

    if (block?.type !== 'json' || typeof block.value !== 'object' || block.value === null) {
      throw new Error('expected source report JSON');
    }
    const value = block.value as { source: string; status: string; summary: string; missingEvidence: string[];
      findings: Array<{ kind: string; statement: string }> };
    expect(value.source).toBe('logs');
    expect(value.status).toBe('partial');
    expect(value.missingEvidence).toContain('capture_window_mismatch');
    expect(value.missingEvidence).toContain('traces');
    expect(value.summary).not.toContain('已验证完整调用链');
    expect(value.summary).not.toContain('数据库是根因');
    expect(value.findings.some((finding) => finding.kind === 'observation' && finding.statement.includes('数据库是根因'))).toBe(false);
    expect(value.findings.some((finding) => finding.kind === 'inference' && finding.statement.startsWith('未验证推断：'))).toBe(true);
  });

  it('keeps the child Tool list, strict source_report schema, and stable source identities', () => {
    const collector = new DefaultSourceReportCollector({ knownEvidenceIds: ['evidence-1'] });
    const reportTool = createSourceReportTool(collector);

    expect(reportTool).toMatchObject({
      name: 'source_report', kind: 'utility', source: 'builtin', recoveryPolicy: 'replay_safe',
    });
    expect(reportTool.isConcurrencySafe?.({})).toBe(false);
    expect(reportTool.call?.({
      summary: '已完成。', findings: [{ kind: 'observation', statement: '发现异常。', evidenceIds: ['evidence-1'] }],
      businessTraceIds: [], missingEvidence: [],
    }, sourceReportCallOptions())).toEqual({ blocks: [{ type: 'json', value: { accepted: true } }] });
    expect(() => reportTool.call?.({ summary: 'invalid', findings: [], businessTraceIds: [], missingEvidence: [], coverage: 1 }, sourceReportCallOptions())).toThrow();
    expect(stableSourceChildRunId('logs', 'parent-run-1', 'parent-tool-1')).toBe(
      'source-child-logs-72b878d8f96985975683bd426fd359ff',
    );
    expect(stableSourceChildRunId('logs', 'parent-run-1', 'parent-tool-1')).not.toBe(
      stableSourceChildRunId('metrics', 'parent-run-1', 'parent-tool-1'),
    );
  });
});

function sourceReportCallOptions() {
  return {
    runId: 'child-run-1', stepId: 'child-step-1', signal: new AbortController().signal, mode: 'execute' as const,
  };
}

function evidenceOptions() {
  let recordedManifest: EvidenceManifestSummary | null = null;
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
    getVisible: (evidenceId) => Promise.resolve(recordedManifest?.evidenceId === evidenceId ? recordedManifest : null),
  };
  const recorder: StreamingEvidenceRecorder = {
    capture: (request: StreamingEvidenceCaptureRequest): Promise<EvidenceCaptureResult> => {
      recordedManifest = {
        ...manifest,
        evidenceId: request.evidenceId,
        runId: request.runId,
        stepId: request.stepId,
        toolCallId: request.toolCallId,
        captureKey: request.captureKey,
        queryDigest: request.queryDigest,
      };
      return Promise.resolve({
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
        manifest: recordedManifest,
        coverage: 1,
        truncated: false,
        missingEvidence: [],
      });
    },
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
