# Agent Runtime Governance and Context Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Complete the remaining runtime-governance Spec by making L1/L2 compression deterministic, validated, recoverable, observable, and compatible with the already shipped L0 evidence boundary.

**Architecture:** Keep one AgentHarness and one V2 event fact stream. A layered ContextCompressor creates an immutable candidate, a CompressionValidator checks tool-call/evidence/state invariants, and the Harness commits only a valid candidate; L2 uses an injected compact ChatModel through a strict structured summarizer and falls back to the valid L1 candidate. Existing L0 ToolResultCompactor and Evidence Manifest/BlobStore remain the only owners of evidence identity and raw data.

**Tech Stack:** TypeScript, Node.js 20, pnpm, Zod, existing AsyncGenerator AgentHarness, V2 EventPublisher, SQLite/InMemory CheckpointStore and EvidenceManifestStore.

**Spec:** docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md

**Execution status:** Completed on 2026-09-15. Tasks 1–7 are implemented and verified; Task 8 full gates passed with the documented real-Prometheus environment test skipped because no endpoint was configured.

## Global Constraints

- AgentHarness remains the only authoritative loop; compressors, validators, and summarizers never execute Tools or publish events.
- V2 events are authoritative; existing V1 events remain compatible and no new V1 EventType is introduced for the three compression lifecycle facts.
- L0 never creates evidence; only EvidenceRecorder/StreamingEvidenceRecorder may create evidence IDs, manifests, and blobs.
- L1 is deterministic and side-effect free; L2 is optional, bounded by the parent deadline, and may retry the compact model at most once.
- A failed validation never replaces the frame Context; a repair may only restore exact pre-compression messages or references and may not fabricate a successful ToolResult.
- IDs, clocks, deadlines, model calls, stores, and random sources are injected or deterministic; no module-level Run state and no process.cwd().
- Raw Tool input, raw log text, credentials, storage keys, and internal paths stay out of public events, SSE, audit projections, and LangSmith.
- Every production behavior change starts with a failing test and ends with focused tests plus pnpm lint, pnpm typecheck, pnpm test, pnpm build, and git diff --check.

---

### Task 1: Add versioned compression contracts and state helpers ✅ Completed

**Files:**
- Create: src/contracts/context-compression.ts
- Modify: src/contracts/index.ts
- Modify: src/contracts/governance.ts
- Modify: src/context-compressor/types.ts
- Test: test/context-compression-contract.test.ts

**Interfaces:**
- CompressionOptions carries signal, deadline, and injected now(): Date.
- HistorySummaryInput carries runId, the immutable pre-compression AgentContext, source message IDs, and the untrusted model-facing history view.
- StructuredHistorySummary is a strict, JSON-safe extension of ContextSummary with sourceMessageIds, keyToolCalls, evidenceIds, confirmationIds, riskRuleIds, and positive summaryVersion.
- CompressionValidationResult reports valid, repairable, stable reasonCode, affected IDs, and an optional exact repairedContext.
- CompressionResult gains optional trace and validation fields while retaining existing context and decision.
- ContextCompressor.compress(context, options?) remains source-compatible for existing custom implementations.

- [ ] Step 1: Write the failing contract tests

Add tests that parse a valid structured summary, reject unknown fields and negative versions, accept a legacy ContextSummary without additive fields, and verify a compression result can carry a trace without changing the existing required fields.

~~~ts
it('rejects a structured history summary with an unknown field', () => {
  expect(() => parseStructuredHistorySummary({
    confirmedFacts: [],
    hypotheses: [],
    missingEvidence: [],
    pendingActionIds: [],
    executedActionIds: [],
    unresolvedRisks: [],
    sourceMessageIds: ['message-1'],
    keyToolCalls: ['call-1'],
    evidenceIds: [],
    confirmationIds: [],
    riskRuleIds: [],
    summaryVersion: 1,
    unexpected: true,
  })).toThrow();
});
~~~

- [ ] Step 2: Run the focused contract test and verify the expected failure

Run: pnpm test -- test/context-compression-contract.test.ts

Expected: FAIL because the new parser and contracts do not exist.

- [ ] Step 3: Implement the contracts and exports

Use strict Zod objects with bounded arrays and strings. Export the types and parsers from src/contracts/index.ts. Add optional CompressionTrace and CompressionValidationResult fields to the existing compressor types; do not change existing required field names.

- [ ] Step 4: Run the focused contract test

Run: pnpm test -- test/context-compression-contract.test.ts

Expected: PASS.

- [ ] Step 5: Commit

