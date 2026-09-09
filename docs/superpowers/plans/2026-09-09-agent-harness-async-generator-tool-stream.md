# Agent Harness AsyncGenerator Tool Streaming Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Remove the Harness-owned AsyncEventQueue and make replyStream() directly yield the complete V1 lifecycle, reasoning, and tool event stream while preserving V2 durability, projection compatibility, HITL, recovery, and deterministic batch results.

**Architecture:** The Harness owns one AsyncGenerator control loop. ToolRunner.stream() exposes response chunks, ToolExecutionPipeline.executeStream() converts those chunks and tool lifecycle transitions into V1 events, and ToolBatchExecutor.executeStream() merges safe tool streams while keeping unsafe tools serial. V2 publishing remains an awaited authoritative side channel; direct V1 events use the same safe payload mapping as the V2-to-V1 projector and are not also written to EventBus when V2 is enabled.

**Tech Stack:** TypeScript, Node.js 20, pnpm, Vitest, Zod, existing Event V2 Publisher/Store, existing ToolResponseChunk contract.

**Spec:** docs/superpowers/specs/2026-09-09-agent-harness-async-generator-design.md

## Global Constraints

- The project uses TypeScript, Node.js 20, and pnpm.
- V2 events remain the authoritative fact source; every publishV2() call is awaited and ordered per run.
- replyStream() and resumeStream() remain AsyncGenerator<AgentEvent, DiagnosisRunResult>; reply() continues to drain the generator.
- AgentHarness must not use AsyncEventQueue or an EventBus subscription to bridge events into its Generator.
- The V1 Generator and the V2-to-V1 projector must agree on type, runId, stepId, and safe payload; timestamps are generated independently and are checked separately.
- Tool inputs, raw model arguments, credentials, internal addresses, and private reasoning must not be exposed through the public V1 Generator.
- Safe read-only tools remain concurrent; unsafe/action tools remain serial; final results remain in input ToolCall order.
- Every run terminal path, pause path, abort path, and consumer-close path saves the complete AgentContext and flushes observability.
- Checkpoint state contains only serializable data; no function closure or resume handler is persisted.
- HTTP consume() continues draining the Generator and discarding its V1 events; V2 SSE continues reading the V2 event store/replay buffer.
- Before completion, run pnpm lint, pnpm typecheck, pnpm test, and pnpm build.

## File Map

Create:

- src/event/v1-payloads.ts — pure safe payload builders shared by the V1 projector and direct tool-event producers.
- src/tool/async-generator-multiplexer.ts — Promise.race-based merge for independent AsyncGenerators, including child-generator cleanup.
- test/tool-execution-stream.test.ts — direct ToolExecutionPipeline stream coverage.
- test/tool-batch-stream.test.ts — concurrent stream merge, serial unsafe execution, and ordered final results.
- test/agent-harness-async-generator.test.ts — direct Generator delivery, V1/V2 projection parity, checkpoints, and consumer close.

Modify:

- src/contracts/event-v2/lifecycle.ts — add optional RUN_FINISHED.finalText as an additive V2 field.
- src/event/projectors/v1-projector.ts — consume shared safe builders and map V2 RUN_FINISHED.finalText.
- src/tool/tool-runner.ts — add ToolRunner.stream() and retain execute() as a draining compatibility wrapper.
- src/tool/execution-pipeline.ts — add executeStream() and convert runner chunks/lifecycle events to Generator events; retain execute() as a draining wrapper.
- src/tool/batch-executor.ts — add executeStream() with safe-stream multiplexing; retain execute() as a draining wrapper.
- src/agent/agent-harness.ts — replace streamContext()/queue production with run() and mainLoop() AsyncGenerators; make reason() and pending-tool recovery generators; centralize terminal Checkpoint/observability cleanup.
- test/tool-runner.test.ts, test/event-v2-lifecycle.test.ts, test/event-v2-projections.test.ts, test/event-message-v2-acceptance.test.ts, and relevant harness tests — lock additive contract and compatibility behavior.
- docs/superpowers/specs/2026-09-09-agent-harness-async-generator-design.md — already records the approved tool-stream and early-close decisions; keep it synchronized with implementation.

