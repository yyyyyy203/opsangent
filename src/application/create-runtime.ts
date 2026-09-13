import { AgentHarness } from '../agent/agent-harness.js';
import type {
  ChatModel,
  CheckpointStore,
  Clock,
  DurableRunState,
  EventStore,
  EvidenceStore,
  EvidenceBlobStore,
  EvidenceManifestStore,
  StreamingEvidenceRecorder,
  Guardian,
  IdGenerator,
  ImpactSurfaceProvider,
  MessageStore,
  Observability,
  ProfileResolver,
  Tool,
  ToolLifecycleObserver,
} from '../contracts/index.js';
import { randomIdGenerator, systemClock } from '../contracts/index.js';
import { RuleBasedContextCompressor } from '../context-compressor/rule-based-compressor.js';
import { DefaultToolResultCompactor } from '../context-compressor/tool-result-compactor.js';
import type { ToolResultCompactor } from '../context-compressor/types.js';
import { EventBus } from '../event/event-bus.js';
import { EventFactory } from '../event/event-factory.js';
import { BashGuardian } from '../guard/bash-guardian.js';
import { GuardEngine } from '../guard/guard-engine.js';
import { BatchGovernanceEvaluator } from '../guard/governance-evaluator.js';
import { GuardianCoordinator } from '../guard/guardian-coordinator.js';
import { ImpactSurfaceGuardian } from '../guard/impact-surface-guardian.js';
import { McpGuardian } from '../guard/mcp-guardian.js';
import { ProfileGuardian } from '../guard/profile-guardian.js';
import { DeterministicRiskPolicy } from '../guard/risk-policy.js';
import { EvidenceBudgetHook } from '../hooks/evidence-budget-hook.js';
import { AuditHook } from '../hooks/audit-hook.js';
import { CheckpointHook } from '../hooks/checkpoint-hook.js';
import { ControlHookExecutor } from '../hooks/control-hook-executor.js';
import { DiagnosisMemoryHook } from '../hooks/diagnosis-memory-hook.js';
import { HookExecutor } from '../hooks/hook-executor.js';
import { HookRegistry } from '../hooks/hook-registry.js';
import { LifecycleObserverExecutor } from '../hooks/lifecycle-observer-executor.js';
import { PolicyDenyHook } from '../hooks/policy-deny-hook.js';
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
import { DurableOutboxDispatcher } from '../event/v2/durable-outbox-dispatcher.js';
import { InMemoryEventMessageStore } from '../event/v2/in-memory-event-store.js';
import { OutboxedEventPublisher } from '../event/v2/outboxed-event-publisher.js';
import { ReplayBufferV2 } from '../event/v2/replay-buffer.js';
import { PublicEventProjectorV2 } from '../event/projectors/public-projector.js';
import { V1CompatibilityProjector } from '../event/projectors/v1-projector.js';
import { AuditProjectorV2 } from '../event/projectors/audit-projector.js';
import { LangSmithEventProjectorV2 } from '../event/projectors/langsmith-projector.js';
import { EventStreamService } from '../api/event-stream-service.js';
import { EventedChatModel } from '../model/evented-model.js';
import { CompactingChatModel } from '../model/compacting-model.js';
import { RetryingChatModel, type RetryingChatModelOptions } from '../model/retrying-model.js';
import { ObservabilityModelAttemptObserver } from '../observability/model-attempt-observer.js';
import { CompositeModelAttemptObserver } from '../model/model-attempt-observer.js';
import { V2ModelAttemptObserver } from '../model/v2-attempt-observer.js';
import { MessageAssemblerV2 } from '../event/v2/message-assembler.js';
import { InMemoryProjectionCheckpointStore, ProjectionRunnerV2 } from '../event/v2/projection-runner.js';
import { createSqlitePersistence } from '../infrastructure/sqlite/persistence-bundle.js';
import { UnavailableImpactSurfaceProvider } from '../profiles/unavailable-impact-surface-provider.js';
import { DefaultStreamingEvidenceRecorder } from './streaming-evidence-recorder.js';

type EventMessageStore = EventStore & MessageStore;

/** Ports exposed to late-bound Tool factories without importing infrastructure into the Harness. */
export interface RuntimeToolPorts {
  evidenceBlobs?: EvidenceBlobStore;
  evidenceManifests?: EvidenceManifestStore;
  streamingEvidenceRecorder?: StreamingEvidenceRecorder;
  toolResultCompactor: ToolResultCompactor;
}

export type RuntimeToolFactory = (ports: RuntimeToolPorts) => readonly Tool[];