~~~bash
git add src/contracts/context-compression.ts src/contracts/index.ts src/contracts/governance.ts src/context-compressor/types.ts test/context-compression-contract.test.ts
git commit -m "feat: define context compression contracts"
~~~

### Task 2: Implement deterministic L1 candidate building ✅ Completed

**Files:**
- Create: src/context-compressor/l1-structure-pruner.ts
- Modify: src/context-compressor/rule-based-compressor.ts
- Test: test/context-compression-l1.test.ts

**Interfaces:**
- L1StructurePruner.prune(input: { context: AgentContext; keepRecentMessages: number; maxMessages: number; now: () => Date }): CompressionCandidate.
- The candidate contains a new immutable AgentContext, sourceMessageIds, protectedMessageIds, keyToolCalls, evidenceIds, and summaryVersion.
- Tool-call/result groups are kept or summarized as a unit. An unmatched visible call is retained unless it is explicitly in pendingToolBatch or pendingToolCalls.
- The generated context_summary uses only deterministic state from the pre-compression Context and existing messages; it never invents facts, evidence IDs, confirmations, or risk IDs.

- [ ] Step 1: Write failing L1 tests

Cover recent-message retention, pair preservation, pending calls, action/confirmation state, evidence IDs, stable summary IDs, and immutability.

~~~ts
it('summarizes complete historical tool exchanges without orphaning a call', () => {
  const before = fixtureContextWithToolPair('call-old', 'message-old');
  const candidate = new L1StructurePruner().prune({
    context: { ...before, messages: [...before.messages, ...manyRecentMessages(40)] },
    keepRecentMessages: 4,
    maxMessages: 8,
    now: () => new Date('2026-09-14T00:00:00.000Z'),
  });

  expect(candidate.context.messages.flatMap(toolCallIds)).not.toContain('call-old');
  expect(candidate.context.messages.flatMap(summaryCallIds)).toContain('call-old');
  expect(hasOrphanVisibleToolCall(candidate.context)).toBe(false);
  expect(before.messages).toHaveLength(42);
});
~~~

- [ ] Step 2: Run the focused L1 test and verify it fails

Run: pnpm test -- test/context-compression-l1.test.ts

Expected: FAIL because the structure pruner does not exist.

- [ ] Step 3: Implement the pure pruner

Index calls/results by toolCallId, compute protected message IDs from system/user messages, pending state, interrupts, confirmation/action blocks, and unpaired current calls, then select recent complete groups. Insert exactly one deterministic summary at the first removed-message position. Preserve contextVersion, increment it only in the candidate, and update governance.compression through a cloned state.

- [ ] Step 4: Integrate L1 selection into RuleBasedContextCompressor

Retain the existing no-compression path and L0 ToolResultCompactor. Evaluate L1 at 40 messages, return a candidate trace, and do not label deterministic L1 as L2 merely because serialized bytes exceed the old threshold.

- [ ] Step 5: Run focused tests

Run: pnpm test -- test/context-compression-l1.test.ts test/tool-result-compactor.test.ts

Expected: PASS.

- [ ] Step 6: Commit

~~~bash
git add src/context-compressor/l1-structure-pruner.ts src/context-compressor/rule-based-compressor.ts test/context-compression-l1.test.ts
git commit -m "feat: add deterministic l1 context pruning"
~~~

### Task 3: Implement evidence-aware CompressionValidator and repair ✅ Completed

**Files:**
- Create: src/context-compressor/compression-validator.ts
- Modify: src/context-compressor/types.ts
- Modify: src/contracts/storage.ts only if the validator needs a narrow read-only port
- Test: test/context-compression-validator.test.ts

**Interfaces:**
- CompressionValidator.validate(input: { before: AgentContext; candidate: AgentContext; sourceMessageIds: readonly string[]; maxMessages: number; maxBytes: number }): Promise<CompressionValidationResult>.
- DefaultCompressionValidator accepts optional EvidenceManifestStore, maxMessages, and maxBytes.
- Evidence validation uses EvidenceManifestStore.getVisible(evidenceId) and accepts only a visible manifest whose runId equals the Context run.
- Repair restores exact original message blocks from before; it never creates a fake success result and never trusts IDs supplied only by an L2 model.

- [ ] Step 1: Write failing validator tests

Cover valid paired history, orphaned visible ToolCall, missing summary keyToolCalls, cross-run evidence, pending/failed evidence, preserved interrupt/action state, over-limit candidate, and exact-message repair.