### Task 1: Lock V1/V2 payload parity and the additive finish-text contract

**Files:**

- Modify: src/contracts/event-v2/lifecycle.ts
- Create: src/event/v1-payloads.ts
- Modify: src/event/projectors/v1-projector.ts
- Test: test/event-v2-lifecycle.test.ts
- Test: test/event-v2-projections.test.ts

**Interfaces:**

- Produces legacyToolCallCreatedPayload(call: ToolCall): { id: string; name: string }.
- Produces legacyToolStartedPayload(input: { toolCallId: string; toolName: string; source: string; attempt: number; deadline?: string }): Record<string, unknown>.
- Produces legacyProgressPayload(input: { toolCallId: string; progress: number; displaySummary: string }): Record<string, unknown>.
- Produces legacyTextDeltaPayload(input: { toolCallId: string; delta: string }): Record<string, unknown>.
- Produces legacyRunFinishedPayload(input: { outcome: 'complete' | 'partial' | 'inconclusive'; finalText?: string; reportId?: string; usage?: Record<string, unknown>; durationMs: number }): Record<string, unknown>.

- [ ] Step 1: Write failing contract tests

Add these assertions before changing production code:

~~~typescript
it('accepts an optional finalText on RUN_FINISHED without requiring it on old events', () => {
  expect(lifecycleEventPayloadSchemas.RUN_FINISHED.safeParse({
    outcome: 'complete', durationMs: 3,
  }).success).toBe(true);
  expect(lifecycleEventPayloadSchemas.RUN_FINISHED.safeParse({
    outcome: 'complete', finalText: '完成', durationMs: 3,
  }).success).toBe(true);
});

it('projects a tool-created event to the safe direct-generator payload', () => {
  const projected = new V1CompatibilityProjector().project(event('TOOL_CALL_CREATED', {
    call: { id: 'call-1', name: 'bash', input: { command: 'cat secret' } },
  }));
  expect(projected[0]?.payload).toEqual({ id: 'call-1', name: 'bash' });
});
~~~

- [ ] Step 2: Run the focused tests and verify the expected red failure

Run: pnpm test -- test/event-v2-lifecycle.test.ts test/event-v2-projections.test.ts

Expected: the new finalText case is rejected or the tool-created projection still contains the input, proving the tests exercise the missing contract change.

- [ ] Step 3: Implement the smallest compatible mapping

Add finalText?: string to RunFinishedPayloadV2 and its strict schema. Make V1CompatibilityProjector return { id, name } for TOOL_CALL_CREATED, and use the pure builders for tool-start/progress/text and finish payloads. Do not change V2 event names, required fields, or V2 stored tool-call payloads.

- [ ] Step 4: Run the focused tests and verify green

Run: pnpm test -- test/event-v2-lifecycle.test.ts test/event-v2-projections.test.ts

Expected: PASS with zero failures.

- [ ] Step 5: Commit the contract boundary

~~~text
git add src/contracts/event-v2/lifecycle.ts src/event/v1-payloads.ts src/event/projectors/v1-projector.ts test/event-v2-lifecycle.test.ts test/event-v2-projections.test.ts
git commit -m "refactor: define shared V1 event payload mapping"
~~~

### Task 2: Expose tool response chunks as an AsyncGenerator

**Files:**

- Modify: src/tool/tool-runner.ts
- Test: test/tool-runner.test.ts

**Interfaces:**

- ToolRunner.stream(tool, input, options): AsyncGenerator<ToolResponseChunk, ToolResponse>.
- ToolRunner.execute(tool, input, options, callbacks): Promise<ToolResponse> remains available and drains stream() so existing callers and callback tests continue to work.

- [ ] Step 1: Write the failing stream test

~~~typescript
it('exposes each ToolResponseChunk through stream and returns the final response', async () => {
  const tool: Tool = {
    name: 'streaming', description: 'test', kind: 'evidence', inputSchema: z.object({}),
    call: async function* () {
      yield { type: 'progress' as const, message: 'half', percent: 50 };
      yield { type: 'text_delta' as const, delta: 'partial' };
      return { blocks: [{ type: 'text' as const, text: 'done' }] };
    },
  };
  const stream = new DefaultToolRunner().stream(tool, {}, {
    runId: 'run-1', stepId: 'step-1', signal: new AbortController().signal, mode: 'execute',
  });
  const chunks: string[] = [];
  while (true) {
    const item = await stream.next();
    if (item.done) {
      expect(item.value.blocks).toEqual([{ type: 'text', text: 'done' }]);
      break;
    }
    chunks.push(item.value.type);
  }
  expect(chunks).toEqual(['progress', 'text_delta']);
});
~~~

