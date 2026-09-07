# Event and Message V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete phase-one Event/Message V2 protocol, durable storage and replay, projections, and runtime instrumentation while preserving V1 compatibility.

**Architecture:** Runtime producers publish only typed V2 events through `EventPublisherV2`. Durable facts are conditionally appended to `EventStore`, transient deltas enter a bounded replay buffer, and isolated projectors produce Public SSE, local audit, LangSmith, and V1 compatibility views. Message V2 is assembled from content events and persisted independently so reconnect and resume never depend on retaining an old generator stack.

**Tech Stack:** TypeScript 5.9 strict mode, Node.js 20, pnpm 11.19, Zod 3, Vitest 3, better-sqlite3, LangSmith SDK.

**Spec:** `docs/architecture/15-event-message-v2.md`

## Global Constraints

- Existing V1 event/message fields and semantics must not be deleted, renamed, or changed.
- `contracts/` must not depend on runtime, storage, SDK, filesystem, or infrastructure modules.
- The Agent Harness must not directly depend on SQLite, LangSmith, HTTP frameworks, MCP SDK, or concrete model SDKs.
- Pause ends the current AsyncGenerator; resume creates a new streamId while preserving runId and replyId.
- Public output must exclude raw tool arguments, system prompts, secrets, internal addresses, customer data, and raw chain-of-thought.
- Durable event sequence allocation uses expected-sequence conditional append; consumers are idempotent by eventId.
- Every tool call receives a terminal ToolResult, including rejection, timeout, cancellation, skip, and interruption.
- Tests use deterministic injected clocks and ID generators.
- Complete each task with its focused tests and a local commit; run all four quality commands before final completion.

## Planned File Structure

```text
src/contracts/event-v2/
  common.ts                 # IDs, envelope, visibility and durability
  lifecycle.ts              # run, step, stage, model and stream payloads
  execution.ts              # admission, tool, HITL, evidence and action payloads
  subsystem.ts              # subagent, MCP, resilience, context and memory payloads
  catalog.ts                # AgentEventPayloadMap and AgentEventTypeV2
  schema.ts                 # runtime Zod discriminated validation
  index.ts                  # public exports
src/contracts/message-v2/
  common.ts                 # message identity, role, status and metadata JSON
  blocks.ts                 # independent MessageBlock interfaces
  schema.ts                 # runtime message/block schemas
  index.ts                  # AgentMessageV2 and public exports
src/contracts/event-store.ts # EventStore, MessageStore and append contracts
src/event/v2/
  event-factory.ts          # metadata injection before sequence assignment
  event-publisher.ts        # validation, persistence and isolated dispatch
  in-memory-event-store.ts  # deterministic reference implementation
  replay-buffer.ts          # bounded transient event replay
  message-assembler.ts      # Start/Delta/Completed to MessageV2
  projection-runner.ts      # idempotent projector checkpointing
src/event/projectors/
  public-projector.ts       # safe frontend event view
  v1-projector.ts           # V2 to legacy AgentEvent
  audit-projector.ts        # structured local audit records
  langsmith-projector.ts    # Event V2 to trace/span lifecycle
src/infrastructure/sqlite/
  database.ts               # WAL connection and transactions
  migrations.ts             # schema migration registry
  event-message-store.ts    # SQLite EventStore and MessageStore
src/api/event-stream-service.ts # Last-Event-ID replay and SSE frame encoding
test/event-v2-*.test.ts      # contract, ordering, replay and projection tests
test/message-v2-*.test.ts    # block, assembly and persistence tests
test/runtime-events-v2.test.ts # Harness/tool/HITL/subsystem integration
```

---

### Task 1: Message V2 Contracts and Runtime Schemas

**Files:**
- Create: `src/contracts/message-v2/common.ts`
- Create: `src/contracts/message-v2/blocks.ts`
- Create: `src/contracts/message-v2/schema.ts`
- Create: `src/contracts/message-v2/index.ts`
- Modify: `src/contracts/index.ts`
- Test: `test/message-v2-contract.test.ts`

**Interfaces:**
- Consumes: existing `ToolCall`, `RawToolCall`, `ToolExecutionResult`, `ContextSummary`, and `AgentError`.
- Produces: `JsonValue`, `MessageVisibilityV2`, `MessageStatusV2`, `MessageBlockV2`, `AgentMessageV2`, `agentMessageV2Schema`, and `parseAgentMessageV2(input: unknown): AgentMessageV2`.

