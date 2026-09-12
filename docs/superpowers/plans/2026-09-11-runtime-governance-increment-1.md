# Runtime Governance Increment 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the shared governance contracts, checkpoint migration, `LOOP_DETECTED` V2 event, transactional durable-event Outbox, and the first state-transition-safe publishing path.

**Architecture:** This increment builds from stable public contracts downward: governance defaults and codecs first, then memory/SQLite transition parity, then an Outbox dispatcher and runtime composition, and finally the Harness/HITL/external-result bridges. `EventPublisherV2` remains the single event-store and projector implementation; the Outbox only delays durable publication until its associated durable state has committed.

**Tech Stack:** TypeScript, Node.js 20, pnpm, Vitest, Zod, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md`

## Global Constraints

- Implement only Spec §15 increment 1; do not start Profile/Impact/Guardian, Hook, Loop detector, or compression behavior.
- `contracts/` depends on no implementation modules; Harness continues to depend only on injected contracts.
- Add fields and event types compatibly; do not rename V1 events or change existing payload semantics.
- Every Outbox fact has a stable `eventId` before durable commit; identical retries are idempotent and same-ID divergent content fails closed.
- SQLite changes use an additive forward migration; never rewrite historical EventStore or checkpoint rows.
- Checkpoint/ToolExecution/Outbox state changes use CAS and one local SQLite transaction.
- Raw evidence, full tool input, credentials, and internal paths must not enter public V2 event payloads or Outbox diagnostics.
- All new time and ID behavior is injected through existing `Clock` and `IdGenerator` contracts.
- Keep the worktree on `codex/event-message-v2`; preserve unrelated user changes.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/contracts/governance.ts` | Stable governance, legacy-profile, loop-state, compression-state, and batch-governance value types plus deterministic initial-state factory. |
| `src/contracts/context.ts` | Additive `governance` and pending-batch governance snapshot fields. |
| `src/contracts/storage.ts` | Transition and Outbox ports shared by memory, SQLite, dispatcher, and Harness. |
| `src/storage/durable-codec.ts` | Centralized v1 checkpoint-to-governance migration and strict parsing of new persisted fields. |
| `src/contracts/event-v2/subsystem.ts` | Add the V2-only `LOOP_DETECTED` payload and Zod schema. |
| `src/storage/in-memory-durable-state.ts` | In-memory contract implementation for atomic transition and Outbox behavior. |
| `src/infrastructure/sqlite/migrations.ts` | Add `durable_event_outbox` table and bounded-dispatch index as the next forward migration. |
| `src/infrastructure/sqlite/durable-state-store.ts` | Insert Outbox rows in the same checkpoint/execution transaction. |
| `src/infrastructure/sqlite/event-outbox-store.ts` | Query and publish-mark adapter for the SQLite Outbox table. |
| `src/event/v2/durable-outbox-dispatcher.ts` | Bounded, idempotent post-commit event dispatch through `EventPublisherV2Like`. |
| `src/event/v2/outboxed-event-publisher.ts` | Wrap ordinary durable producers so they enqueue first; transient deltas continue directly. |
| `src/application/create-runtime.ts` | Compose durable state, Outbox, dispatcher, wrapper, startup drain, and recovery dependencies. |
| `src/agent/agent-harness.ts` | Atomically pair the transition-critical Run/ToolResult events with their checkpoint/execution updates, then yield V1 only after V2 dispatch. |
| `src/application/hitl-service.ts` | Pair confirmation state changes and their durable V2 facts with the transition port. |
| `src/application/external-tool-result-service.ts` | Pair externally returned result state and durable result events with the transition port. |

## Task 1: Define governance and compatibility contracts

**Files:**

- Create: `src/contracts/governance.ts`
- Modify: `src/contracts/context.ts`
- Modify: `src/contracts/tool.ts`
- Modify: `src/contracts/message.ts`
- Modify: `src/contracts/message-v2/schema.ts`
- Modify: `src/contracts/index.ts`
- Modify: `src/storage/durable-codec.ts`
- Modify: `src/agent/agent-harness.ts`
- Test: `test/governance-contract.test.ts`
- Test: `test/message-v2-contract.test.ts`