~~~ts
it('rejects a cross-run evidence reference instead of accepting it as a summary fact', async () => {
  const result = await validator.validate({
    before: contextWithEvidence('run-1', 'evidence-1'),
    candidate: contextWithSummary('run-1', { evidenceIds: ['evidence-1'] }),
    sourceMessageIds: [],
    maxMessages: 40,
    maxBytes: 256000,
  });

  expect(result.valid).toBe(false);
  expect(result.reasonCode).toBe('evidence_not_visible_for_run');
});
~~~

- [ ] Step 2: Run the focused validator test and verify failure

Run: pnpm test -- test/context-compression-validator.test.ts

Expected: FAIL because the validator is not implemented.

- [ ] Step 3: Implement validation and deterministic repair

Validate visible ToolCall/result pairing, summary coverage of removed call IDs, evidence visibility and ownership, preservation of durable state, source-ID subset rules, and size thresholds. When a candidate retains a call but drops its exact pre-compression result, return a repair candidate containing the original result message and mark the repair type restore_tool_result; otherwise return a safe failure.

- [ ] Step 4: Run focused validator tests

Run: pnpm test -- test/context-compression-validator.test.ts test/message-v2-contract.test.ts

Expected: PASS.

- [ ] Step 5: Commit

~~~bash
git add src/context-compressor/compression-validator.ts src/context-compressor/types.ts src/contracts/storage.ts test/context-compression-validator.test.ts
git commit -m "feat: validate and repair compressed context"
~~~

### Task 4: Implement strict compact-model L2 summarization ✅ Completed

**Files:**
- Create: src/context-compressor/history-summarizer.ts
- Modify: src/model/compacting-model.ts only if a shared model-view helper is required
- Test: test/history-summarizer.test.ts

**Interfaces:**
- HistorySummarizer.summarize(input: HistorySummaryInput, options: { signal: AbortSignal; deadline: number }): Promise<StructuredHistorySummary>.
- ModelHistorySummarizer takes an injected ChatModel, Clock, and maxInputBytes.
- It sends no Tools, uses a stable system instruction, wraps all history as untrusted data, parses only a strict JSON object, checks all returned IDs against the input allowlist, and retries one time before throwing a stable COMPRESSION_SUMMARY_INVALID or COMPRESSION_SUMMARY_MODEL_FAILED error.
- It stops immediately on AbortSignal and never starts a retry past the absolute deadline.

- [ ] Step 1: Write failing summarizer tests

Cover valid JSON, fenced JSON extraction, unknown fields, invented IDs, tool list empty, one retry after invalid JSON, deadline exhaustion, and abort without retry.

~~~ts
it('does not allow the compact model to invent an evidence ID', async () => {
  const model = scriptedSummaryModel(JSON.stringify({
    confirmedFacts: [],
    hypotheses: [],
    missingEvidence: [],
    pendingActionIds: [],
    executedActionIds: [],
    unresolvedRisks: [],
    sourceMessageIds: ['message-1'],
    keyToolCalls: [],
    evidenceIds: ['evidence-not-in-history'],
    confirmationIds: [],
    riskRuleIds: [],
    summaryVersion: 1,
  }));

  await expect(summarizer(model).summarize(input, options)).rejects.toMatchObject({
    code: 'COMPRESSION_SUMMARY_INVALID',
  });
});
~~~

- [ ] Step 2: Run the focused test and verify failure

Run: pnpm test -- test/history-summarizer.test.ts

Expected: FAIL because ModelHistorySummarizer does not exist.

- [ ] Step 3: Implement the summarizer

Use the existing ChatModel.stream AsyncGenerator, consume its text deltas and return value, call it with tools=[], deadline, and the same signal, and parse the strict Zod schema. Use the input-derived allowlists for source messages, calls, evidence, confirmations, and risk rules. Use injected time for deadline checks.

- [ ] Step 4: Run focused tests

Run: pnpm test -- test/history-summarizer.test.ts

Expected: PASS.

- [ ] Step 5: Commit

~~~bash
git add src/context-compressor/history-summarizer.ts test/history-summarizer.test.ts
git commit -m "feat: add bounded structured history summarizer"
~~~

### Task 5: Compose layered L1/L2 compression with rollback ✅ Completed

**Files:**
- Modify: src/context-compressor/rule-based-compressor.ts
- Modify: src/context-compressor/types.ts
- Test: test/context-compression-layered.test.ts