- [ ] Step 2: Run the focused test and verify red

Run: pnpm test -- test/tool-runner.test.ts

Expected: TypeScript/test failure because ToolRunner.stream() is not yet implemented.

- [ ] Step 3: Implement stream() and keep the old wrapper

Implement DefaultToolRunner.stream() by yielding items from an async-generator tool return and returning the final ToolResponse; for non-generator returns, await and return without chunks. Implement execute() by repeatedly calling stream.next() and invoking callbacks.onChunk for each yielded chunk.

- [ ] Step 4: Run the focused tests and verify green

Run: pnpm test -- test/tool-runner.test.ts

Expected: PASS for both the new stream test and the existing callback compatibility test.

- [ ] Step 5: Commit the runner change

~~~text
git add src/tool/tool-runner.ts test/tool-runner.test.ts
git commit -m "feat: expose streaming tool runner"
~~~

### Task 3: Stream one tool execution through the existing guard and hook pipeline

**Files:**

- Modify: src/tool/execution-pipeline.ts
- Create: test/tool-execution-stream.test.ts

**Interfaces:**

- ToolExecutionPipeline.executeStream(call, context, stepId, signal): AsyncGenerator<AgentEvent, ExecutionOutcome>.
- ToolExecutionPipeline.execute(call, context, stepId, signal): Promise<ExecutionOutcome> remains available and drains executeStream() while discarding V1 events.

- [ ] Step 1: Write the failing pipeline stream test

Build the pipeline with Toolkit, GuardEngine([]), HookExecutor([]), DefaultToolRunner, InMemoryCheckpointStore, EventBus, a fixed EventFactory, NoopObservability, and actionMode: 'dry_run'. Register a safe evidence tool whose async-generator return yields one progress chunk and one text delta. Assert:

~~~typescript
const stream = pipeline.executeStream(call, context, 'step-1', signal);
const events: AgentEvent[] = [];
let outcome: ExecutionOutcome | undefined;
while (true) {
  const item = await stream.next();
  if (item.done) { outcome = item.value; break; }
  events.push(item.value);
}
expect(events.map((item) => item.type)).toEqual([
  'TOOL_STARTED', 'TOOL_PROGRESS', 'TOOL_PROGRESS', 'TOOL_RESULT',
]);
expect(events[1]?.payload).toMatchObject({ toolCallId: 'call-1', chunk: { type: 'progress' } });
expect(events[2]?.payload).toMatchObject({ toolCallId: 'call-1', chunk: { type: 'text_delta', delta: 'partial' } });
expect(outcome?.type).toBe('completed');
expect(outcome?.result.status).toBe('success');
~~~

- [ ] Step 2: Run the focused test and verify red

Run: pnpm test -- test/tool-execution-stream.test.ts

Expected: failure because executeStream() does not exist and the pipeline currently only publishes through EventSink.

- [ ] Step 3: Implement executeStream() without bypassing guards or hooks

Refactor the validated execution path into an async generator. Await V2 TOOL_STARTED, then yield its canonical V1 event. Consume runner.stream() manually so every progress/text chunk is converted to V2 plus the matching canonical V1 TOOL_PROGRESS event. After producing the result, await V2 TOOL_RESULT and yield the V1 result event. Keep external execution, guard rejection, pre-hook interruption, post-hook abort, idempotency, evidence collection, and error conversion in the same pipeline. Implement execute() as a drain wrapper.

For V2 mode, do not publish a second V1 EventBus copy. For no-V2 mode, executeStream() must publish the same V1 event to the injected EventSink before yielding it. Preserve the existing no-V2 external execution notification behavior and do not expose raw input in the direct event payload.

- [ ] Step 4: Run focused and existing tool tests