- [ ] **Step 1: Write failing contract tests**

```ts
it('round-trips a completed V2 message with evidence and diagnosis blocks', () => {
  const parsed = parseAgentMessageV2(validMessage);
  expect(parsed.schemaVersion).toBe(2);
  expect(parsed.blocks.map((block) => block.type)).toEqual(['text', 'evidence_ref', 'diagnosis']);
});

it.each(['raw_tool_call', 'reasoning_summary', 'confirmation_request', 'action_result'])('%s has a stable blockId', (type) => {
  expect(() => parseAgentMessageV2(messageWithBlock(type, undefined))).toThrow();
});
```

- [ ] **Step 2: Run `pnpm test -- test/message-v2-contract.test.ts` and verify failure because V2 exports do not exist**
- [ ] **Step 3: Implement independent discriminated block interfaces for all fifteen block types in spec section 6.1, with `blockId` on every block and JSON-only metadata**
- [ ] **Step 4: Implement strict Zod schemas and `parseAgentMessageV2`; reject unknown block types, missing identifiers, invalid dates, functions, Error instances, and non-JSON metadata**
- [ ] **Step 5: Run the focused test and `pnpm typecheck`; expect both to pass**
- [ ] **Step 6: Commit with `git commit -m "feat: add message v2 contracts"`**

### Task 2: Event V2 Catalog, PayloadMap, and Runtime Validation

**Files:**
- Create: `src/contracts/event-v2/common.ts`
- Create: `src/contracts/event-v2/lifecycle.ts`
- Create: `src/contracts/event-v2/execution.ts`
- Create: `src/contracts/event-v2/subsystem.ts`
- Create: `src/contracts/event-v2/catalog.ts`
- Create: `src/contracts/event-v2/schema.ts`
- Create: `src/contracts/event-v2/index.ts`
- Modify: `src/contracts/index.ts`
- Test: `test/event-v2-contract.test.ts`

**Interfaces:**
- Consumes: Message V2 IDs/JSON types and existing tool, error, risk, evidence, and interrupt contracts.
- Produces: `AgentEventPayloadMap`, `AgentEventTypeV2 = keyof AgentEventPayloadMap`, `AgentEventEnvelopeV2<T>`, `UnsequencedAgentEventV2<T>`, `agentEventV2Schema`, `parseAgentEventV2`, and `isAgentEventV2`.

- [ ] **Step 1: Write compile-time and runtime tests for payload/type pairing**

```ts
const completed: AgentEventEnvelopeV2<'MODEL_CALL_COMPLETED'> = event('MODEL_CALL_COMPLETED', {
  provider: 'openai-compatible', model: 'test', attempt: 1, durationMs: 10,
});
expect(parseAgentEventV2(completed).type).toBe('MODEL_CALL_COMPLETED');
expect(() => parseAgentEventV2({ ...completed, payload: { decision: 'approved' } })).toThrow();
```

- [ ] **Step 2: Run the focused test and confirm it fails for missing V2 contracts**
- [ ] **Step 3: Define all event payload interfaces from spec sections 5.1 through 5.8; use stable unions for stage, budgetType, decision, gate and outcome rather than arbitrary strings**
- [ ] **Step 4: Build `AgentEventPayloadMap` with every approved event name as an explicit key and derive the event union from the map**
- [ ] **Step 5: Add envelope invariants: schemaVersion=2, nonempty IDs, nonnegative integer sequence, ISO timestamp, and required runId/correlationId**
- [ ] **Step 6: Add a table-driven test that every catalog key has a runtime schema and every runtime schema key exists in PayloadMap**
- [ ] **Step 7: Run focused tests and typecheck; commit with `git commit -m "feat: define typed event v2 catalog"`**

### Task 3: Event Store Contracts, Factory, and In-Memory Conditional Append

**Files:**
- Create: `src/contracts/event-store.ts`
- Create: `src/event/v2/event-factory.ts`
- Create: `src/event/v2/in-memory-event-store.ts`
- Modify: `src/contracts/index.ts`
- Modify: `src/index.ts`
- Test: `test/event-v2-store.test.ts`

**Interfaces:**
- Produces: `EventStore.append(runId, expectedSequence, events)`, `EventStore.readRun(runId, afterSequence, limit)`, `EventStore.findById(eventId)`, `MessageStore.save/get/listByRun`, `EventFactoryV2.create(type, context, payload)`, and `SequenceConflictError`.

