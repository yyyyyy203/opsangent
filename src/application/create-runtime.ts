import { AgentHarness } from '../agent/agent-harness.js';
import type { ChatModel, CheckpointStore, Clock, Guardian, IdGenerator, Observability, Tool } from '../contracts/index.js';
import { randomIdGenerator, systemClock } from '../contracts/index.js';
import { RuleBasedContextCompressor } from '../context-compressor/rule-based-compressor.js';
import { EventBus } from '../event/event-bus.js';
import { EventFactory } from '../event/event-factory.js';
import { BashGuardian } from '../guard/bash-guardian.js';
import { GuardEngine } from '../guard/guard-engine.js';
import { EvidenceBudgetHook } from '../hooks/evidence-budget-hook.js';
import { HookExecutor } from '../hooks/hook-executor.js';
import { RiskActionHook } from '../hooks/risk-action-hook.js';
import type { ToolHook } from '../hooks/types.js';
import { NoopObservability } from '../observability/noop-observability.js';
import { InMemoryCheckpointStore } from '../storage/in-memory-checkpoint-store.js';
import { ToolBatchExecutor } from '../tool/batch-executor.js';
import { createExternalBashTool } from '../tool/builtin/bash-tool.js';
import { ToolExecutionPipeline } from '../tool/execution-pipeline.js';
import { DefaultToolRunner } from '../tool/tool-runner.js';
import { Toolkit } from '../tool/toolkit.js';
import { ToolAdmission } from '../tool/admission.js';
import { ExternalToolResultService } from './external-tool-result-service.js';
import { HitlService } from './hitl-service.js';
import { EventFactoryV2 } from '../event/v2/event-factory.js';
import { EventPublisherV2, InMemoryProjectionFailureSink } from '../event/v2/event-publisher.js';
import { InMemoryEventMessageStore } from '../event/v2/in-memory-event-store.js';
import { ReplayBufferV2 } from '../event/v2/replay-buffer.js';
import { PublicEventProjectorV2 } from '../event/projectors/public-projector.js';
import { AuditProjectorV2 } from '../event/projectors/audit-projector.js';
import { LangSmithEventProjectorV2 } from '../event/projectors/langsmith-projector.js';
import { EventStreamService } from '../api/event-stream-service.js';
import { EventedChatModel } from '../model/evented-model.js';

export interface AgentRuntimeOptions {
  model: ChatModel;
  workspaceRoots: string[];
  tools?: Tool[];
  guardians?: Guardian[];
  hooks?: ToolHook[];
  checkpoints?: CheckpointStore;
  observability?: Observability;
  clock?: Clock;
  ids?: IdGenerator;
  includeExternalBash?: boolean;
  actionMode?: 'dry_run' | 'execute';
  modelProvider?: string;
  modelName?: string;
}

export function createAgentRuntime(options: AgentRuntimeOptions) {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIdGenerator;
  const checkpoints = options.checkpoints ?? new InMemoryCheckpointStore();
  const observability = options.observability ?? new NoopObservability();
  const events = new EventBus();
  const eventFactory = new EventFactory(clock);
  const eventStoreV2 = new InMemoryEventMessageStore();
  const replayV2 = new ReplayBufferV2({ maxEvents: 2_000, maxBytes: 4_000_000 });
  const projectionFailuresV2 = new InMemoryProjectionFailureSink();
  const eventPublisherV2 = new EventPublisherV2(eventStoreV2, replayV2, projectionFailuresV2);
  const eventFactoryV2 = new EventFactoryV2(clock, ids);
  const auditProjectorV2 = new AuditProjectorV2();
  const langSmithProjectorV2 = new LangSmithEventProjectorV2(observability);
  eventPublisherV2.subscribe(auditProjectorV2);
  eventPublisherV2.subscribe(langSmithProjectorV2);
  const publicProjectorV2 = new PublicEventProjectorV2();
  const toolkit = new Toolkit();
  if (options.includeExternalBash !== false) toolkit.register(createExternalBashTool());
  for (const tool of options.tools ?? []) toolkit.register(tool);
  const guard = new GuardEngine([
    new BashGuardian(options.workspaceRoots),
    ...(options.guardians ?? []),
  ]);
  const hooks = new HookExecutor([
    new EvidenceBudgetHook(),
    new RiskActionHook(clock),
    ...(options.hooks ?? []),
  ]);
  const pipeline = new ToolExecutionPipeline(
    toolkit,
    guard,
    hooks,
    new DefaultToolRunner(),
    checkpoints,
    events,
    eventFactory,
    observability,
    clock,
    { actionMode: options.actionMode ?? 'dry_run' },
  );
  const batchExecutor = new ToolBatchExecutor(toolkit, pipeline, clock);
  const agent = new AgentHarness({
    model: new EventedChatModel(options.model, eventPublisherV2, eventFactoryV2, {
      provider: options.modelProvider ?? 'configured',
      model: options.modelName ?? 'configured',
      purpose: 'inspection',
      correlationId: (runId) => `run:${runId}`,
      clock,
      ids,
    }),
    toolkit,
    batchExecutor,
    checkpoints,
    compressor: new RuleBasedContextCompressor({
      maxMessagesBeforeL1: 40,
      maxSerializedBytesBeforeL2: 256_000,
      keepRecentMessages: 16,
    }),
    events,
    eventFactory,
    observability,
    clock,
    ids,
    admission: new ToolAdmission(toolkit),
    v2Events: { factory: eventFactoryV2, publisher: eventPublisherV2, correlationId: (runId: string) => `run:${runId}` },
  });
  return {
    agent,
    toolkit,
    events,
    checkpoints,
    hitl: new HitlService(checkpoints, clock, { factory: eventFactoryV2, publisher: eventPublisherV2, correlationId: (runId) => `run:${runId}` }),
    externalTools: new ExternalToolResultService(
      checkpoints,
      clock,
      toolkit,
      guard,
      hooks,
      events,
      eventFactory,
      { factory: eventFactoryV2, publisher: eventPublisherV2, correlationId: (runId) => `run:${runId}` },
    ),
    eventStoreV2,
    replayV2,
    eventPublisherV2,
    auditProjectorV2,
    projectionFailuresV2,
    eventStreamV2: new EventStreamService({ store: eventStoreV2, replay: replayV2, messages: eventStoreV2, source: eventPublisherV2, projector: publicProjectorV2 }),
  };
}
