import type { ChatModel, Tool } from '../contracts/index.js';
import type { RuntimeToolPorts } from '../application/create-runtime.js';
import { createMetricsSubagentTool } from './metrics-subagent.js';
import { createLazySettlementEvidenceTool } from './lazy-settlement-tool.js';
import { createSharedSourceChildAgentFactory } from './shared-source-child.js';
import { settlementMetricsLabProfile } from '../profiles/settlement.js';
import { ResilientExecutor, SourceCircuitBreaker } from '../mcp/resilience.js';
import type { ModelIdentity } from './model-identity.js';

export interface MetricsWebSourceOptions {
  mcpUrl: string;
  model: ChatModel;
  modelIdentity?: ModelIdentity;
}

/**
 * Compose the simulation source at the Web boundary.
 *
 * The returned list is intentionally parent-facing only. The low-level MCP
 * Tool is captured by the Metrics child factory and connects lazily on first
 * use, so an unavailable source does not prevent the Web host from starting.
 */
export function createMetricsWebSource(
  ports: RuntimeToolPorts,
  options: MetricsWebSourceOptions,
): readonly Tool[] {
  const now = () => ports.clock.now().getTime();
  const executor = new ResilientExecutor(
    new SourceCircuitBreaker({ now }),
    { now },
  );
  const lazySettlement = createLazySettlementEvidenceTool({
    mcpUrl: options.mcpUrl,
    recorder: ports.evidenceRecorder,
    executor,
    clock: ports.clock,
    onClose: (callback) => ports.registerShutdownHook(callback),
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
  const metricsSubagent = createMetricsSubagentTool({
    profile: settlementMetricsLabProfile,
    settlementTool: lazySettlement.tool,
    childAgentFactory,
    checkpoints: ports.checkpoints,
    clock: ports.clock,
    lifecycle: { ...ports.events, ids: ports.ids },
  });
  return Object.freeze([metricsSubagent]);
}