Run: pnpm test -- test/tool-execution-stream.test.ts test/tool-runner.test.ts test/tool-boundaries.test.ts

Expected: PASS with the existing guard, hook, result, and streaming behavior intact.

- [ ] Step 5: Commit the pipeline change

~~~text
git add src/tool/execution-pipeline.ts test/tool-execution-stream.test.ts
git commit -m "feat: stream tool execution events"
~~~

### Task 4: Merge parallel tool Generators while preserving deterministic results

**Files:**

- Create: src/tool/async-generator-multiplexer.ts
- Modify: src/tool/batch-executor.ts
- Create: test/tool-batch-stream.test.ts

**Interfaces:**

- mergeAsyncGenerators<T, R>(streams: readonly AsyncGenerator<T, R>[]): AsyncGenerator<T, R[]> yields whichever child produces the next item, closes remaining children in finally, and returns child final values in input order.
- ToolBatchExecutor.executeStream(calls, context, stepId, signal): AsyncGenerator<AgentEvent, BatchExecutionResult>.
- ToolBatchExecutor.execute() remains a drain wrapper returning Promise<BatchExecutionResult>.

- [ ] Step 1: Write the failing multiplexer and batch tests

Use two small async generators that yield distinct markers after different resolved Promises and return 1 and 2. Assert the merged stream contains both markers and returns [1, 2]. Then execute two isConcurrencySafe() === true tools through ToolBatchExecutor.executeStream() and assert both tool lifecycle streams are visible while BatchExecutionResult.results is ordered by calls.

Also assert an unsafe second tool starts only after the first unsafe tool returns, and that an interrupted unsafe tool marks later calls as skipped as the existing Promise API does.

- [ ] Step 2: Run the focused tests and verify red

Run: pnpm test -- test/tool-batch-stream.test.ts

Expected: failure because neither the multiplexer nor executeStream() exists.

- [ ] Step 3: Implement the minimal race-based merge

Start one .next() promise per active child. Race active promises, yield non-done values, schedule the next .next() for that child, and collect done values by original index. On a child rejection, close all remaining generators and rethrow so ToolBatchExecutor can convert that call to its existing failure result. In finally, call .return() on unfinished children and await all cleanup promises.

Use the multiplexer for the safe bucket, then drain unsafe pipeline streams one by one. Keep mixed evidence/action deferral, interrupt detection, skipped-result creation, and input-order result sorting unchanged.

- [ ] Step 4: Run focused and existing batch/boundary tests

Run: pnpm test -- test/tool-batch-stream.test.ts test/event-message-v2-acceptance.test.ts test/tool-boundaries.test.ts

Expected: PASS, including safe-tool parallelism and deterministic result order.

- [ ] Step 5: Commit the batch stream change

~~~text
git add src/tool/async-generator-multiplexer.ts src/tool/batch-executor.ts test/tool-batch-stream.test.ts
git commit -m "feat: merge concurrent tool event streams"
~~~

### Task 5: Replace Harness queue production with direct Generator delegation

**Files:**

- Modify: src/agent/agent-harness.ts
- Modify: test/model-harness-contract.test.ts
- Modify: test/runtime-events-v2.test.ts

**Interfaces:**

- Internal RunExecutionFrame stores context, finalText, activeStepId, activeStepStartedAt, terminalOutcome, and naturalExit.
- AgentHarness.run(frame, signal, resumed): AsyncGenerator<AgentEvent, DiagnosisRunResult>.
- AgentHarness.mainLoop(frame, signal): AsyncGenerator<AgentEvent, DiagnosisRunResult>.
- AgentHarness.reason(context, stepId, signal): AsyncGenerator<AgentEvent, ModelResponse>.
- AgentHarness.resumePendingToolCall(frame, signal): AsyncGenerator<AgentEvent, boolean>.

- [ ] Step 1: Add failing direct-stream and drain regression tests

Add a test that calls replyStream() directly with a one-shot model and asserts the yielded sequence contains RUN_STARTED, STEP_STARTED, REASONING_STARTED, TEXT_DELTA, and RUN_FINISHED, while the final done.value is a completed DiagnosisRunResult. Keep the existing reply() assertions to prove draining returns the same result.