export interface AgentRuntimeOptions {
  model: ChatModel;
  workspaceRoots: string[];
  tools?: Tool[];
  /** Build tools after optional runtime-owned ports exist and before the Toolkit is frozen. */
  toolFactories?: readonly RuntimeToolFactory[];
  guardians?: Guardian[];
  hooks?: ToolHook[];
  lifecycleObservers?: ToolLifecycleObserver[];
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
  /** Resolve the immutable Profile snapshot used by governance-enabled Runs. */
  profileResolver?: ProfileResolver;
  /** Capture the live impact surface once per admitted Tool batch. */
  impactSurfaceProvider?: ImpactSurfaceProvider;
  /** Opt into Profile/Impact/Guardian/RiskPolicy evaluation for new Runs. */
  enableGovernance?: boolean;
  /** Use a durable V2 event/message store. Defaults to the in-memory store for tests. */
  eventMessageStore?: EventMessageStore;
  /** SQLite path for the complete Event, Checkpoint, Evidence and execution persistence bundle. */
  sqlitePath?: string;
  /** Explicit absolute Blob root used only when SQLite-backed L0 Blob storage is desired. */
  evidenceBlobRootPath?: string;
  /** Optional L0 data-plane and model-view ports. */
  l0?: {
    blobStore?: EvidenceBlobStore;
    manifests?: EvidenceManifestStore;
    streamingEvidenceRecorder?: StreamingEvidenceRecorder;
    toolResultCompactor?: ToolResultCompactor;
  };
}

