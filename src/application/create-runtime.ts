import { AgentHarness } from '../agent/agent-harness.js';
import type { ChatModel, CheckpointStore, Clock, DurableRunState, EventStore, EvidenceStore, Guardian, IdGenerator, MessageStore, Observability, Tool } from '../contracts/index.js';
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
import { InMemoryDurableState } from '../storage/in-memory-durable-state.js';
import { InMemoryEvidenceStore } from '../storage/in-memory-evidence-store.js';
import { VersionedCheckpointStoreAdapter } from '../storage/versioned-checkpoint-adapter.js';
import { ToolBatchExecutor } from '../tool/batch-executor.js';
import { createExternalBashTool } from '../tool/builtin/bash-tool.js';
import { ToolExecutionPipeline } from '../tool/execution-pipeline.js';
import { DefaultToolRunner } from '../tool/tool-runner.js';
import { Toolkit } from '../tool/toolkit.js';
import { ToolAdmission } from '../tool/admission.js';
import { ExternalToolResultService } from './external-tool-result-service.js';
import { DefaultEvidenceRecorder, type EvidenceRecorder } from './evidence-recorder.js';
import { HitlService } from './hitl-service.js';
import { EventFactoryV2 } from '../event/v2/event-factory.js';
import { EventPublisherV2, InMemoryProjectionFailureSink } from '../event/v2/event-publisher.js';
import { InMemoryEventMessageStore } from '../event/v2/in-memory-event-store.js';
import { ReplayBufferV2 } from '../event/v2/replay-buffer.js';
import { PublicEventProjectorV2 } from '../event/projectors/public-projector.js';
import { V1CompatibilityProjector } from '../event/projectors/v1-projector.js';
import { AuditProjectorV2 } from '../event/projectors/audit-projector.js';
import { LangSmithEventProjectorV2 } from '../event/projectors/langsmith-projector.js';
import { EventStreamService } from '../api/event-stream-service.js';
import { EventedChatModel } from '../model/evented-model.js';
import { RetryingChatModel, type RetryingChatModelOptions } from '../model/retrying-model.js';
import { ObservabilityModelAttemptObserver } from '../observability/model-attempt-observer.js';
import { CompositeModelAttemptObserver } from '../model/model-attempt-observer.js';
import { V2ModelAttemptObserver } from '../model/v2-attempt-observer.js';
import { MessageAssemblerV2 } from '../event/v2/message-assembler.js';
import { InMemoryProjectionCheckpointStore, ProjectionRunnerV2 } from '../event/v2/projection-runner.js';
import { createSqlitePersistence } from '../infrastructure/sqlite/persistence-bundle.js';

type EventMessageStore = EventStore & MessageStore;

export interface AgentRuntimeOptions {
  model: ChatModel;
  workspaceRoots: string[];
  tools?: Tool[];
  guardians?: Guardian[];
  hooks?: ToolHook[];
  checkpoints?: CheckpointStore;
  evidence?: EvidenceStore;
  evidenceRecorder?: EvidenceRecorder;
  observability?: Observability;
  clock?: Clock;
  ids?: IdGenerator;
  includeExternalBash?: boolean;
  actionMode?: 'dry_run' | 'execute';
  modelProvider?: string;
  modelName?: string;
  modelRetry?: RetryingChatModelOptions;
  /** Use a durable V2 event/message store. Defaults to the in-memory store for tests. */
  eventMessageStore?: EventMessageStore;
  /** SQLite path for the complete Event, Checkpoint, Evidence and execution persistence bundle. */
  sqlitePath?: string;
}