Add a streaming-tool case that asserts TOOL_STARTED, both TOOL_PROGRESS events, and TOOL_RESULT are present in the direct Generator output.

- [ ] Step 2: Run the focused tests and verify red

Run: pnpm test -- test/model-harness-contract.test.ts test/runtime-events-v2.test.ts

Expected: the new direct stream assertions fail because the current implementation still depends on streamContext() and the batch Promise does not return tool events to the Generator.

- [ ] Step 3: Implement direct run()/mainLoop() delegation

Remove streamContext() and the Harness import/use of AsyncEventQueue. Construct a RunExecutionFrame in replyStream() and resumeStream(). Make run() create the root span, publish V2 lifecycle facts in order, delegate to mainLoop(), and save/flush in one finally.

Convert every V1 publication to yield* this.publish(...); publish() creates one V1 event, publishes to the legacy EventBus only when V2 is absent, then yields that same event. reason() manually drains the model Generator and yield*s TEXT_DELTA. mainLoop() manually drains batchExecutor.executeStream() and yields every tool event before processing its final batch result. resumePendingToolCall() does the same for resumed execution.

Use V2 payloads as the source for parity-sensitive V1 payloads. Emit direct TOOL_CALL_CREATED only for admitted calls in V2 mode and expose only { id, name }. Emit direct REQUIRE_CONFIRM and EXTERNAL_TOOL_REQUESTED after their V2 requested event using the same safe payload. Include finalText in V2 RUN_FINISHED and use that payload for V1 RUN_FINISHED.

- [ ] Step 4: Apply the checkpoint policy and terminal state handling

Keep the explicit save immediately after a pause state and at the end of a non-terminal iteration; keep the resumed pending-action save after replacement or re-pause. Remove the explicit normal-completion and catch-block saves. run() finally saves frame.context for all outcomes.

Set frame.naturalExit = true only after the final event of a normal completion, failure, or pause has been yielded and the method is about to return. If Generator return()/throw() closes the stream before that marker and the run is still active, set context.status = 'cancelled', set context.failure to { code: 'ABORTED', message: 'Agent stream consumer closed.', retryable: false }, fail the root span, and await V2 RUN_CANCELLED with actor: 'stream_consumer', reason: 'stream_consumer_closed', and the current stage. Do not yield after close. Always save and flush in finally; do not overwrite an already committed terminal failure/completion.

- [ ] Step 5: Run focused harness tests and verify green

Run: pnpm test -- test/model-harness-contract.test.ts test/runtime-events-v2.test.ts test/external-bash-flow.test.ts

Expected: PASS, including model deadline propagation, raw tool-call persistence, error recovery, V2 event order, and external Bash HITL resume.

- [ ] Step 6: Commit the Harness refactor

~~~text
git add src/agent/agent-harness.ts test/model-harness-contract.test.ts test/runtime-events-v2.test.ts
git commit -m "refactor: drive agent runs with direct async generators"
~~~

### Task 6: Prove event-source parity, early close, and Checkpoint behavior

**Files:**

- Create: test/agent-harness-async-generator.test.ts
- Modify: test/v1-event-bus-projection.test.ts
- Modify: test/event-message-v2-acceptance.test.ts

**Interfaces:**

- Test helper drainWithEvents(stream): Promise<{ events: AgentEvent[]; result: DiagnosisRunResult }>.
- Test helper comparable(event): { type: AgentEvent['type']; runId: string; stepId?: string; payload: AgentEvent['payload'] }.

- [ ] Step 1: Write the failing parity test

Run a V2-enabled runtime with a model that requests one streaming evidence tool and then returns final text. Collect direct Generator events and runtime.events events. Compare the complete comparable arrays, not just counts:

~~~typescript
expect(direct.map(comparable)).toEqual(fromEventBus.map(comparable));
expect(direct.filter((event) => event.type === 'TOOL_RESULT')).toHaveLength(1);
expect(direct.find((event) => event.type === 'RUN_FINISHED')?.payload).toMatchObject({ finalText: 'done' });
~~~

Do not compare independently allocated timestamps; separately assert every event timestamp is a valid ISO timestamp and all events have the same runId.

- [ ] Step 2: Run the parity test and verify red