**Consumes:** `AgentContext`, `PendingToolBatch`, `Tool`, `ContextSummary`, `checkpointChecksum`, and existing Zod codecs.

**Produces:** `RunGovernanceState`, `ResolvedProfileSnapshot`, `LoopState`, `CompressionState`, `ToolBatchGovernanceSnapshot`, `createInitialRunGovernanceState()`, and centralized legacy checkpoint migration.

- [x] **Step 1: Write failing governance migration tests**

```ts
it('migrates a legacy checkpoint into conservative governance defaults', () => {
  const parsed = parseAgentContext(legacyContext('group-buy-market'));

  expect(parsed.governance).toMatchObject({
    schemaVersion: 1,
    profile: { profileId: 'group-buy-market', revision: 'legacy/v1', source: 'legacy_checkpoint' },
    loop: { consecutiveCount: 0, level: 'none', blockedSignatures: [] },
    compression: { summaryVersion: 0, lastLevel: 'none' },
  });
});

it('keeps an already persisted governance snapshot byte-for-byte stable', () => {
  const original = contextWithGovernance();
  expect(parseAgentContext(original).governance).toEqual(original.governance);
});
```

Add a Message V2 test whose `context_summary.summary` omits every new optional reference field and still parses, then a second test with `sourceMessageIds`, `keyToolCalls`, `evidenceIds`, `confirmationIds`, `riskRuleIds`, and `summaryVersion` populated.

- [x] **Step 2: Run focused tests and verify the expected RED failure**

Run: `pnpm vitest run test/governance-contract.test.ts test/message-v2-contract.test.ts`

Expected: `governance` is absent or rejected and optional summary references are rejected before the implementation exists.

- [x] **Step 3: Add minimal additive public contracts and codec migration**

Create `governance.ts` with these stable value boundaries:

```ts
export interface ResolvedProfileSnapshot {
  profileId: string;
  revision: string;
  digest: string;
  serviceName: string;
  serviceLevel: 'S0' | 'S1' | 'S2' | 'S3';
  timezone: string;
  allowedActions: string[];
  forbiddenActions: string[];
  changeFreezePeriods: ChangeFreezePeriod[];
  impactPolicy: ImpactPolicy;
  policyVersion: string;
  capturedAt: string;
  source: 'legacy_checkpoint' | 'resolved';
}

export interface RunGovernanceState {
  schemaVersion: 1;
  profile: ResolvedProfileSnapshot;
  loop: LoopState;
  compression: CompressionState;
}

export function createInitialRunGovernanceState(input: {
  profileId: string;
  capturedAt: string;
}): RunGovernanceState;
```

The factory must make a deterministic, conservative `legacy/v1` snapshot: `source: 'legacy_checkpoint'`, `serviceLevel: 'S0'`, empty action lists, UTC timezone, zeroed loop state, and `lastLevel: 'none'`. Derive its digest with the existing stable checksum utility and a versioned input object; do not use random IDs or current wall-clock time.