**Interfaces:**
- RuleBasedContextCompressorOptions gains optional summarizer, validator, maxSerializedBytesBeforeL2, now, and evidenceManifests.
- compress() first builds a valid L1 candidate when the L1 threshold is reached, then attempts L2 only when the token/byte threshold is reached and a summarizer exists.
- L2 failure returns the validated L1 candidate with decision.level=L1, validation.status=summary_fallback, and stable failure metadata; if L1 itself fails validation, return the original Context with decision.level=none and validation.status=failed.
- No candidate is mutated in place and no persistent state is changed until the Harness accepts the returned candidate.

- [ ] Step 1: Write failing layered tests

Cover L1 below L2 threshold, L2 success, invalid L2 fallback to L1, model exception fallback, validator failure retaining original, and compression state source/protected IDs.

~~~ts
it('falls back to the validated L1 candidate when compact summarization fails', async () => {
  const original = oversizedContext();
  const result = await compressor.compress(original, {
    signal: new AbortController().signal,
    deadline: Date.now() + 10000,
    now: () => new Date('2026-09-14T00:00:00.000Z'),
  });

  expect(result.decision.level).toBe('L1');
  expect(result.validation?.status).toBe('summary_fallback');
  expect(result.context.messages).not.toEqual(original.messages);
});
~~~

- [ ] Step 2: Run the focused test and verify failure

Run: pnpm test -- test/context-compression-layered.test.ts

Expected: FAIL because the current compressor labels byte trimming as L2 and has no validator/summarizer fallback.

- [ ] Step 3: Implement the layered orchestration

Separate the L1 candidate from the L2 candidate, preserve the previous context on validation failure, record stable trace data, and update the cloned governance.compression state only for an accepted candidate. Use the compact model deadline and pass only safe, bounded model-view history to the summarizer.

- [ ] Step 4: Run all compression-focused tests

Run: pnpm test -- test/context-compression-contract.test.ts test/context-compression-l1.test.ts test/context-compression-validator.test.ts test/history-summarizer.test.ts test/context-compression-layered.test.ts

Expected: PASS.

- [ ] Step 5: Commit

~~~bash
git add src/context-compressor/rule-based-compressor.ts src/context-compressor/types.ts test/context-compression-layered.test.ts
git commit -m "feat: compose validated l1 and l2 compression"
~~~

### Task 6: Integrate compression lifecycle events and checkpoint state ✅ Completed

**Files:**
- Modify: src/agent/agent-harness.ts
- Modify: src/application/create-runtime.ts
- Modify: src/contracts/event-v2/subsystem.ts only for additive safe fields if required
- Test: test/agent-harness-compression.test.ts

**Interfaces:**
- AgentHarnessDependencies gains no infrastructure dependency; it consumes the enriched CompressionResult from the injected compressor.
- Before accepting a candidate, publish durable CONTEXT_COMPRESSION_STARTED.
- After a valid candidate, update frame.context, persist it through the existing checkpoint/transition path, publish durable CONTEXT_COMPRESSED, and expose the existing compatible CONTEXT_COMPRESSED V1 event.
- On summary or validation failure, retain the prior Context, publish durable CONTEXT_COMPRESSION_FAILED with safe error details and fallbackPolicy=retain_previous or defer, and optionally publish CONTEXT_INTEGRITY_REPAIRED when the validator returned an exact repair.
- Compression lifecycle facts use V2 only for new event types; no V1 EventType additions.
- CONTEXT_COMPRESSED payload uses actual offloadedEvidenceIds and deterministic saved-byte/token estimates instead of hard-coded empty/zero values.

- [ ] Step 1: Write failing Harness integration tests

Cover successful L1/L2 events, V2 start/complete/failure ordering, rollback to the original Context, repair event, checkpoint persistence of CompressionState, and V1 CONTEXT_COMPRESSED compatibility.

~~~ts
it('publishes compression start before completion and checkpoints the accepted state', async () => {
  const result = await fixture.reply({ message: 'inspect', profileId: 'test' });
  const types = fixture.v2EventsFor(result.runId).map((event) => event.type);

  expect(types.indexOf('CONTEXT_COMPRESSION_STARTED')).toBeLessThan(types.indexOf('CONTEXT_COMPRESSED'));
  expect((await fixture.checkpoints.load(result.runId))?.context.governance?.compression.lastLevel)
    .toBe('L1');
});
~~~

- [ ] Step 2: Run the focused integration test and verify failure

Run: pnpm test -- test/agent-harness-compression.test.ts

Expected: FAIL because the Harness currently emits only completion and hard-codes evidence/token fields.

- [ ] Step 3: Implement event and checkpoint integration

Use publishV2 for subsystem lifecycle events, keep durable ordering through the existing transition/outbox mechanism, and use the existing publishStream only for the already-published V1-compatible completion event. Ensure a consumer closing the AsyncGenerator still saves the unchanged or accepted CompressionState through the existing finally checkpoint.