- [ ] **Step 1: Write tests proving sequence assignment, duplicate eventId idempotency, and stale expectedSequence rejection**
- [ ] **Step 2: Run the focused test and verify failure**
- [ ] **Step 3: Implement `EventFactoryV2` so callers provide semantic context but never provide sequence; inject Clock and IdGenerator**
- [ ] **Step 4: Implement per-run serialized in-memory append; return the existing event for exact duplicate eventId and throw `SequenceConflictError` for divergent stale writes**
- [ ] **Step 5: Implement immutable clones on write/read and MessageStore optimistic version checks**
- [ ] **Step 6: Run focused tests and typecheck; commit with `git commit -m "feat: add event store and v2 factory"`**

### Task 4: Replay Buffer, Message Assembly, and Stream Invariants

**Files:**
- Create: `src/event/v2/replay-buffer.ts`
- Create: `src/event/v2/message-assembler.ts`
- Test: `test/message-v2-assembly.test.ts`
- Test: `test/event-v2-replay-buffer.test.ts`

**Interfaces:**
- Produces: `ReplayBuffer.push/readAfter`, `MessageAssembler.apply(event)`, and `MessageAssemblyError`.

- [ ] **Step 1: Write tests for Start/Delta/Completed assembly, duplicate Delta idempotency, invalid block order, bounded eviction, and completed snapshot persistence**
- [ ] **Step 2: Run both tests and verify failure**
- [ ] **Step 3: Implement a byte-counted and event-counted ReplayBuffer with injected limits; never evict durable facts from EventStore**
- [ ] **Step 4: Implement MessageAssembler as a per-message deterministic state machine; only text and reasoning-summary blocks accept textual Delta**
- [ ] **Step 5: Persist `status=completed` atomically with the final block state; interrupted/failed messages retain all completed blocks**
- [ ] **Step 6: Run focused tests and commit with `git commit -m "feat: assemble and replay message streams"`**

### Task 5: Event Publisher and Subscriber Failure Isolation

**Files:**
- Create: `src/event/v2/event-publisher.ts`
- Create: `src/event/v2/projection-runner.ts`
- Modify: `src/event/event-bus.ts`
- Test: `test/event-v2-publisher.test.ts`

**Interfaces:**
- Produces: `EventPublisherV2.publish(event): Promise<AgentEventEnvelopeV2>`, `EventProjector.project(event)`, `ProjectionCheckpointStore`, and `ProjectionFailureSink`.

- [ ] **Step 1: Write tests that durable publication stores before dispatch, transient publication uses ReplayBuffer, one failing subscriber does not prevent another, and projector retries do not republish business events**
- [ ] **Step 2: Run test and verify failure**
- [ ] **Step 3: Implement publisher validation, expected-sequence retry limited to a fresh store read, and isolated `Promise.allSettled` dispatch**
- [ ] **Step 4: Implement projection checkpoints by projector name/runId/sequence and a bounded dead-letter record containing eventId, projector, error code and attempts**
- [ ] **Step 5: Keep legacy EventBus available for V1 consumers; do not make it the V2 source of truth**
- [ ] **Step 6: Run focused tests and commit with `git commit -m "feat: publish and project v2 events"`**

### Task 6: V1 and Public Projections

**Files:**
- Create: `src/event/projectors/v1-projector.ts`
- Create: `src/event/projectors/public-projector.ts`
- Test: `test/event-v2-projections.test.ts`

**Interfaces:**
- Produces: `V1CompatibilityProjector.project(event): AgentEvent[]` and `PublicEventProjector.project(event): PublicAgentEvent | null`.

- [ ] **Step 1: Write table tests for every V1 event mapping and security tests for raw tool calls, system prompts, internal URLs, authorization headers and nested secret keys**
- [ ] **Step 2: Verify focused tests fail**
- [ ] **Step 3: Implement V1 mappings: text block Delta to TEXT_DELTA; confirmation request to REQUIRE_CONFIRM; external request to EXTERNAL_TOOL_REQUESTED; compression, evidence, tool and Run lifecycle to their existing names**
- [ ] **Step 4: Implement recursive allowlist-based public projection; dropping a forbidden field is preferred to masking an unknown structure**
- [ ] **Step 5: Return null for audit/internal-only events and preserve eventId/sequence in public metadata for reconnect**
- [ ] **Step 6: Run focused tests and commit with `git commit -m "feat: add public and v1 event projections"`**

