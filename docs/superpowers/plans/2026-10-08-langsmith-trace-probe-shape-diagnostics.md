# LangSmith Trace Probe Shape Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Verify the selected LangSmith fields for each synthetic span while safely handling remote Run objects that include additional top-level fields.

**Architecture:** Keep the detailed, fixed-enum validator for selected Run content. Before the LangSmith SDK decodes query responses, project each Run at the HTTP boundary to one shared selected-field list, count discarded top-level fields, and preserve pagination cursors. The trace probe reports only fixed issue categories, synthetic span categories, and counts; offline fake-server tests cover wide responses, pagination, nested rejection paths, and leak prevention.

**Tech Stack:** TypeScript, Node.js 24, Vitest, LangSmith SDK fake HTTP boundary.

**Spec:** docs/superpowers/specs/2026-10-04-real-model-langsmith-acceptance-design.md

## Global Constraints

- Keep upload privacy allowlists and selected nested Run payload checks fail-closed.
- The readback boundary may discard unselected remote top-level fields before SDK/application consumption; it must not alter selected field values.
- Do not include remote field names, values, IDs, payloads, credentials, or internal addresses in diagnostics.
- Local tests must use the fake LangSmith HTTP server; do not call LangSmith or a model.
- Preserve the existing boolean isSafeLangSmithRunPayload behavior on the projected Run object.

---

### Task 1: Classify remote payload shape failures

**Files:**
- Modify: src/acceptance/langsmith-verifier.ts
- Modify: test/fixtures/langsmith-memory-server.ts
- Test: test/langsmith-trace-probe.test.ts

**Interface:** Add inspectLangSmithRunPayload(value): LangSmithRunPayloadSafetyIssue | undefined; retain isSafeLangSmithRunPayload(value): boolean as a wrapper.

- [x] Add fake readback variants for disallowed top-level, input, output, extra, metadata, and error shapes.
- [x] Assert each variant maps to a fixed category and serialized results exclude canary payloads, credentials, and remote IDs.
- [x] Run the focused test and confirm the new expectations fail against the current implementation.
- [x] Implement the detailed classifier without changing accepted payloads.
- [x] Run focused trace-probe and verifier tests.

### Task 2: Report the failing synthetic span

**Files:**
- Modify: src/acceptance/langsmith-trace-probe.ts
- Modify: test/langsmith-trace-probe.test.ts
- Modify: docs/guides/real-model-langsmith-acceptance.md

**Interface:** Add optional mismatchSpan: 'root' | 'model' to trace-probe diagnostics.

- [x] Assert model and root shape failures report the correct static span category.
- [x] Assert unknown-identity failures do not invent a span category.
- [x] Run the focused test and confirm the new expectations fail before implementation.
- [x] Propagate only the classifier category and static span category; keep payload details private.
- [x] Document the safe diagnostic fields.
- [x] Run targeted tests, typecheck, build, and lint.

### Follow-up: Distinguish top-level object shape from unselected fields

**Reason:** The first remote probe reported a root top-level shape rejection but intentionally withheld field names and values, so the diagnostic could not distinguish an invalid object from extra unselected fields.

- [x] Add a test proving diagnostics distinguish non-object shape from unselected top-level fields and report only a count.
- [x] Preserve the existing rejection behavior and expose no remote keys, values, IDs, or raw payload.
- [x] Verify the focused offline tests pass.

### Task 3: Project wide LangSmith query responses before SDK decoding

**Files:**
- Modify: src/acceptance/langsmith-query-transport.ts
- Modify: src/acceptance/langsmith-verifier.ts
- Modify: src/acceptance/langsmith-trace-probe.ts
- Modify: test/langsmith-query-transport.test.ts
- Modify: test/fixtures/langsmith-memory-server.ts
- Modify: test/langsmith-trace-probe.test.ts
- Modify: docs/superpowers/specs/2026-10-04-real-model-langsmith-acceptance-design.md
- Modify: docs/guides/real-model-langsmith-acceptance.md

- [x] Reproduce that the real LangSmith SDK passes through unknown Run fields despite a `select` request.
- [x] Use one shared 11-field selection list for probe, full verifier, and response projection.
- [x] Project `runs` before SDK decoding, retain pagination cursors, and count dropped Run fields without retaining their names or values.
- [x] Cover two paginated wide Run pages with 44 unknown fields each and prove only selected fields reach the verifier.
- [x] Keep nested input/output/metadata/error, identity, parent-child, terminal state, and usage checks in place.
- [x] Document that readback projection does not prove the remote side did not store or return other fields.
- [x] Run all LangSmith focused tests, lint, typecheck, and build.

### Follow-up: Accept LangSmith-generated readback metadata

**Reason:** The real LangSmith Runs UI showed `ls_run_depth: 0` in the remote Run metadata. The verifier rejected that vendor-generated field before it could compare the selected Run payload.

- [x] Reproduce that valid `ls_run_depth` values fail while negative, fractional, and string values remain rejected.
- [x] Allow `ls_run_depth` only in remote metadata readback and validate it as a non-negative safe integer; do not change the outbound privacy allowlist.
- [x] Cover the metadata in the offline probe readback fixture and document the readback-only exception.
- [x] Focused LangSmith tests pass (62/62); lint, typecheck, and build pass. The full suite passed 1,312 tests; two unrelated startup/integration tests timed out under parallel load and passed when rerun individually.

### Review correction: isolate the readback-only metadata exception

**Reason:** A review found that `ls_run_depth` had been added to a metadata allowlist shared by remote readback and outbound upload validation. The readback exception was correct, but the shared validator also allowed the vendor field in a new upload.

- [x] Add an outbound-body regression test: ordinary approved metadata remains accepted, while `ls_run_depth: 0` is rejected.
- [x] Keep `ls_run_depth` in remote readback only, validated as a non-negative safe integer; outbound export uses an explicit validator that rejects it.
- [x] Fix the fake server to mutate the selected root or model span and test a root trace-ID mismatch without leaking IDs or payloads.
- [x] Focused LangSmith tests pass with fake transport only; no model or remote LangSmith request is made.