Make `AgentContext.governance` and `PendingToolBatch.governance` optional. Add optional `Tool.source` with the five sources defined by the Spec. Add only optional `ContextSummary` references. In `durable-codec.ts`, parse an existing governance value strictly; otherwise construct it exactly once from `profileId` and `budget.startedAt`. Update both legacy and V2 message schemas to permit omitted optional fields. Initialize `governance` in `AgentHarness.createContext()` with its injected clock.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run test/governance-contract.test.ts test/message-v2-contract.test.ts`

Expected: all new migration and compatibility assertions pass; existing Message V2 fixtures remain valid.

- [x] **Step 5: Commit the contract layer**

```bash
git add src/contracts/governance.ts src/contracts/context.ts src/contracts/tool.ts src/contracts/message.ts src/contracts/message-v2/schema.ts src/contracts/index.ts src/storage/durable-codec.ts src/agent/agent-harness.ts test/governance-contract.test.ts test/message-v2-contract.test.ts
git commit -m "feat: add governance compatibility contracts"
```

## Task 2: Register the V2-only loop fact

**Files:**

- Modify: `src/contracts/event-v2/subsystem.ts`
- Test: `test/event-v2-contract.test.ts`

**Consumes:** the existing `SubsystemEventPayloadMap`, `subsystemEventPayloadSchemaMap`, `AgentEventPayloadMap`, and generic V2 event parser.

**Produces:** runtime-validated `LOOP_DETECTED` with no V1 EventType change.

- [x] **Step 1: Write the failing V2 event contract test**

```ts
it('registers and validates LOOP_DETECTED without adding a V1 event', () => {
  expect(AGENT_EVENT_TYPES_V2).toContain('LOOP_DETECTED');
  expect(parseAgentEventV2(loopDetectedEvent())).toMatchObject({
    type: 'LOOP_DETECTED',
    payload: { level: 'hard', repeatCount: 5, action: 'signature_blocked' },
  });
});
```

Use a hand-written payload with `toolName`, `signatureDigest`, and `stage`; add a malformed payload assertion where `repeatCount: 0` is rejected.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run test/event-v2-contract.test.ts`

Expected: the catalog does not contain `LOOP_DETECTED`.

- [x] **Step 3: Add the event map entry and strict Zod schema**

```ts
LOOP_DETECTED: {
  level: 'warn' | 'hard' | 'force_break';
  repeatCount: number;
  toolName: Identifier;
  signatureDigest: Identifier;
  action: 'hint_injected' | 'signature_blocked' | 'run_terminated';
  stage: SubagentStage;
};
```

Use `z.number().int().positive()` for `repeatCount`. Do not edit V1 `EventType`, its payload map, or V1 projector.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run test/event-v2-contract.test.ts`

Expected: the generic schema recognizes the new event and rejects malformed data.

- [x] **Step 5: Commit the V2 event addition**

```bash
git add src/contracts/event-v2/subsystem.ts test/event-v2-contract.test.ts
git commit -m "feat: add loop detected v2 event contract"
```

## Task 3: Add durable transition and Outbox storage parity

**Files:**

- Modify: `src/contracts/event-store.ts`
- Modify: `src/contracts/storage.ts`
- Modify: `src/storage/in-memory-durable-state.ts`
- Modify: `src/infrastructure/sqlite/migrations.ts`
- Modify: `src/infrastructure/sqlite/durable-state-store.ts`
- Create: `src/infrastructure/sqlite/event-outbox-store.ts`
- Modify: `src/infrastructure/sqlite/persistence-bundle.ts`
- Modify: `src/infrastructure/sqlite/index.ts`
- Test: `test/durable-event-outbox-contract.test.ts`
- Test: `test/sqlite-durable-state.test.ts`

**Consumes:** `PendingAgentEventV2`, CAS checkpoints, ToolExecution journal states, stable JSON checksums, and the existing V2 EventStore idempotence behavior.

**Produces:** `DurableTransitionUnitOfWork`, `DurableEventOutbox`, in-memory/SQLite implementations, and an additive `durable_event_outbox` table.

- [x] **Step 1: Write shared backend contract tests**

```ts
describe.each(['memory', 'sqlite'] as const)('%s durable outbox', (backend) => {
  it('commits checkpoint, terminal execution, and pending event atomically', async () => {
    const saved = await state.transitions.commit({
      expectedRevision: checkpoint.revision,
      context: checkpoint.context,
      execution: { kind: 'completed', record, result },
      outboxEvents: [toolResultEvent],
    });

    expect(saved.context.pendingToolBatch?.completedResults).toEqual([result]);
    expect(await state.outbox.listPending({ runId: 'run-1', limit: 10 })).toMatchObject([{ event: toolResultEvent }]);
  });

  it('leaves no event queued when its checkpoint CAS conflicts', async () => {
    await expect(state.transitions.commit(staleTransition)).rejects.toMatchObject({ category: 'checkpoint_conflict' });
    expect(await state.outbox.listPending({ runId: 'run-1', limit: 10 })).toEqual([]);
  });
});
```

Also test same-ID/same-payload enqueue returns the original pending record, same-ID/different-payload rejects with `EventIdConflictError`, and `markPublished()` is idempotent.

- [x] **Step 2: Run the focused contract test and verify RED**

Run: `pnpm vitest run test/durable-event-outbox-contract.test.ts`

Expected: `transitions` and `outbox` do not exist on the durable state fixture.

- [x] **Step 3: Define ports and implement memory storage first**

In `storage.ts`, define:

```ts
export type DurableExecutionTransition =
  | { kind: 'completed'; record: ToolExecutionRecord; result: ToolExecutionResult }
  | { kind: 'uncertain'; record: ToolExecutionRecord; reasonCode: string };

