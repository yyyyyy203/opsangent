# Source Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first complete source subagent, `logs_subagent`, as a canonical evidence Tool backed by the existing AgentHarness, bounded log evidence Tools, durable checkpoints, retry/recovery policy, and parent/child observability.

**Architecture:** Stable source contracts live in `contracts/`. The canonical Tool adapter validates the host-injected profile scope, creates a deterministic child Run identity, applies bounded retry, and flattens a validated `SourceSubagentResult` into the existing `ToolResponse` envelope. The application Runner creates a child AgentHarness through an injected factory and supplies only the four existing `logs.*` evidence Tools plus an internal `source_report` Tool. Bootstrap owns the concrete log source, manifest, child-agent, and Runtime composition; no core module imports SQLite, Blob, MCP, Elasticsearch, or a model SDK.

**Tech Stack:** TypeScript, Node.js 20, pnpm, Zod, Vitest, existing `AgentHarness`, `ToolExecutionPipeline`, SQLite/checkpoint ports, Event/Message V2 and LangSmith projectors.

**Spec:** `docs/superpowers/specs/2026-09-14-source-subagent-design.md`

## Global Constraints

- The parent Registry exposes only canonical `logs_subagent`; child-only `logs.*` and `source_report` Tools never enter the parent Toolkit.
- The existing `subagent.<name>` adapter naming remains backward compatible.
- A child may use only read-only evidence Tools; Bash, actions, external execution, other subagents, arbitrary HTTP/SQL and direct storage access are forbidden.
- `profileId`, profile revision, deadline, remaining Tool budget, signal and visible evidence ownership come from the host Context, not model input.
- Source results, events, SSE, Audit and LangSmith are bounded and never contain raw logs, full DSL, storage keys, paths, credentials, cookies or complete ToolResponses.
- `complete`, `partial` and `unavailable` are calculated from observed ToolResults and Manifest state; model-provided coverage/status fields are rejected.
- Retry is limited to three attempts, shares the parent network attempt ledger, and never replays a committed/partial capture without verification.
- New public fields are additive; existing ToolResponse, V1 events and V2 event names retain their meaning.
- Every production-code change starts with a failing test and is followed by the focused test, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` before completion.

### Task 1: Add source contracts and host-scope injection

**Files:**
- Create: `src/contracts/source-subagent.ts`
- Modify: `src/contracts/tool.ts`
- Modify: `src/contracts/index.ts`
- Test: `test/source-subagent-contract.test.ts`

**Interfaces:**
- Consumes: existing `Tool`, `ToolResponse`, `ToolResponseChunk`, `ToolCallOptions`, `EventFactoryV2Like`, `EventPublisherV2Like`, `IdGenerator`, `AgentEvent`, `DiagnosisRunResult` types.
- Produces: `SourceSubagentType`, `SourceSubagentStatus`, `SourceFinding`, `SourceSubagentRequest`, `SourceSubagentResult`, `SourceSubagentExecution`, `SourceSubagentRunner`, `SourceSubagentDescriptor`, `SourceSubagentRetryPolicy`, `SubagentLifecyclePorts`.

- [ ] **Step 1: Write the failing contract test.** Assert canonical name mapping (`logs -> logs_subagent`, `metrics -> metrics_subagent`, `traces -> traces_subagent`), strict result fields, and that `ToolCallOptions` accepts optional `profileId` and `profileRevision` without changing existing required fields.
- [ ] **Step 2: Run the focused test and verify it fails because the source contract module and canonical mapping do not exist.**

  Run: `pnpm exec vitest run test/source-subagent-contract.test.ts`

- [ ] **Step 3: Implement the contracts.** Define the exact unions and interfaces from Spec §6; add `profileId?: string` and `profileRevision?: string` to `ToolCallOptions`; export the new module from `src/contracts/index.ts`. Add a pure `canonicalSourceToolName(source)` helper that returns the three fixed names and throws on an unknown source.
- [ ] **Step 4: Run the focused test and verify it passes.**
- [ ] **Step 5: Commit the contract increment.**

  Commit: `feat: add source subagent contracts`

### Task 2: Implement bounded report collection and deterministic result calculation

**Files:**
- Create: `src/application/source-report-collector.ts`
- Test: `test/source-report-collector.test.ts`

**Interfaces:**
- Consumes: `EvidenceManifestStore`, `ToolResponse`, `SourceFinding`, `SourceSubagentResult`, `Clock`.
- Produces: `SourceReportCollector` implementation with `observeToolResult`, `acceptReport`, and `finalize`.

- [ ] **Step 1: Write failing tests for four behaviors:** only observed evidence IDs may be cited; an invalid/unknown citation rejects the candidate; Manifest coverage and partial state determine status/coverage; no observed evidence produces `unavailable` with no fabricated evidence ID. Also assert summary, statements, trace IDs and missing-evidence arrays are bounded.
- [ ] **Step 2: Run `pnpm exec vitest run test/source-report-collector.test.ts` and verify the expected missing-module failures.**
- [ ] **Step 3: Implement the collector.** Track only evidence IDs from successful child ToolResponses; query `getVisible` during finalization; validate finding references against the observed set and visible manifest ownership; normalize trace IDs and enforce the existing 16 KiB summary and 20-item limits; compute `complete` only when a valid report exists and all visible manifests are committed with no missing evidence, otherwise compute `partial` when evidence exists, otherwise `unavailable`.
- [ ] **Step 4: Run the focused tests and verify they pass.**
- [ ] **Step 5: Commit the collector increment.**

  Commit: `feat: add bounded source report collector`

### Task 3: Implement the child-Harness Runner and canonical Tool adapter

**Files:**
- Create: `src/application/source-subagent-runner.ts`
- Create: `src/tool/adapters/source-subagent-tool-adapter.ts`
- Modify: `src/tool/execution-pipeline.ts`
- Test: `test/source-subagent-tool.test.ts`
- Test: `test/source-subagent-runner.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts, Task 2 collector, injected `SourceChildAgentFactory`, injected child-tool factory, `CheckpointStore`, `EvidenceManifestStore`, `Clock`, `IdGenerator`, and existing V2 lifecycle ports.
- Produces: `SourceChildAgent`, `SourceChildAgentFactory`, `SourceReportCollectorFactory`, `SourceSubagentRunner` implementation, and `createSourceSubagentTool(descriptor)`.