- [ ] Step 4: Wire optional compact model and validator ports

Add compactModel?: ChatModel, compressionValidator?: CompressionValidator, and compression?: Partial<RuleBasedCompressorOptions> to runtime options. The default runtime remains deterministic L1-only when no compact model is supplied; tests can inject a ScriptedModel. When L0 stores are present, pass the existing ToolResultCompactor and Manifest store to the validator without importing infrastructure into the Harness.

- [ ] Step 5: Run focused integration tests

Run: pnpm test -- test/agent-harness-compression.test.ts test/l0-runtime-boundary.test.ts test/runtime-persistence-v2.test.ts

Expected: PASS.

- [ ] Step 6: Commit

~~~bash
git add src/agent/agent-harness.ts src/application/create-runtime.ts src/contracts/event-v2/subsystem.ts test/agent-harness-compression.test.ts
git commit -m "feat: integrate durable compression lifecycle"
~~~

### Task 7: Add restart, recovery, and public-data safety acceptance tests ✅ Completed

**Files:**
- Create: test/context-compression-recovery.test.ts
- Modify: test/event-v2-audit-langsmith.test.ts
- Modify: test/sqlite-durable-state.test.ts only when a missing contract assertion is found
- Modify: docs/implementation-status.md
- Modify: docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md

**Interfaces:**
- The acceptance suite uses the existing SQLite persistence bundle, event outbox dispatcher, local Manifest/BlobStore, and injected compact model.
- A restart must reload CompressionState, avoid re-summarizing the same source range, preserve pending ToolCall/interrupt/action state, and drain pending compression events before new actions.
- Public, audit, and LangSmith projections must contain safe summaries and IDs only, never raw log text, full ToolResult, storage keys, absolute paths, or model credentials.

- [ ] Step 1: Write failing recovery and projection tests

Cover restart after accepted L1, restart after L2 fallback, pending outbox drain, no duplicate summary version, pending ToolCall preservation, and raw-data redaction in all projections.

- [ ] Step 2: Run the focused acceptance tests and verify any missing behavior

Run: pnpm test -- test/context-compression-recovery.test.ts test/event-v2-audit-langsmith.test.ts test/sqlite-durable-state.test.ts

Expected: at least one new recovery assertion fails before the implementation is complete.

- [ ] Step 3: Implement only the missing recovery/projection behavior

Reuse existing CAS checkpoint and Outbox APIs. Do not add a second persistence channel or replay transient compression deltas. Reuse stable summary version and source message IDs from CompressionState.

- [ ] Step 4: Run the focused acceptance tests

Run: pnpm test -- test/context-compression-recovery.test.ts test/event-v2-audit-langsmith.test.ts test/sqlite-durable-state.test.ts

Expected: PASS.

- [ ] Step 5: Update status documentation from verified evidence

Record that L0, L1, and L2 behavior, validation, rollback, lifecycle events, restart recovery, and projections are verified only to the extent covered by the passing tests. Keep real production ELK, object storage, and distributed leases explicitly out of scope if they are not tested.

- [ ] Step 6: Commit

~~~bash
git add test/context-compression-recovery.test.ts test/event-v2-audit-langsmith.test.ts test/sqlite-durable-state.test.ts docs/implementation-status.md docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md
git commit -m "test: verify recoverable context compression"
~~~

### Task 8: Run the complete quality gate and audit the Spec ✅ Completed

**Files:**
- Modify only files required by failing quality gates or documentation accuracy.

- [ ] Step 1: Run formatting/diff checks

Run: git diff --check

Expected: PASS with no whitespace errors.

- [ ] Step 2: Run the repository quality gates

Run: pnpm lint

Expected: PASS.

Run: pnpm typecheck

Expected: PASS.

Run: pnpm test

Expected: all configured tests pass; a real-environment test may be skipped only when its documented endpoint/configuration is absent.

Run: pnpm build

Expected: PASS.

- [ ] Step 3: Audit every Spec requirement

Check the Spec sections for L0, L1, L2, CompressionState, Validator, Outbox ordering, rollback semantics, public-data redaction, and recovery. Use code, tests, and command output as evidence. If any requirement lacks direct evidence, continue implementation rather than marking the goal complete.

- [ ] Step 4: Commit any final verification-only documentation correction

~~~bash
git status --short --branch
git log --oneline -8
~~~

The branch must be clean after the final commit. Do not push or claim remote synchronization unless the user separately requests it.