export interface DurableTransitionUnitOfWork {
  commit(input: {
    expectedRevision: number | null;
    context: AgentContext;
    execution?: DurableExecutionTransition;
    outboxEvents: readonly PendingAgentEventV2[];
  }): Promise<StoredRunCheckpoint>;
}

export interface DurableEventOutbox {
  enqueue(input: { events: readonly PendingAgentEventV2[]; createdAt: string }): Promise<readonly DurableOutboxRecord[]>;
  listPending(input: { runId?: string; limit: number }): Promise<readonly DurableOutboxRecord[]>;
  markPublished(input: { eventId: string; publishedAt: string }): Promise<void>;
}

export interface DurableOutboxRecord {
  event: PendingAgentEventV2;
  enqueuedAt: string;
  publishedAt?: string;
}

export interface DurableRunState {
  checkpoints: VersionedCheckpointStore;
  executions: ToolExecutionJournal;
  stateUnitOfWork: AgentStateUnitOfWork;
  transitions: DurableTransitionUnitOfWork;
  outbox: DurableEventOutbox;
}
```

Make `PendingAgentEventV2` explicitly retain `eventId` and omit only `sequence`; this matches existing runtime behavior and is required for pre-commit identity. Implement `InMemoryDurableState.transitions` and `.outbox` using cloned records. Validate all incoming events through `parseAgentEventV2({ ...event, sequence: 1 })` before changing maps. Preserve `commitToolResult()` and `markToolUncertain()` as thin adapters around `transitions.commit({ outboxEvents: [] })`.

- [x] **Step 4: Implement the SQLite migration and atomic transition**

Append a migration that creates:

```sql
CREATE TABLE durable_event_outbox (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'published')),
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX durable_event_outbox_pending_run
  ON durable_event_outbox(state, run_id, event_id);