### Task 7: SQLite Event and Message Persistence

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/infrastructure/sqlite/database.ts`
- Create: `src/infrastructure/sqlite/migrations.ts`
- Create: `src/infrastructure/sqlite/event-message-store.ts`
- Create: `src/infrastructure/sqlite/index.ts`
- Modify: `src/index.ts`
- Test: `test/sqlite-event-message-store.test.ts`

**Interfaces:**
- Consumes: EventStore and MessageStore contracts from Task 3.
- Produces: `SqliteDatabase.open(path)`, `SqliteEventMessageStore`, schema migration version 1, WAL mode and transaction-backed append.

- [ ] **Step 1: Add `better-sqlite3` and its types with pnpm; do not use Node 22-only `node:sqlite` because the runtime floor is Node 20**
- [ ] **Step 2: Write temporary-database tests for WAL, migration idempotency, restart persistence, conditional sequence conflict, duplicate eventId, message optimistic version, and transaction rollback**
- [ ] **Step 3: Run focused test and verify failure**
- [ ] **Step 4: Create tables `agent_events`, `agent_messages`, `projection_checkpoints`, and `projection_failures`; store validated JSON plus indexed runId/sequence/type/timestamp**
- [ ] **Step 5: Implement append inside `BEGIN IMMEDIATE`; compare current max sequence with expectedSequence and enforce unique eventId and `(run_id, sequence)`**
- [ ] **Step 6: Reparse database JSON through V1/V2 runtime schemas on read; corrupt records fail with a stable storage error**
- [ ] **Step 7: Run focused tests and commit with `git commit -m "feat: persist event and message streams in sqlite"`**

### Task 8: SSE Replay Service

**Files:**
- Create: `src/api/event-stream-service.ts`
- Create: `src/api/sse-encoder.ts`
- Modify: `src/index.ts`
- Test: `test/event-stream-service.test.ts`

**Interfaces:**
- Produces: `EventStreamService.open({runId,lastEventId,signal})`, `SseFrame`, and `encodeSseFrame(frame): string` without binding to a web framework.

- [ ] **Step 1: Write tests for initial stream, Last-Event-ID replay, live handoff without a gap, abort cleanup, unknown event ID, and expired transient Delta recovery via MessageStore snapshot**
- [ ] **Step 2: Run focused test and verify failure**
- [ ] **Step 3: Implement replay cursor resolution using eventId then sequence; subscribe before final catch-up read and deduplicate by sequence to avoid replay/live race**
- [ ] **Step 4: Encode SSE `id`, `event`, and JSON `data` with newline-safe formatting; never expose canonical audit/internal payload directly**
- [ ] **Step 5: On expired Delta history emit a public message snapshot event followed by durable events after its sequence**
- [ ] **Step 6: Run focused tests and commit with `git commit -m "feat: stream and replay public agent events"`**

### Task 9: Audit and LangSmith Projections

**Files:**
- Create: `src/event/projectors/audit-projector.ts`
- Create: `src/event/projectors/langsmith-projector.ts`
- Modify: `src/contracts/observability.ts`
- Modify: `src/observability/langsmith-observability.ts`
- Test: `test/event-v2-audit-langsmith.test.ts`

**Interfaces:**
- Produces: `AuditProjector`, `LangSmithEventProjector`, explicit span identity/parent identity, and `Observability.startSpan` support for correlation/attempt/tool/subagent metadata.

- [ ] **Step 1: Write tests for run→model/tool→subagent parentage, parallel sibling spans, usage/TTFT/cache attributes, redacted inputs, retry attempts, projector idempotency, client failure isolation, and bounded flush timeout**
- [ ] **Step 2: Run focused test and verify failure**
- [ ] **Step 3: Implement audit records as references and sanitized summaries, not duplicated raw evidence or full prompts**
- [ ] **Step 4: Replace the current mutable per-run root lookup assumption with explicit span keys derived from correlationId/causationId/attemptId**
- [ ] **Step 5: Map MODEL_CALL_COMPLETED usage, TOOL_RESULT evidence IDs, Subagent parentRunId and fallback/retry events into LangSmith metadata**
- [ ] **Step 6: Make remote sends queued, bounded, retryable and non-blocking to diagnosis completion**
- [ ] **Step 7: Run focused tests and commit with `git commit -m "feat: project v2 events to audit and langsmith"`**

### Task 10: Model and Content Stream Instrumentation

**Files:**
- Modify: `src/contracts/model.ts`
- Modify: `src/model/model-attempt-observer.ts`
- Modify: `src/observability/model-attempt-observer.ts`
- Create: `src/model/evented-model.ts`
- Modify: `src/agent/agent-harness.ts`
- Test: `test/model-events-v2.test.ts`

**Interfaces:**
- Produces: `EventedChatModel` decorator and model stream events sufficient to assemble text/tool call blocks without exposing incomplete public arguments.

- [ ] **Step 1: Write tests for started/completed/failed/retry/fallback events, usage and timings, text Start/Delta/Completed, and a provider stream failure after partial text**
- [ ] **Step 2: Run focused test and verify failure**
- [ ] **Step 3: Implement EventedChatModel around any ChatModel; assign one attemptId per provider attempt and publish sanitized model lifecycle events**
- [ ] **Step 4: Convert text output into Message/ContentBlock events while retaining the existing final ModelResponse contract during migration**
- [ ] **Step 5: Keep unfinished raw tool arguments audit/internal; publish TOOL_CALL_CREATED only after ToolAdmission accepts the completed candidate**
- [ ] **Step 6: Remove duplicate Harness model span/event emission only after decorator integration tests pass**
- [ ] **Step 7: Run focused tests and commit with `git commit -m "feat: emit model and message v2 streams"`**

### Task 11: Tool Admission, Execution, Retry, and Risk Events

**Files:**
- Modify: `src/tool/admission.ts`
- Modify: `src/agent/admit-tool-batch.ts`
- Modify: `src/tool/execution-pipeline.ts`
- Modify: `src/tool/tool-runner.ts`
- Modify: `src/mcp/resilience.ts`
- Test: `test/tool-events-v2.test.ts`

**Interfaces:**
- Produces: typed admission trace records from each gate and V2 emissions for repair, rejection, risk, execution, output Delta, retry, terminal result, datasource retry and circuit transitions.

- [ ] **Step 1: Write tests for all four gates, safe JSON repair, failed local repair→LLM retry, empty-object Schema rejection, retry exhaustion, Guard finding, streamed output, cancellation, MCP retry and circuit open/half-open/close**
- [ ] **Step 2: Run focused test and verify failure**
- [ ] **Step 3: Change ToolAdmission result to include ordered `AdmissionGateRecord[]` without changing normalized ToolCall.input or existing ToolExecutionResult**
- [ ] **Step 4: Publish TOOL_CALL_CREATED after admission success; rejected calls publish TOOL_CALL_REJECTED and one terminal TOOL_RESULT**
- [ ] **Step 5: Map ToolResponseChunk text to TOOL_OUTPUT_DELTA and progress to TOOL_PROGRESS; final response only enters TOOL_RESULT**
- [ ] **Step 6: Publish RISK_EVALUATED before Hook/HITL; never turn an event into permission to execute**
- [ ] **Step 7: Instrument existing bounded MCP retry/circuit code with datasource events and preserve its retry budget semantics**
- [ ] **Step 8: Run focused tests and commit with `git commit -m "feat: emit tool admission and resilience events"`**

### Task 12: HITL, External Execution, and Resume Semantics

**Files:**
- Modify: `src/contracts/hitl.ts`
- Modify: `src/application/hitl-service.ts`
- Modify: `src/application/external-tool-result-service.ts`
- Modify: `src/agent/agent-harness.ts`
- Modify: `src/contracts/context.ts`
- Test: `test/hitl-events-v2.test.ts`

**Interfaces:**
- Produces: stable confirmationId/requestId, conditional checkpoint transitions, CONFIRMATION and EXTERNAL_EXECUTION lifecycle events, RUN_RESUMED, and streamId preservation rules.

- [ ] **Step 1: Write tests for request→pause, approved→new stream resume, rejected terminal ToolResult, expiry, duplicate decision idempotency, stale contextVersion conflict, external success, external uncertain result, and process-restart load**
- [ ] **Step 2: Run focused test and verify failure**
- [ ] **Step 3: Persist confirmation/request IDs, expected contextVersion, decision actor/time and expiry; use compare-and-swap store operations rather than load-mutate-save**
- [ ] **Step 4: Append CONFIRMATION_RESOLVED before acquiring resume lease; emit RUN_RESUMED only in the new generator with unchanged runId/replyId and new streamId**
- [ ] **Step 5: If still awaiting confirmation, `resumeStream` returns paused without entering model reasoning; expired requests transition deterministically and cannot remain stuck**
- [ ] **Step 6: Treat external-success/local-commit-failure as EXTERNAL_EXECUTION_UNCERTAIN and require verification instead of replay**
- [ ] **Step 7: Run focused tests and commit with `git commit -m "feat: make hitl resume event-complete"`**

### Task 13: Harness, Subagent, MCP, Context, and Memory Lifecycle Integration

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/agent-harness.ts`
- Modify: `src/tool/adapters/subagent-tool-adapter.ts`
- Modify: `src/tool/adapters/mcp-tool-adapter.ts`
- Modify: `src/context-compressor/rule-based-compressor.ts`
- Modify: `src/memory/in-memory-memory.ts`
- Create: `src/event/v2/subsystem-instrumentation.ts`
- Test: `test/runtime-events-v2.test.ts`

