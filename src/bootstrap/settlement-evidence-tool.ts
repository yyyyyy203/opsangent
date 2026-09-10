import { randomUUID } from 'node:crypto';
import type { EvidenceStore, Tool, ToolResponse } from '../contracts/index.js';
import { DefaultEvidenceRecorder, type EvidenceRecorder } from '../application/evidence-recorder.js';
import type { McpConnection } from '../mcp/types.js';
import { bindReadonlyMcpTools } from '../mcp/readonly-tools.js';
import { type ResilientExecutor, SourceFailure } from '../mcp/resilience.js';
import { settlementInput, settlementInputSchema, settlementRemoteName, settlementWireResult } from '../mcp/settlement-protocol.js';
import { assessSettlementMetrics, settlementLabRule } from '../profiles/settlement.js';

function decode(response: ToolResponse) {
  const json = response.blocks.filter((block) => block.type === 'json');
  if (response.isError || json.length !== 1 || json[0]?.type !== 'json') throw new SourceFailure('MCP_PROTOCOL_ERROR');
  const parsed = settlementWireResult.safeParse(json[0].value);
  if (!parsed.success) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  if (parsed.data.status === 'source_error') throw new SourceFailure(parsed.data.code);
  return parsed.data;
}

export async function bindSettlementEvidenceTool(options: {
  connection: McpConnection; recorder?: EvidenceRecorder; /** @deprecated Inject an EvidenceRecorder for audit-event publication. */ evidence?: EvidenceStore; executor: ResilientExecutor;
  signal: AbortSignal; id?: () => string; now?: () => number;
}): Promise<Tool> {
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;
  const recorder = options.recorder ?? (options.evidence === undefined ? undefined : new DefaultEvidenceRecorder({ evidence: options.evidence }));
  if (recorder === undefined) throw new Error('Settlement Evidence Tool requires an EvidenceRecorder');
  const validated: McpConnection = {
    connect: (signal) => options.connection.connect(signal),
    close: () => options.connection.close(),
    listTools: (signal) => options.connection.listTools(signal),
    async call(name, input, signal) {
      const response = await options.connection.call(name, input, signal);
      decode(response); // Inside the existing executor: one retry/circuit/budget authority.
      return response;
    },
  };
  const [base] = await bindReadonlyMcpTools(validated, [{ localName: 'metrics.settlement', remoteName: settlementRemoteName,
    description: '查询 checkout 结算指标，返回失败率、证据引用和缺失证据；不判断根因。',
    inputSchema: settlementInput, expectedRemoteSchema: settlementInputSchema,
    readOnly: true, idempotent: true, concurrencySafe: true,
  }], { signal: options.signal, executor: options.executor });
  if (!base?.call) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  return Object.freeze({ ...base, async *call(input, callOptions) {
    const invocation = base.call!(input, callOptions);
    if (!invocation || typeof invocation !== 'object' || !(Symbol.asyncIterator in invocation)) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    const response = yield* invocation;
    const result = decode(response);
    if (result.status === 'unavailable') return { blocks: [{ type: 'json', value: {
      status: 'insufficient_data', reason: result.reason, missingEvidence: ['metrics', 'logs', 'traces'],
    } }] };
    if (result.end - result.start !== 300 || result.end > now() / 1000 || now() / 1000 - result.end > 120
      || result.raw === undefined || result.counts.failed > result.counts.total) throw new SourceFailure('MCP_PROTOCOL_ERROR');
    const summary = { ...assessSettlementMetrics(result.counts, settlementLabRule),
      service: 'checkout', environment: 'simulation', start: result.start, end: result.end, missingEvidence: ['logs', 'traces'],
    };
    callOptions.signal.throwIfAborted();
    if (callOptions.toolCallId === undefined) throw new SourceFailure('STORAGE_ERROR');
    const evidenceId = id();
    const capturedAt = new Date(now()).toISOString();
    const failureRate = summary.failureRate === null ? 'unavailable' : `${(summary.failureRate * 100).toFixed(2)}%`;
    try { await recorder.capture({
      record: {
        evidenceId,
        runId: callOptions.runId,
        source: 'metric',
        summary,
        raw: result.raw,
        businessTraceIds: [],
        capturedAt,
        toolCallId: callOptions.toolCallId,
        captureKey: `metric:${callOptions.runId}:${callOptions.toolCallId}:0`,
      },
      stepId: callOptions.stepId,
      toolCallId: callOptions.toolCallId,
      coverage: 1,
      publicSummary: `结算指标状态为 ${summary.status}，失败率为 ${failureRate}。`,
    }); }
    catch { throw new SourceFailure('STORAGE_ERROR'); }
    callOptions.signal.throwIfAborted();
    return { blocks: [{ type: 'json', value: summary }, { type: 'evidence_ref', evidenceId }], evidenceIds: [evidenceId] };
  } } satisfies Tool);
}