- [ ] **Step 1: Write failing adapter tests.** Cover strict input rejection, host profile mismatch, missing `profileId`/`toolCallId` fail-closed behavior, fixed `kind/source/recoveryPolicy/isConcurrencySafe`, stable childRunId across retries, retryable errors only before visible output, abort/policy/terminal errors without retry, and partial/unavailable flattening into a bounded `ToolResponse`.
- [ ] **Step 2: Write failing Runner tests.** Use a child factory that returns an actual `AgentHarness` backed by a minimal Toolkit and ScriptedModel; assert the child receives only the allowed tools, its first message is rendered from stable fields, `TOOL_RESULT` evidence is collected, `source_report` is accepted through the child Pipeline, parent budget/deadline/network ledger are bounded, and `resumeStream` is used after a child checkpoint exists.
- [ ] **Step 3: Run both focused test files and verify failures are due to missing Runner/adapter behavior rather than test setup.**
- [ ] **Step 4: Implement `SourceSubagentRunner`.** Build the child execution context from host-injected values, calculate `maxToolCalls = min(8, remaining parent calls)` and `maxDurationMs = min(30_000, parent deadline remaining)`, create a child Toolkit from the injected factory, observe only child V1 `TOOL_RESULT` payloads, drive `replyStream`/`resumeStream`, and finalize through the collector. Render the child prompt with stable field order and never include raw log content or internal storage fields.
- [ ] **Step 5: Implement `createSourceSubagentTool`.** Validate the descriptor’s canonical name/source pair, parse the strict request schema, validate the host scope and visible parent evidence, derive the stable child identity from parent Run + ToolCall + source, emit existing `SUBAGENT_*` V2 events with `toolCallId`/`parentRunId`, apply max three attempts and the four rounds of retry → verify/resume → reduced scope → unavailable, and return a bounded JSON result plus evidence references. Preserve old `adaptSubagentTool` behavior unchanged.
- [ ] **Step 6: Add `profileId` and `profileRevision` to the ToolCallOptions object built in `ToolExecutionPipeline`, taking them from `context.profileId` and the immutable governance profile revision when present.
- [ ] **Step 7: Run the focused tests and verify they pass.**
- [ ] **Step 8: Commit the Runner and adapter increment.**

  Commit: `feat: add recoverable source subagent runner`

### Task 4: Compose `logs_subagent` with the existing log evidence Tools

