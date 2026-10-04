import type { ChatModel, EvidenceCaptureBudget, SourceSubagentExecution, SourceSubagentRequest, Tool } from '../contracts/index.js';
import type { RuntimeToolPorts } from '../application/create-runtime.js';
import { LogsSourceReportCollector } from '../application/logs-source-report-collector.js';
import { SourceSubagentFailure } from '../application/source-subagent-runner.js';
import { validateLogsScope, logsLabQueryPolicy } from '../profiles/logs.js';
import { LocalEvidenceReader } from '../infrastructure/elk/local-evidence-reader.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../mcp/resilience.js';
import { createLazyElkEvidenceSource } from './lazy-elk-evidence-source.js';
import { createLogsSubagentTool } from './logs-subagent.js';
import { createSharedSourceChildAgentFactory } from './shared-source-child.js';
import type { ModelIdentity } from './model-identity.js';

const MAX_QUESTION_BYTES = 2 * 1024;
const MIN_CURSOR_SECRET_BYTES = 32;

const LOG_EVIDENCE_BUDGET: Readonly<EvidenceCaptureBudget> = Object.freeze({
  maxSourceBytes: 64 * 1024 * 1024,
  maxRecords: 50_000,
  maxDurationMs: 60_000,
  maxModelSummaryBytes: 16 * 1024,
  maxSamples: 3,
});

export interface LogsWebSourceOptions {
  mcpUrl: string;
  model: ChatModel;
  /** Stable across Web restarts so previously issued evidence cursors remain valid. */
  cursorSecret: string;
  modelIdentity?: ModelIdentity;
}

/** Compose the parent-facing Logs Subagent over the Web runtime's existing data plane. */
export function createLogsWebSource(
  ports: RuntimeToolPorts,
  options: LogsWebSourceOptions,
): readonly Tool[] {
  const { evidenceBlobs, evidenceManifests, streamingEvidenceRecorder } = ports;
  if (evidenceBlobs === undefined || evidenceManifests === undefined || streamingEvidenceRecorder === undefined) {
    throw new Error('Logs Web source requires the runtime-owned evidence data plane.');
  }
  if (typeof options.cursorSecret !== 'string' || options.cursorSecret.trim().length === 0
    || Buffer.byteLength(options.cursorSecret, 'utf8') < MIN_CURSOR_SECRET_BYTES) {
    throw new RangeError('Logs cursor secret must contain at least 32 UTF-8 bytes.');
  }

  const now = () => ports.clock.now().getTime();
  const executor = new ResilientExecutor(new SourceCircuitBreaker({ now }), { now });
  const source = createLazyElkEvidenceSource({
    mcpUrl: options.mcpUrl,
    executor,
    now,
    registerShutdownHook: (callback) => ports.registerShutdownHook(callback),
  });
  const reader = new LocalEvidenceReader({
    blobStore: evidenceBlobs,
    manifests: evidenceManifests,
    cursorSecret: options.cursorSecret,
    maxChunkBytes: 8 * 1024 * 1024,
    maxScanRecords: 50_000,
  });
  const childAgentFactory = createSharedSourceChildAgentFactory({
    model: options.model,
    ...(options.modelIdentity === undefined ? {} : { modelIdentity: options.modelIdentity }),
    workspaceRoots: [],
    checkpoints: ports.checkpoints,
    evidence: ports.evidence,
    evidenceRecorder: ports.evidenceRecorder,
    sharedEvents: ports.sharedEvents,
    clock: ports.clock,
    ids: ports.ids,
  });
  const logsSubagent = createLogsSubagentTool({
    source,
    recorder: streamingEvidenceRecorder,
    manifests: evidenceManifests,
    reader,
    budget: LOG_EVIDENCE_BUDGET,
    clock: ports.clock,
    childAgentFactory,
    checkpoints: ports.checkpoints,
    lifecycle: { ...ports.events, ids: ports.ids },
    validateRequest: (request, execution) => validateLogsRequest(request, execution, ports),
    collector: ({ request }) => new LogsSourceReportCollector({ request }),
  });
  return Object.freeze([logsSubagent]);
}

function validateLogsRequest(
  request: SourceSubagentRequest,
  execution: Omit<SourceSubagentExecution, 'childRunId'>,
  ports: RuntimeToolPorts,
): void {
  if (request.profileId !== 'simulation' || request.service !== 'checkout') {
    throw new SourceSubagentFailure('POLICY_DENIED', 'Logs request is outside the configured Profile.', false);
  }
  if (request.evidenceIds.length > 0) {
    throw new SourceSubagentFailure('POLICY_DENIED', 'Logs does not accept cross-source evidence hints.', false);
  }
  if (request.question.trim().length === 0 || Buffer.byteLength(request.question, 'utf8') > MAX_QUESTION_BYTES) {
    throw new SourceSubagentFailure('INVALID_INPUT', 'Logs request question exceeds the allowed size.', false);
  }
  if (execution.remainingToolCalls === undefined || execution.remainingToolCalls < 2
    || (execution.toolCallBudget !== undefined && execution.toolCallBudget.remaining < 2)) {
    throw new SourceSubagentFailure('BUDGET_EXCEEDED', 'Logs child requires two remaining Tool calls.', false);
  }
  try {
    validateLogsScope(request, logsLabQueryPolicy, ports.clock.now().getTime());
  } catch {
    throw new SourceSubagentFailure('INVALID_INPUT', 'Logs request must select the current checkout Profile window.', false);
  }
}