```

`SqliteDurableStateStore.transitions.commit()` must parse all inputs, validate CAS, update checkpoint and optional execution state, and insert pending Outbox rows inside one `.transaction(...).immediate()` block. `SqliteEventOutboxStore` only reads bounded pending rows and marks a row published; it must parse stored event JSON and report corrupt rows as `StoredDataCorruptionError('event', eventId)`.

- [x] **Step 5: Run backend parity tests and verify GREEN**

Run: `pnpm vitest run test/durable-event-outbox-contract.test.ts test/durable-state-contract.test.ts test/sqlite-durable-state.test.ts`

Expected: both backends have identical CAS, retry, Outbox idempotence, and no-partial-commit behavior.

- [x] **Step 6: Commit durable persistence**

```bash
git add src/contracts/event-store.ts src/contracts/storage.ts src/storage/in-memory-durable-state.ts src/infrastructure/sqlite/migrations.ts src/infrastructure/sqlite/durable-state-store.ts src/infrastructure/sqlite/event-outbox-store.ts src/infrastructure/sqlite/persistence-bundle.ts src/infrastructure/sqlite/index.ts test/durable-event-outbox-contract.test.ts test/sqlite-durable-state.test.ts
git commit -m "feat: add durable event outbox transitions"
```

## Task 4: Dispatch pending Outbox events and compose the runtime

**Files:**

- Create: `src/event/v2/durable-outbox-dispatcher.ts`
- Create: `src/event/v2/outboxed-event-publisher.ts`
- Modify: `src/application/create-runtime.ts`
- Test: `test/durable-outbox-dispatcher.test.ts`
- Test: `test/runtime-durable-persistence.test.ts`

**Consumes:** `DurableEventOutbox`, raw `EventPublisherV2`, `Clock`, and stable `eventId` semantics.

**Produces:** bounded post-commit dispatch and a publisher wrapper that routes every ordinary durable V2 producer through the Outbox while leaving transient deltas unchanged.

- [x] **Step 1: Write dispatcher behavior tests**

```ts
it('persists exactly one durable event after a crash before dispatch and drains it on restart', async () => {
  await durable.transitions.commit({ expectedRevision: null, context, outboxEvents: [event] });
  const dispatcher = new DurableOutboxDispatcher({ outbox: durable.outbox, publisher, clock, batchSize: 10 });

  await dispatcher.drainRun('run-1');

  expect(await events.readRun('run-1', 0, 10)).toMatchObject([{ eventId: event.eventId }]);
  expect(await durable.outbox.listPending({ runId: 'run-1', limit: 10 })).toEqual([]);
});

it('does not enqueue transient deltas through the Outbox', async () => {
  await outboxedPublisher.publish(transientDelta);
  expect(await durable.outbox.listPending({ runId: 'run-1', limit: 10 })).toEqual([]);
});
```

Include a retry test where `markPublished()` fails once: a second drain reuses the same event ID and leaves only one EventStore row.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run test/durable-outbox-dispatcher.test.ts`

Expected: dispatcher and wrapper modules do not resolve.

- [x] **Step 3: Implement bounded dispatch and wrapper composition**

`DurableOutboxDispatcher.drainRun(runId)` repeatedly reads at most `batchSize` pending entries for that Run, calls the raw publisher, and calls `markPublished()` only after `publish()` resolves. `drainAll()` uses the same bounded read API and never loads all historical rows.

`OutboxedEventPublisher.publish(event)` must:

1. delegate transient events directly to the raw publisher;
2. call `outbox.enqueue({ events: [event], createdAt: clock.now().toISOString() })` for durable events;
3. drain that event's Run; and
4. return the event stored by the raw publisher.

In `create-runtime.ts`, retain the raw publisher for subscriptions, replay, and dispatcher internals. Inject the wrapper everywhere a component only needs `EventPublisherV2Like`: model adapters, tool execution, evidence recorder, Harness, HITL, and external result service. `ready` must drain pending Outbox events before normal projector replay.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run test/durable-outbox-dispatcher.test.ts test/runtime-durable-persistence.test.ts test/event-v2-publisher.test.ts`

Expected: durable producers enqueue-before-dispatch, transient events bypass the Outbox, and projector/event ordering tests remain green.

- [x] **Step 5: Commit Outbox dispatch wiring**

```bash
git add src/event/v2/durable-outbox-dispatcher.ts src/event/v2/outboxed-event-publisher.ts src/application/create-runtime.ts test/durable-outbox-dispatcher.test.ts test/runtime-durable-persistence.test.ts
git commit -m "feat: dispatch durable events through outbox"
```

## Task 5: Atomically bridge transition-coupled Harness, HITL, and external results

**Files:**

- Modify: `src/agent/agent-harness.ts`
- Modify: `src/tool/batch-executor.ts`
- Modify: `src/application/hitl-service.ts`
- Modify: `src/application/external-tool-result-service.ts`
- Test: `test/durable-transition-harness.test.ts`
- Test: `test/durable-harness-recovery.test.ts`
- Test: `test/hitl-durable-revision.test.ts`

**Consumes:** `DurableTransitionUnitOfWork`, `DurableOutboxDispatcher`, the Outboxed publisher, existing V1 projector, and current Run frame checkpoint revision.

**Produces:** no crash window between state mutation and the durable V2 facts that describe it.

- [x] **Step 1: Write failing end-to-end transition tests**

```ts
it('commits a ToolResult, its journal state, and its V2 fact before yielding the V1 result', async () => {
  const { events, result } = await collect(runtime.agent.replyStream({ runId: 'run-1', message: 'inspect', profileId: 'group-buy-market' }));

  expect(result.status).toBe('completed');
  expect(await runtime.durableState?.executions.get('call-1')).toMatchObject({ state: 'succeeded' });
  expect(await runtime.eventStoreV2.readRun('run-1', 0, 100)).toContainEqual(expect.objectContaining({ type: 'TOOL_RESULT' }));
  expect(events.findIndex((event) => event.type === 'TOOL_RESULT')).toBeGreaterThanOrEqual(0);
});