**Files:**
- Create: `src/bootstrap/logs-subagent.ts`
- Modify: `src/bootstrap/index.ts`
- Modify: `src/application/create-runtime.ts`
- Modify: `src/bootstrap/inspection-runtime.ts`
- Test: `test/logs-subagent-runtime.test.ts`

**Interfaces:**
- Consumes: `createLogEvidenceTools`, `LogEvidenceToolOptions`, `SourceChildAgentFactory`, Task 3 Runner/adapter, existing L0 ports and V2 lifecycle dependencies.
- Produces: `createLogsSubagentTool(options)` and an explicit Runtime composition option that registers the canonical parent Tool while constructing child-only tools separately.

- [ ] **Step 1: Write failing composition tests.** Assert the parent Toolkit contains `logs_subagent` but none of the four `logs.*` Tools; the child Toolkit contains exactly the four `logs.*` Tools plus `source_report`; Bash, action, external and subagent Tools are absent; a multi-turn child capture/search/report returns a structured result with evidence IDs; and the parent receives one ordinary ToolResponse.
- [ ] **Step 2: Run `pnpm exec vitest run test/logs-subagent-runtime.test.ts` and verify the expected registration/runner failures.**
- [ ] **Step 3: Implement the bootstrap factory.** Accept log page source, recorder, manifests, reader, budget, child-agent factory, checkpoint and lifecycle ports; create the four `logs.*` Tools only for the child; create `source_report` with the strict report schema; construct the Runner and canonical adapter; return only `logs_subagent` to the parent.
- [ ] **Step 4: Extend Runtime options with an explicit `sourceSubagentTools?: readonly Tool[]` or equivalent factory boundary, register those tools before Toolkit freeze, and keep `createInspectionRuntime` allowlist/action/Bash checks applied to the parent Tool only. Do not auto-register child-only Tools.
- [ ] **Step 5: Run the focused runtime test and verify it passes.**
- [ ] **Step 6: Commit the Logs Subagent composition increment.**

  Commit: `feat: compose logs source subagent`

### Task 5: Verify durable recovery, public boundaries, documentation and full gates

**Files:**
- Create: `test/source-subagent-recovery.test.ts`
- Modify: `src/event/projectors/langsmith-projector.ts` only if the new lifecycle payload requires an additive parent-span lookup fix.
- Modify: `docs/implementation-status.md`
- Modify: `docs/architecture/05-subagents-and-mcp.md`
- Modify: `docs/architecture/08-observability.md`

**Interfaces:**
- Consumes: the complete Logs Subagent composition and existing SQLite/Event/Message/LangSmith projectors.
- Produces: restart/retry/partial/unavailable and redaction evidence, plus documentation that separates injected/local validation from real ELK production acceptance.

- [ ] **Step 1: Write failing recovery and boundary tests.** Simulate a committed capture followed by an aggregate failure, restart the SQLite-backed runtime, assert the same childRunId resumes without a second capture, assert exhausted retries return partial/unavailable correctly, assert shared network attempts are consumed, and assert Public/Audit/LangSmith projections contain no raw log, DSL, storage key, path or complete ToolResponse.
- [ ] **Step 2: Run `pnpm exec vitest run test/source-subagent-recovery.test.ts` and verify the failures identify the missing recovery behavior.**
- [ ] **Step 3: Implement only the missing recovery/projector changes.** Reuse existing checkpoint and Manifest ports; do not add a second persistence mechanism or duplicate V2 event names.
- [ ] **Step 4: Update status and architecture docs with exact implemented files, injected/local test scope, and explicit real ELK/online-model non-claims.**
- [ ] **Step 5: Run the complete quality gate:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check`.
- [ ] **Step 6: Review the Spec §2–§16 line by line against tests and code, then commit the documentation and verification increment.**

  Commit: `docs: record logs source subagent implementation`

## Completion Checklist

- [ ] Parent exposes only canonical `logs_subagent`; child-only Tools are not parent-visible.
- [ ] Child execution uses the existing AgentHarness and the standard admission/execution pipeline.
- [ ] Stable child identity, parent budget/deadline/signal/profile scope and shared network ledger are enforced.
- [ ] Report references are manifest-visible and status/coverage are deterministic.
- [ ] Retry, verify/resume, reduced scope and unavailable degradation are covered by tests.
- [ ] Parent/child events, Checkpoint, Public/Audit/LangSmith redaction and restart behavior are verified.
- [ ] All quality gates pass, and documentation does not claim real ELK or online production acceptance.