**Interfaces:**
- Produces: V2 `replyStream`/`resumeStream` output, child run linkage, stage/budget/diagnosis/evidence/context/memory events, and legacy adapter entry points.

- [ ] **Step 1: Write integration tests for a normal no-tool reply, parallel Subagents with one failure, partial evidence, compression success/failure, memory retrieval/update, iteration exhaustion, timeout, cancellation, and final diagnosis**
- [ ] **Step 2: Run focused test and verify failure**
- [ ] **Step 3: Add sessionId/replyId/streamId to ReplyOptions/result/checkpoint using optional V1-compatible fields and deterministic defaults**
- [ ] **Step 4: Migrate Harness state-transition emissions to EventPublisherV2 and enforce stage, step-completion, budget and terminal Run ordering**
- [ ] **Step 5: Wrap Subagent runs with childRunId/parentRunId and shared correlation/deadline/budget; do not create a second event implementation inside Subagent**
- [ ] **Step 6: Add lifecycle decorators for MCP connection, compression and MemoryFacade operations; wrappers emit events only when the underlying operation actually runs**
- [ ] **Step 7: Feed the legacy EventBus exclusively from V1CompatibilityProjector and keep existing V1 tests passing**
- [ ] **Step 8: Run focused tests plus all existing tests; commit with `git commit -m "feat: adopt event message v2 across runtime"`**