it('replays an Outbox event after restart without re-executing its action', async () => {
  const persistence = createSqlitePersistence({ path: sqlitePath, clock });
  const checkpoint = await persistence.checkpoints.save(contextWithPreparedNeverReplayAction(), null);
  await persistence.executions.prepare(preparedNeverReplayAction());
  const pending = eventFactory.create('RUN_PAUSED', eventContext('run-1'), {
    interruptId: 'recovery-interrupt', reason: 'external_execution_uncertain',
    expiresAt: '2026-09-10T00:05:00.000Z', checkpointVersion: String(checkpoint.revision),
  });
  await persistence.transitions.commit({
    expectedRevision: checkpoint.revision,
    context: checkpoint.context,
    outboxEvents: [pending],
  });
  persistence.close();

  const runtime = createRuntimeWithNeverReplayAction(sqlitePath, () => { actionCalls += 1; });
  await runtime.ready;
  await drain(runtime.agent.resumeStream('run-1'));

  expect(actionCalls).toBe(0);
  expect(await runtime.eventStoreV2.findById(pending.eventId)).toMatchObject({ type: 'RUN_PAUSED' });
});
```

Use local test helpers with these exact shapes so the action identity is deterministic:

```ts
const actionCall: ToolCall = { id: 'action-1', name: 'action.drain', input: { service: 'settlement' } };
const contextWithPreparedNeverReplayAction = (): AgentContext => ({
  ...baseContext('run-1'),
  status: 'paused',
  pendingToolCalls: [actionCall],
  pendingToolBatch: {
    batchId: 'batch-1', stepId: 'step-1', calls: [actionCall], completedResults: [],
    state: 'executing', createdAt: timestamp,
  },
});
const preparedNeverReplayAction = (): ToolExecutionRecord => ({
  toolCallId: 'action-1', runId: 'run-1', stepId: 'step-1', toolName: 'action.drain',
  toolKind: 'action', inputDigest: 'action-input-v1', state: 'prepared', preparedAt: timestamp,
});
const eventContext = (runId: string) => ({ runId, correlationId: `run:${runId}`, visibility: 'audit' as const, durability: 'durable' as const });
```

Add HITL and external-result tests that assert the saved checkpoint revision and the corresponding `CONFIRMATION_RESOLVED`/`TOOL_RESULT` or `EXTERNAL_EXECUTION_RESULT` fact appear together after the durable transition.

- [x] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run test/durable-transition-harness.test.ts test/durable-harness-recovery.test.ts test/hitl-durable-revision.test.ts`

Expected: tests demonstrate direct V2 publication or lack the durable transition bridge.

- [x] **Step 3: Add the transition-aware publishing helper**

In `AgentHarness`, build the V2 pending event once with the existing factory, then call `durableState.transitions.commit()` with the current expected revision, exact `AgentContext`, optional execution transition, and event array. On successful commit, update `frame.checkpointRevision`, call `DurableOutboxDispatcher.drainRun()`, and only then yield the matching V1 generator event.

`ToolBatchExecutor` must buffer the terminal V1 `TOOL_RESULT` yielded by the pipeline until its durable completion callback has returned; otherwise the pipeline can expose the result before the Harness commits the transition.