Run: pnpm test -- test/agent-harness-async-generator.test.ts

Expected: failure showing the current queue/projector paths do not provide the same direct complete tool event sequence.

- [ ] Step 3: Add early-close and save-count tests

Use a checkpoint spy that records save() calls and an observability spy that records flush(). After consuming the first direct event, call await stream.return(undefined as never) and assert the saved context is cancelled, has failure.code === 'ABORTED', the save count is one final cleanup save, and flush() was called. Assert the V2 store contains RUN_CANCELLED.

For normal completion and model failure, assert finally saves the final context; for a non-terminal tool iteration, assert the explicit iteration save plus final cleanup save; for a pause, assert the pause checkpoint is written before returning and the final cleanup save also occurs.

- [ ] Step 4: Implement only parity/test fixes required by the approved design

If parity fails, fix the shared payload builder or the order of await publishV2() and yield* publish(); do not weaken the comparison by dropping payload fields. If close handling fails, fix frame terminal markers and Generator delegation cleanup; do not reintroduce an EventBus queue.

- [ ] Step 5: Run the focused compatibility suite

Run: pnpm test -- test/agent-harness-async-generator.test.ts test/v1-event-bus-projection.test.ts test/event-message-v2-acceptance.test.ts test/external-bash-flow.test.ts

Expected: PASS with exact comparable V1 event arrays and no duplicate V2 events.

- [ ] Step 6: Commit the parity and recovery tests

~~~text
git add test/agent-harness-async-generator.test.ts test/v1-event-bus-projection.test.ts test/event-message-v2-acceptance.test.ts
git commit -m "test: verify async generator event parity and recovery"
~~~

### Task 7: Full verification and documentation consistency

**Files:**

- Modify: docs/superpowers/specs/2026-09-09-agent-harness-async-generator-design.md if implementation details require wording clarification.
- Modify: docs/superpowers/plans/2026-09-09-agent-harness-async-generator-tool-stream.md to mark completed steps and record implementation rulings.

- [ ] Step 1: Verify no Harness queue bridge remains

Run: rg -n "AsyncEventQueue|streamContext|events\\.subscribe" src/agent src/tool

Expected: no matches in src/agent/agent-harness.ts; any remaining utility definition must be unused by the Harness and justified in the plan ledger.

- [ ] Step 2: Run the required full checks

Run each command separately and record its exit code:

~~~text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
~~~

Expected: all four commands exit with code 0 and the test runner reports zero failures.

- [ ] Step 3: Inspect the final diff and public contracts

Run:

~~~text
git status --short
git diff --check HEAD~7..HEAD
git log --oneline -8
~~~

Review that no raw tool input, secret, internal address, or model private reasoning was added to V1 events, no public V2 field was removed/renamed, and http-server.ts/consume() is unchanged.

- [ ] Step 4: Commit documentation updates

~~~text
git add docs/superpowers/specs/2026-09-09-agent-harness-async-generator-design.md docs/superpowers/plans/2026-09-09-agent-harness-async-generator-tool-stream.md
git commit -m "docs: record async generator implementation status"
~~~

## Self-Review Checklist

- Spec coverage: Tasks 1–2 cover direct V1/V2 contract parity and model/tool stream primitives; Tasks 3–5 cover tool pipeline, batch merge, Harness loop, pause/resume, and consumer close; Task 6 covers exact parity and Checkpoint behavior; Task 7 covers HTTP non-regression and required verification.
- Placeholder scan: every task has concrete files, interfaces, test behavior, commands, and commit scope; there are no unspecified edge-case steps.
- Type consistency: ToolRunner.stream() returns AsyncGenerator<ToolResponseChunk, ToolResponse>; ToolExecutionPipeline.executeStream() returns AsyncGenerator<AgentEvent, ExecutionOutcome>; ToolBatchExecutor.executeStream() returns AsyncGenerator<AgentEvent, BatchExecutionResult>; Harness drains each exact return type.
- Security: V1 direct payloads are built from safe fields and the existing V2 public/audit separation remains intact.
- Recovery: Generator close, AbortSignal, HITL pause, external execution, normal completion, and model failure each have an explicit state and save/flush assertion.