export function createAgentRuntime(options: AgentRuntimeOptions) {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIdGenerator;
  if (options.enableGovernance === true && options.profileResolver === undefined) {
    throw new Error('profileResolver is required when governance is enabled.');
  }
  if (options.sqlitePath !== undefined && (options.checkpoints !== undefined || options.eventMessageStore !== undefined)) {
    throw new Error('sqlitePath cannot be combined with partial persistence injection');
  }
  const persistence = options.sqlitePath === undefined ? undefined : createSqlitePersistence({
    path: options.sqlitePath,
    clock,
    ids,
    ...(options.evidenceBlobRootPath === undefined ? {} : { evidenceBlobRootPath: options.evidenceBlobRootPath }),
  });
  const inMemoryDurable = persistence === undefined && options.checkpoints === undefined
    ? new InMemoryDurableState(clock)
    : undefined;
  const durableState: DurableRunState | undefined = persistence ?? inMemoryDurable;
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
  const durableOutboxDispatcher = durableState === undefined
    ? undefined
    : new DurableOutboxDispatcher({ outbox: durableState.outbox, publisher: eventPublisherV2, clock });
  const publishingV2 = durableOutboxDispatcher === undefined
    ? eventPublisherV2
    : new OutboxedEventPublisher({
      outbox: durableState!.outbox,
      dispatcher: durableOutboxDispatcher,
      publisher: eventPublisherV2,
      eventStore: eventStoreV2,
      clock,
    });
  const v2EventDependencies = {
    factory: eventFactoryV2,
    publisher: publishingV2,
    correlationId: (runId: string) => `run:${runId}`,
    ...(durableOutboxDispatcher === undefined ? {} : { dispatcher: durableOutboxDispatcher }),
  };
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
  const ready = Promise.resolve().then(async () => {
    await durableOutboxDispatcher?.drainAll();
    // The V1 bridge is live-delivery only and has no durable projection
    // cursor. Replaying it after draining the Outbox would duplicate events.
    return eventPublisherV2.replayAll({ projectorNames: ['audit', 'message-assembler'] });
  });
  const evidenceBlobs = options.l0?.blobStore ?? persistence?.evidenceBlobs;
  const evidenceManifests = options.l0?.manifests ?? persistence?.evidenceManifests;
  const toolResultCompactor = options.l0?.toolResultCompactor ?? new DefaultToolResultCompactor();
  const l0DataPlaneRequested = options.evidenceBlobRootPath !== undefined
    || options.l0?.blobStore !== undefined
    || options.l0?.manifests !== undefined;
  if (l0DataPlaneRequested && options.l0?.streamingEvidenceRecorder === undefined
    && (evidenceBlobs === undefined || evidenceManifests === undefined)) {
    persistence?.close();
    throw new Error('L0 Blob storage requires both blobStore and manifests ports.');
  }
  const streamingEvidenceRecorder = options.l0?.streamingEvidenceRecorder
    ?? (evidenceBlobs === undefined || evidenceManifests === undefined
      ? undefined
      : new DefaultStreamingEvidenceRecorder({
        blobStore: evidenceBlobs,
        manifests: evidenceManifests,
        clock,
        ids,
        events: { factory: eventFactoryV2, publisher: publishingV2, store: eventStoreV2, correlationId: (runId) => `run:${runId}` },
      }));
  const evidenceRecorder = options.evidenceRecorder ?? new DefaultEvidenceRecorder({
    evidence,
    events: { factory: eventFactoryV2, publisher: publishingV2, store: eventStoreV2, correlationId: (runId) => `run:${runId}` },
  });
  let factoryTools: Tool[] = [];
  try {
    factoryTools = (options.toolFactories ?? []).flatMap((factory) => [...factory({
      ...(evidenceBlobs === undefined ? {} : { evidenceBlobs }),
      ...(evidenceManifests === undefined ? {} : { evidenceManifests }),
      ...(streamingEvidenceRecorder === undefined ? {} : { streamingEvidenceRecorder }),
      toolResultCompactor,
    })]);
  } catch (error) {
    persistence?.close();
    throw error;
  }
  const model = options.modelRetry === undefined
    ? options.model
    : new RetryingChatModel(options.model, {
      ...options.modelRetry,
      onFallback: async (info) => {
        await options.modelRetry?.onFallback?.(info);
        if (options.modelRetry?.fallback !== undefined) {
          await publishingV2.publish(eventFactoryV2.create('MODEL_FALLBACK_ACTIVATED', {
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
        new V2ModelAttemptObserver({ factory: eventFactoryV2, publisher: publishingV2, provider: options.modelProvider ?? 'configured', model: options.modelName ?? 'configured', correlationId: (runId) => `run:${runId}`, ids, now: () => clock.now().getTime() }),
      ]),
    });
  const toolkit = new Toolkit();
  if (options.includeExternalBash !== false) toolkit.register(createExternalBashTool());
  for (const tool of options.tools ?? []) toolkit.register(tool);
  for (const tool of factoryTools) toolkit.register(tool);
  const guard = new GuardEngine([
    new BashGuardian(options.workspaceRoots),
    ...(options.guardians ?? []),
  ]);
  const governanceEvaluator = options.enableGovernance === true
    ? new BatchGovernanceEvaluator({
      resolveTool: (name) => toolkit.get(name),
      impactSurfaceProvider: options.impactSurfaceProvider ?? new UnavailableImpactSurfaceProvider(),
      guardianCoordinator: new GuardianCoordinator([
        new BashGuardian(options.workspaceRoots),
        new McpGuardian(),
        new ProfileGuardian(clock),
        new ImpactSurfaceGuardian(),
        ...(options.guardians ?? []),
      ], { clock }),
      riskPolicy: new DeterministicRiskPolicy(),
      clock,
    })
    : undefined;
  const hooks = new HookExecutor(options.hooks ?? []);
  const controlHooks = new ControlHookExecutor([
    new EvidenceBudgetHook(clock),
    new PolicyDenyHook(),
    new RiskActionHook(clock),
  ]);
  const lifecycleObservers = new LifecycleObserverExecutor([
    new AuditHook(),
    new CheckpointHook(),
    new DiagnosisMemoryHook(),
    ...(options.lifecycleObservers ?? []),
  ]);
  const hookRegistry = new HookRegistry([...new Set([
    'risk-action',
    'external-tool-execution',
    ...(options.hooks ?? []).map((hook) => hook.id),
  ])]);
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
    { factory: eventFactoryV2, publisher: publishingV2, correlationId: (runId) => `run:${runId}` },
    durableState?.executions,
    governanceEvaluator,
    controlHooks,
    lifecycleObservers,
  );
  const batchExecutor = new ToolBatchExecutor(toolkit, pipeline, clock);
  const agent = new AgentHarness({
    model: new EventedChatModel(new CompactingChatModel(model, toolResultCompactor), publishingV2, eventFactoryV2, {
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
      toolResultCompactor,
    }),
    events,
    eventFactory,
    observability,
    clock,
    ids,
    admission: new ToolAdmission(toolkit),
    ...(options.enableGovernance === true && options.profileResolver !== undefined
      ? { profileResolver: options.profileResolver }
      : {}),
    ...(durableState === undefined ? {} : { durableState }),
    hookRegistry,
    v2Events: v2EventDependencies,
  });
  return {
    agent,
    toolkit,
    events,
    checkpoints,
    durableState,
    evidence,
    evidenceBlobs,
    evidenceManifests,
    streamingEvidenceRecorder,
    toolResultCompactor,
    evidenceRecorder,
    hitl: new HitlService(
      checkpoints,
      clock,
      v2EventDependencies,
      durableState,
      hookRegistry,
      toolkit,
    ),
    externalTools: new ExternalToolResultService(
      checkpoints,
      clock,
      toolkit,
      guard,
      hooks,
      events,
      eventFactory,
      v2EventDependencies,
      durableState,
      hookRegistry,
    ),
    eventStoreV2,
    replayV2,
    eventPublisherV2,
    auditProjectorV2,
    projectionFailuresV2,
    projectionCheckpointsV2,
    hookRegistry,
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