Apply this helper to the state-transition-coupled facts:

- `RUN_STARTED`, `RUN_RESUMED`, `RUN_PAUSED`, `RUN_FINISHED`, `RUN_FAILED`, and consumer-close `RUN_CANCELLED`;
- `TOOL_RESULT` and `EXTERNAL_EXECUTION_UNCERTAIN`;
- confirmation and external execution result paths handled by application services.

Keep standalone telemetry (`MODEL_*`, streamed deltas, progress, and reasoning notices) on the Outboxed publisher; they do not mutate the Run checkpoint in the same operation. Do not introduce a second Run loop, a global Run map, or infrastructure imports into the Harness.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run test/durable-transition-harness.test.ts test/durable-harness-recovery.test.ts test/hitl-durable-revision.test.ts test/v1-event-bus-projection.test.ts test/agent-harness-async-generator.test.ts`

Expected: a durable fact is never observed before its matching checkpoint/execution state, V1 generator and V1 EventBus remain compatible, and recovery does not repeat actions.

- [x] **Step 5: Commit the transition bridge**

```bash
git add src/agent/agent-harness.ts src/application/hitl-service.ts src/application/external-tool-result-service.ts test/durable-transition-harness.test.ts test/durable-harness-recovery.test.ts test/hitl-durable-revision.test.ts
git commit -m "feat: publish run transitions after durable commit"
```

## Task 6: Complete increment verification and synchronize documentation

**Files:**

- Modify: `docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md`
- Modify: `docs/superpowers/plans/2026-09-11-runtime-governance-increment-1.md`
- Test: all tests listed below

**Consumes:** completed Tasks 1-5 and their committed behavior.

**Produces:** a checked-off execution record and an accurate Spec status for increment 1.

- [x] **Step 1: Update the Spec's implementation status accurately**

Mark only the delivered increment-1 contracts, migration, Outbox, dispatcher, and transition bridge as implemented. Keep increments 2-6 explicitly pending. Do not claim loop detection behavior exists merely because the `LOOP_DETECTED` event contract exists.

- [x] **Step 2: Review plan coverage and mark completed checkboxes**

Verify each checkbox against a passing test or inspected source change. Keep any unchecked item visible rather than marking it complete based on intent.

- [x] **Step 3: Run all required quality gates**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: each command exits 0. Report the skipped real-Prometheus test as skipped, not passed.

- [x] **Step 4: Commit documentation and final verification**

```bash
git add docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md docs/superpowers/plans/2026-09-11-runtime-governance-increment-1.md
git commit -m "docs: record runtime governance increment one"
git status --short --branch
```

## Plan Self-Review

- Spec coverage: Spec §5, §8.3, §11, §15 increment 1, compatibility §5.6, and the transition/event ordering portions of §16 map to Tasks 1-5. Profile/Impact/Guardian, Hooks, loop behavior, L0/L1/L2, and Blob data-plane work are deliberately excluded because the Spec assigns them to later increments.
- Placeholder scan: no deferred implementation markers are used; every task names concrete paths, interfaces, tests, and commands.
- Type consistency: `RunGovernanceState` is produced by Task 1; `DurableTransitionUnitOfWork` and `DurableEventOutbox` by Task 3; Task 4 consumes those interfaces; Task 5 consumes the dispatcher and transition port rather than concrete SQLite classes.

## Increment 1 completion record

- Task 1: `06b564f` — governance contracts and compatibility migration.
- Task 2: `cb3e3c1` — `LOOP_DETECTED` V2 contract.
- Task 3: `3da864c` — durable transition and Outbox storage.
- Task 4: `ecce628`, `894c595` — dispatcher, wrapper, runtime composition and review hardening.
- Task 5: `e2a5f9d`, `250f8c6` — transition-aware Harness, HITL, external-result publishing, and post-commit V1 result ordering.
- Verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` passed; the real Prometheus test remains skipped because no real endpoint is configured.