### Task 14: Bootstrap, Migration Fixtures, Documentation, and Full Acceptance

**Files:**
- Modify: `src/application/create-runtime.ts`
- Modify: `src/bootstrap/inspection-runtime.ts`
- Modify: `src/bootstrap/index.ts`
- Modify: `src/index.ts`
- Create: `test/fixtures/event-v1.json`
- Create: `test/fixtures/message-v1.json`
- Create: `test/event-message-v2-acceptance.test.ts`
- Modify: `docs/implementation-status.md`
- Modify: `docs/architecture/15-event-message-v2.md`

**Interfaces:**
- Produces: a bootstrap-selected in-memory or SQLite V2 runtime, projector composition, legacy compatibility, and end-to-end acceptance evidence.

- [ ] **Step 1: Write acceptance tests covering V1 fixture read, V2→V1 projection, persisted restart/replay, pause/new-stream resume, parallel tool ordering, public redaction, LangSmith failure isolation, and complete ToolCall/ToolResult pairing**
- [ ] **Step 2: Run acceptance test and verify missing bootstrap integration fails**
- [ ] **Step 3: Compose stores, publisher, replay buffer, message assembler and projectors only in bootstrap; default tests use in-memory implementations and production configuration selects SQLite**
- [ ] **Step 4: Export V1 and V2 contracts without ambiguous name collisions; document deprecation and migration examples**
- [ ] **Step 5: Run `pnpm lint` and fix all errors without disabling rules**
- [ ] **Step 6: Run `pnpm typecheck` and verify strict type safety**
- [ ] **Step 7: Run `pnpm test` and record exact test/file totals**
- [ ] **Step 8: Run `pnpm build` and verify generated declarations include V1/V2 exports**
- [ ] **Step 9: Update implementation status with only verified capabilities, commands and remaining gaps**
- [ ] **Step 10: Commit with `git commit -m "feat: complete event message v2 foundation"`**

## Final Review Checklist

- Every event in spec sections 5.1-5.8 exists in PayloadMap and runtime Schema.
- Every MessageBlock in spec section 6.1 has its own interface and Schema.
- V1 contracts remain source-compatible and are produced only by compatibility projection.
- Durable events and completed Message snapshots survive SQLite restart.
- Public SSE resumes by event ID and never leaks audit/internal content.
- Pause/resume, tool retries, child runs and LangSmith spans retain correct identity relationships.
- No subsystem emits an event for work that did not happen.
- Four quality commands pass on the final tree.