export function createAgentRuntime(options: AgentRuntimeOptions) {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIdGenerator;
  if (options.sqlitePath !== undefined && (options.checkpoints !== undefined || options.eventMessageStore !== undefined)) {
    throw new Error('sqlitePath cannot be combined with partial persistence injection');
  }
  const persistence = options.sqlitePath === undefined ? undefined : createSqlitePersistence({ path: options.sqlitePath, clock });
  const inMemoryDurable = persistence === undefined && options.checkpoints === undefined
    ? new InMemoryDurableState(clock)
    : undefined;
  const durableState: DurableRunState | undefined = persistence ?? (inMemoryDurable === undefined ? undefined : {
    checkpoints: inMemoryDurable,
    executions: inMemoryDurable,
    stateUnitOfWork: inMemoryDurable,
  });
  const checkpoints = options.checkpoints
    ?? (durableState === undefined ? new InMemoryCheckpointStore() : new VersionedCheckpointStoreAdapter(durableState.checkpoints));
  const evidence = options.evidence ?? persistence?.evidence ?? inMemoryDurable?.evidence ?? new InMemoryEvidenceStore();
  const observability = options.observability ?? new NoopObservability();
  const events = new EventBus();
  const eventFactory = new EventFactory(clock);
  const eventStoreV2: EventMessageStore = options.eventMessageStore
    ?? persistence?.eventMessages
    ?? new InMemoryEventMessageStore();
  const replayV2 = new ReplayBufferV2({ maxEvents: 2_000, maxBytes: 4_000_000 });
  const projectionFailuresV2 = persistence?.projectionFailures ?? new InMemoryProjectionFailureSink();
  const eventPublisherV2 = new EventPublisherV2(eventStoreV2, replayV2, projectionFailuresV2);
  const eventFactoryV2 = new EventFactoryV2(clock, ids);
  const v1ProjectorV2 = new V1CompatibilityProjector();
  eventPublisherV2.subscribe({
    name: 'v1-event-bus',
    project: (event) => Promise.all(v1ProjectorV2.project(event).map((legacy) => events.publish(legacy))).then(() => undefined),
  });
  const projectionCheckpointsV2 = persistence?.projectionCheckpoints ?? new InMemoryProjectionCheckpointStore();
  const auditProjectorV2 = new AuditProjectorV2();
  const auditProjectionRunnerV2 = new ProjectionRunnerV2(auditProjectorV2, projectionCheckpointsV2, projectionFailuresV2, { maxAttempts: 2 });
  const langSmithProjectorV2 = new LangSmithEventProjectorV2(observability);
  const langSmithProjectionRunnerV2 = new ProjectionRunnerV2(langSmithProjectorV2, projectionCheckpointsV2, projectionFailuresV2, { maxAttempts: 2 });
  const messageAssemblerV2 = new MessageAssemblerV2(eventStoreV2);
  eventPublisherV2.subscribe(auditProjectionRunnerV2);
  eventPublisherV2.subscribe(langSmithProjectionRunnerV2);
  eventPublisherV2.subscribe({ name: 'message-assembler', project: (event) => messageAssemblerV2.apply(event).then(() => undefined) });
  const publicProjectorV2 = new PublicEventProjectorV2();
  // Startup recovery is local-only by default. External LangSmith backfill stays explicit.
  const ready = eventPublisherV2.replayAll({ projectorNames: ['audit', 'message-assembler', 'v1-event-bus'] });
  const evidenceRecorder = options.evidenceRecorder ?? new DefaultEvidenceRecorder({
    evidence,
    events: { factory: eventFactoryV2, publisher: eventPublisherV2, store: eventStoreV2, correlationId: (runId) => `run:${runId}` },
  });
  const model = options.modelRetry === undefined
    ? options.model
    : new RetryingChatModel(options.model, {
      ...options.modelRetry,
      onFallback: async (info) => {
        await options.modelRetry?.onFallback?.(info);
        if (options.modelRetry?.fallback !== undefined) {
          await eventPublisherV2.publish(eventFactoryV2.create('MODEL_FALLBACK_ACTIVATED', {
            runId: info.runId,
            correlationId: `run:${info.runId}`,
            visibility: 'audit',
            durability: 'durable',
            stepId: info.stepId,
          }, {
            fromProvider: options.modelProvider ?? 'configured',
            fromModel: options.modelName ?? 'configured',
            toProvider: options.modelRetry.fallbackProvider ?? 'fallback',
            toModel: options.modelRetry.fallbackModel ?? 'fallback',
            reasonCode: info.reason.details.category as string,
          })).then(() => undefined);
        }
      },
      observer: options.modelRetry.observer ?? new CompositeModelAttemptObserver([
        new ObservabilityModelAttemptObserver(observability),
        new V2ModelAttemptObserver({ factory: eventFactoryV2, publisher: eventPublisherV2, provider: options.modelProvider ?? 'configured', model: options.modelName ?? 'configured', correlationId: (runId) => `run:${runId}`, ids, now: () => clock.now().getTime() }),
      ]),
    });
  const toolkit = new Toolkit();
  if (options.includeExternalBash !== false) toolkit.register(createExternalBashTool());
  for (const tool of options.tools ?? []) toolkit.register(tool);
  const guard = new GuardEngine([
    new BashGuardian(options.workspaceRoots),
    ...(options.guardians ?? []),
  ]);
  const hooks = new HookExecutor([
    new EvidenceBudgetHook(clock),
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
    {
      actionMode: options.actionMode ?? 'dry_run',
      deferV2ResultPublication: durableState !== undefined,
    },
    { factory: eventFactoryV2, publisher: eventPublisherV2, correlationId: (runId) => `run:${runId}` },
    durableState?.executions,
  );
  const batchExecutor = new ToolBatchExecutor(toolkit, pipeline, clock);
  const agent = new AgentHarness({
    model: new EventedChatModel(model, eventPublisherV2, eventFactoryV2, {
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
    ...(durableState === undefined ? {} : { durableState }),
    v2Events: { factory: eventFactoryV2, publisher: eventPublisherV2, correlationId: (runId: string) => `run:${runId}` },
  });
  return {
    agent,
    toolkit,
    events,
    checkpoints,
    durableState,
    evidence,
    evidenceRecorder,
    hitl: new HitlService(
      checkpoints,
      clock,
      { factory: eventFactoryV2, publisher: eventPublisherV2, correlationId: (runId) => `run:${runId}` },
      durableState,
    ),
    externalTools: new ExternalToolResultService(
      checkpoints,
      clock,
      toolkit,
      guard,
      hooks,
      events,
      eventFactory,
      { factory: eventFactoryV2, publisher: eventPublisherV2, correlationId: (runId) => `run:${runId}` },
      durableState,
    ),
    eventStoreV2,
    replayV2,
    eventPublisherV2,
    auditProjectorV2,
    projectionFailuresV2,
    projectionCheckpointsV2,
    auditProjectionRunnerV2,
    langSmithProjectionRunnerV2,
    ready,
    messageAssemblerV2,
    replayRun: (runId: string, afterSequence?: number, limit?: number) => eventPublisherV2.replayRun(runId, afterSequence, limit),
    eventStreamV2: new EventStreamService({ store: eventStoreV2, replay: replayV2, messages: eventStoreV2, source: eventPublisherV2, projector: publicProjectorV2 }),
    close: async (): Promise<void> => {
      try {
        await ready;
      } finally {
        persistence?.close();
      }
    },
  };
}
