# Safety Projection and LangSmith Review Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the public missing-evidence disclosure gap and the two LangSmith trace-probe review findings without changing model request behavior or weakening upload privacy checks.

**Architecture:** Keep untrusted missing-evidence descriptions internal. Apply the existing contract-level allowlist projection at every public message and SSE boundary, preserving the existing `missingEvidence: string[]` shape and using a fixed safe fallback for unknown values. Keep the LangSmith readback exception for `ls_run_depth` isolated from the outbound upload validator. Extend the offline trace fixture so root-span mismatches are actually exercised.

**Tech Stack:** TypeScript, Node.js, Vitest, LangSmith SDK fake HTTP boundary.

**Specs:** `docs/superpowers/specs/2026-09-14-source-subagent-design.md`; `docs/superpowers/specs/2026-10-04-real-model-langsmith-acceptance-design.md`.

**Global Constraints**

- Preserve internal `SourceSubagentResult.missingEvidence` for diagnosis; public projections must not expose unclassified descriptions, internal endpoints, credentials, or remote payloads.
- Keep the public `missingEvidence` array shape unchanged. Known safe codes may pass through; every unknown value maps to `unclassified_evidence_gap` and the UI uses a fixed human-readable label rather than echoing unknown input.
- The LangSmith readback validator may accept `ls_run_depth` only as a non-negative safe integer. The outbound upload privacy allowlist must remain unchanged and reject that field.
- Keep probe request limits and fail-closed behavior. Local tests must use fake transport only; no LangSmith or model calls.
- Root-span mismatch diagnostics may report only the fixed span label `root`, never remote IDs or payloads.

### Task 1: Close public missing-evidence projection gaps

**Files:**
- Modify: `src/contracts/missing-evidence.ts`
- Modify: `src/contracts/source-subagent.ts`
- Modify: `src/contracts/read-model.ts`
- Modify: `src/contracts/index.ts`
- Modify: `src/acceptance/evaluator.ts`
- Modify: `src/acceptance/source-reports.ts`
- Modify: `src/application/source-report-collector.ts`
- Modify: `src/application/metrics-source-report-collector.ts`
- Modify: `src/application/logs-source-report-collector.ts`
- Modify: `src/application/source-subagent-runner.ts`
- Modify: `src/tool/adapters/source-subagent-tool-adapter.ts`
- Modify: `src/event/projectors/public-message-projector.ts`
- Modify: `src/event/projectors/public-projector.ts`
- Modify: `apps/agent-web/src/components/EvidencePanel.tsx`
- Modify: `apps/agent-web/src/components/MessageList.tsx`
- Modify: `apps/agent-web/src/components/missing-evidence-label.ts`
- Modify: `test/acceptance-evaluator.test.ts`
- Modify: `test/context-compression-l1.test.ts`
- Modify: `test/inspection-query-sqlite.test.ts`
- Test: `test/event-v2-projections.test.ts`
- Test: `test/event-message-v2-acceptance.test.ts`
- Test: `test/missing-evidence-label.test.ts`
- Modify: `docs/superpowers/specs/2026-09-14-source-subagent-design.md`

- [x] Add failing tests proving unknown/malicious missing-evidence text in message and SSE projections becomes the fixed safe code, while known allowlisted codes remain usable.
- [x] Cover `context_summary`, `diagnosis`, `EVIDENCE_COLLECTION_FAILED`, and `HYPOTHESIS_UPDATED` projection paths.
- [x] Make the UI label fallback fixed and non-echoing for unknown values.
- [x] Reuse the contract projection helpers; do not mutate stored messages/events or add a breaking public schema field.
- [x] Document that all public projections, not only Run read models and compression summaries, use safe codes.
- [x] Run focused projection tests and related acceptance tests.

### Task 2: Separate LangSmith upload/readback policy and exercise root mismatch

**Files:**
- Modify: `src/acceptance/langsmith-query-transport.ts`
- Modify: `src/acceptance/langsmith-trace-probe.ts`
- Modify: `src/acceptance/langsmith-verifier.ts`
- Modify: `src/acceptance/langsmith-export-safety.ts`
- Modify: `test/langsmith-query-transport.test.ts`
- Modify: `test/langsmith-trace-probe.test.ts`
- Modify: `test/langsmith-verifier.test.ts`
- Test: `test/langsmith-export-safety.test.ts`
- Modify: `test/fixtures/langsmith-memory-server.ts`
- Modify: `docs/superpowers/plans/2026-10-08-langsmith-trace-probe-shape-diagnostics.md`
- Modify: `docs/superpowers/specs/2026-10-04-real-model-langsmith-acceptance-design.md`
- Modify: `docs/guides/real-model-langsmith-acceptance.md`

- [x] Add failing tests proving readback accepts `ls_run_depth: 0` but rejects negative, fractional, and string values, while outbound upload rejects `ls_run_depth`.
- [x] Split or otherwise clearly isolate the readback allowlist from the outbound allowlist; preserve the existing strict upload field set.
- [x] Fix the fake server to apply a selected mismatch to the selected root or model span, rather than silently skipping root mutations.
- [x] Add a root-span mismatch assertion that returns `mismatchSpan: 'root'` and leaks no IDs or payloads; retain model-span mismatch coverage.
- [x] Update the LangSmith spec/guide to state that `ls_run_depth` is readback-only and root-span mismatch coverage is present.
- [x] Run focused LangSmith tests, lint, typecheck, and build. No real model smoke was run.
