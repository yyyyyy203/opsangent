# Profile Impact Guard Risk Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Spec §15 increment 2: immutable Profile snapshots, one-per-batch impact capture, deterministic Guardian coordination, and fail-closed RiskPolicy decisions integrated with the existing tool pipeline.

**Architecture:** Keep the legacy `GuardEngine` and `ResolvedRisk` path source-compatible, then add a governance path behind constructor-injected ports. `AgentHarness` resolves a Profile before the first model call and persists the snapshot in `AgentContext`; `ToolBatchExecutor` obtains one governance snapshot for each executable batch and passes it to `ToolExecutionPipeline`, which applies the resulting allow/confirm/deny decision before ToolRunner. No guard implementation imports Prometheus, SQLite, MCP SDK, or HTTP code.

**Tech Stack:** TypeScript, Node.js 20, pnpm, Vitest, Zod, SHA-256 canonical JSON.

**Spec:** `docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md`

## Global Constraints

- Implement only Spec §15 increment 2; do not implement the Hooks refactor, Loop Detection behavior, or L0/L1/L2 compression.
- Preserve the existing `Guardian`, `GuardEngine`, Tool, ToolResponse, V1 event, V2 event, and checkpoint contracts; additions are optional unless explicitly used by the governance path.
- Profile snapshots contain no credentials, SDK objects, raw inputs, or internal connection addresses; digest uses the existing canonical JSON and is version-prefixed.
- A missing/corrupt Profile fails before the first model request; a resumed Run uses the persisted Profile snapshot and does not resolve the online Profile again.
- Impact is captured at most once per executable Tool batch and is represented explicitly as available, unavailable, or stale.
- Guardian failures are deterministic and fail closed according to the Spec; no Guardian performs network retries.
- RiskPolicy is pure and deterministic: `deny > confirm > allow`; real actions and user-confirmed tools always require confirmation; forbidden actions and sensitive boundaries cannot be overridden.
- All concrete implementations are composed through `createAgentRuntime`; core code never instantiates infrastructure.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` before completion.

## File Structure

| File | Responsibility |
|---|---|
| `src/contracts/governance.ts` | ProfileResolver, ImpactSurfaceProvider, and governance evaluation ports. |
| `src/contracts/guard.ts` | Compatible guard input, guardian coordination, and policy contracts. |
| `src/profiles/profile-types.ts` | Serializable profile definition used by resolvers. |
| `src/profiles/profile-resolver.ts` | Static versioned resolver with validation, digest, cloning, and fail-closed missing-profile errors. |
| `src/profiles/unavailable-impact-surface-provider.ts` | Explicit no-provider fallback for development and tests. |
| `src/guard/guardian-coordinator.ts` | Ordered all-settled Guardian execution, timeout handling, and unavailable findings. |
| `src/guard/risk-policy.ts` | Pure deterministic allow/confirm/deny policy. |
| `src/guard/governance-evaluator.ts` | One impact capture per batch and per-call Guardian/Policy evaluation. |
| `src/guard/mcp-guardian.ts` | MCP source, action capability, and sensitive-key checks. |
| `src/guard/profile-guardian.ts` | Profile action allow/deny, legacy snapshot, and freeze-period checks. |
| `src/guard/impact-surface-guardian.ts` | Impact availability, staleness, downstream, and metric sanity findings. |
| `src/guard/bash-guardian.ts` | Extend existing Bash checks to explicit governance input while preserving legacy calls. |
| `src/tool/batch-executor.ts` | Evaluate governance once for an executable batch and pass the snapshot to each call. |
| `src/tool/execution-pipeline.ts` | Enforce a precomputed governance decision before hooks and ToolRunner. |
| `src/agent/agent-harness.ts` | Resolve and persist the Profile before RUN_STARTED/model reasoning. |
| `src/application/create-runtime.ts` | Inject resolver, impact provider, Guardian coordinator, and RiskPolicy. |
| `src/tool/adapters/*.ts`, `src/mcp/readonly-tools.ts`, `src/tool/builtin/bash-tool.ts` | Mark newly created tools with explicit source metadata. |
| `test/profile-resolver.test.ts` | Profile normalization, digest, cloning, and failure behavior. |
| `test/guardian-coordinator.test.ts` | Ordering, matches compatibility, deadline, and failure isolation. |
| `test/risk-policy.test.ts` | Pure policy precedence and fail-closed decisions. |
| `test/governance-runtime.test.ts` | Profile-before-model, one impact capture per batch, pipeline integration, and resume snapshot reuse. |

## Task 1: Add resolver and governance ports

**Files:**

- Modify: `src/contracts/governance.ts`
- Modify: `src/contracts/guard.ts`
- Create: `src/profiles/profile-types.ts`
- Create: `src/profiles/profile-resolver.ts`
- Create: `src/profiles/unavailable-impact-surface-provider.ts`
- Modify: `src/profiles/index.ts`
- Test: `test/profile-resolver.test.ts`

**Interfaces:**

- `ProfileResolver.resolve({ profileId, capturedAt, signal }): Promise<ResolvedProfileSnapshot>`
- `ImpactSurfaceProvider.capture({ profile, calls, signal, deadline }): Promise<ImpactSurfaceAssessment>`
- `ProfileDefinition` contains all snapshot policy fields except `digest`, `capturedAt`, and `source`.

- [x] **Step 1: Write failing resolver tests**

Test these behaviors against `StaticProfileResolver`: a known profile returns a frozen clone with a `sha256:v1:` digest; changing the returned arrays does not mutate the registered definition; missing profile rejects with `INVALID_INPUT` and `profile_not_found`; malformed freeze period rejects with `INVALID_INPUT`; abort is propagated before lookup.

- [x] **Step 2: Run the resolver tests and verify the failure is about missing resolver behavior**

Run: `pnpm test -- test/profile-resolver.test.ts`

Expected: FAIL because `StaticProfileResolver` and the new resolver contract do not yet exist.

- [x] **Step 3: Implement the resolver and ports**

Add `ProfileResolver` and `ImpactSurfaceProvider` to the contracts. Add `StaticProfileResolver` backed by a copied `Map`, validate non-empty IDs, supported service levels, IANA-like non-empty timezone, unique freeze IDs, valid ISO intervals with `startsAt < endsAt`, and no overlap ambiguity. Build the digest from `{ algorithm: 'sha256', version: 1, profile: normalizedDefinition }`, return a deep-frozen clone with `source: 'resolved'`, and throw only safe structured errors. Add `UnavailableImpactSurfaceProvider` returning `{ status: 'unavailable', reasonCode: 'impact_provider_unconfigured', evidenceIds: [] }` without pretending that no data means healthy.

- [x] **Step 4: Run the focused tests and typecheck**

Run: `pnpm test -- test/profile-resolver.test.ts` and `pnpm typecheck`

Expected: PASS with no type errors.

- [x] **Step 5: Commit the contract/resolver slice**

Run: `git add src/contracts/governance.ts src/contracts/guard.ts src/profiles test/profile-resolver.test.ts; git commit -m "feat: add versioned profile resolver ports"`

## Task 2: Implement GuardianCoordinator and deterministic RiskPolicy

**Files:**

- Modify: `src/contracts/guard.ts`
- Create: `src/guard/guardian-coordinator.ts`
- Create: `src/guard/risk-policy.ts`
- Create: `src/guard/mcp-guardian.ts`
- Create: `src/guard/profile-guardian.ts`
- Create: `src/guard/impact-surface-guardian.ts`
- Modify: `src/guard/bash-guardian.ts`
- Test: `test/guardian-coordinator.test.ts`
- Test: `test/risk-policy.test.ts`

**Interfaces:**

- `GuardianCoordinator.inspect(input: GovernanceGuardInput): Promise<GuardianInspection>`
- `DeterministicRiskPolicy.evaluate(input: RiskPolicyInput): RiskDecision`
- `GuardianInspection` returns ordered `findings` and `unavailableGuardians`.

- [x] **Step 1: Write failing coordinator and policy tests**

Cover: an omitted `matches` method is treated as matching; Guardian results remain in registration order even when promises resolve out of order; a rejected Guardian yields an unavailable finding without preventing sibling results; a deadline produces the same unavailable result; forbidden action beats a CRITICAL confirmation; an allowed action still confirms; an unlisted action is denied; an evidence Tool with unavailable impact can continue with a limitation; an S1 action with unavailable impact is denied; an S3 action with unavailable impact is confirm; sensitive MCP keys are denied; a Bash sensitive path is denied; and a normal evidence Tool with no findings is allowed.

- [x] **Step 2: Run the focused tests and verify they fail for missing classes**

Run: `pnpm test -- test/guardian-coordinator.test.ts test/risk-policy.test.ts`

Expected: FAIL because the coordinator, policy, and three new Guardian classes do not yet exist.

- [x] **Step 3: Implement ordered Guardian coordination**

Extend `GuardInput` with optional `stepId`, `profile`, and `impact` for legacy compatibility; define `GovernanceGuardInput` with those fields required plus `signal` and absolute `deadline`. Implement `GuardianCoordinator` using `Promise.allSettled` in registration order. Treat missing `matches` as true, apply a per-Guardian bounded deadline, preserve findings in array order, and append one safe `guard.unavailable` finding per rejected/timed-out Guardian. Never include the thrown error text or raw inputs in a Finding.

- [x] **Step 4: Implement the four deterministic Guardians**

Keep existing Bash behavior and add fail-closed workspace/sensitive-path rules. `McpGuardian` matches explicit `source: 'mcp'` or the controlled `mcp.` name prefix, rejects action-capable MCP tools unless explicitly allowed by Profile, and recursively detects key names matching token/password/secret/api-key/authorization/cookie/credential. `ProfileGuardian` matches all calls, rejects forbidden and unlisted action names, flags legacy snapshots, and emits a HIGH freeze-period finding for action calls in an active period. `ImpactSurfaceGuardian` matches all calls, emits an unavailable/stale finding with safe status/reason metadata, detects invalid numeric snapshots, and reports unhealthy downstream or increased error rate deterministically.

- [x] **Step 5: Implement pure RiskPolicy**

Use severity order `SAFE < LOW < MEDIUM < HIGH < CRITICAL`. Deny forbidden/unlisted actions, sensitive boundary findings, failed required Profile/Bash guardians, and S0/S1 action calls with unavailable impact. Confirm all action Tools, `requireUserConfirm`, HIGH/CRITICAL findings, S2/S3 action calls with unavailable impact, and non-evidence tools affected by unavailable guardians. Allow only evidence/utility calls whose findings are no stricter than MEDIUM, with the explicit evidence/impact-unavailable limitation exception. Return `policyVersion: 'risk/v2'`, `requireConfirmation: disposition === 'confirm'`, and cloned findings.

- [x] **Step 6: Run focused tests and the existing guard tests**

Run: `pnpm test -- test/guardian-coordinator.test.ts test/risk-policy.test.ts test/schema-and-guard.test.ts test/tool-boundaries.test.ts`

Expected: PASS.

- [x] **Step 7: Commit the guard/policy slice**

Run: `git add src/contracts/guard.ts src/guard test/guardian-coordinator.test.ts test/risk-policy.test.ts; git commit -m "feat: add deterministic guardian risk policy"`

## Task 3: Add batch governance evaluation and pipeline enforcement

**Files:**

- Create: `src/guard/governance-evaluator.ts`
- Modify: `src/tool/batch-executor.ts`
- Modify: `src/tool/execution-pipeline.ts`
- Modify: `src/tool/execution-types.ts`
- Modify: `src/contracts/governance.ts`
- Modify: `src/contracts/tool.ts`
- Modify: `src/tool/adapters/mcp-tool-adapter.ts`
- Modify: `src/tool/adapters/skill-tool-adapter.ts`
- Modify: `src/tool/adapters/subagent-tool-adapter.ts`
- Modify: `src/mcp/readonly-tools.ts`
- Modify: `src/tool/builtin/bash-tool.ts`
- Test: `test/governance-runtime.test.ts`

**Interfaces:**

- `GovernanceEvaluator.evaluateBatch({ runId, stepId, profile, calls, signal, deadline }): Promise<ToolBatchGovernanceSnapshot>`
- `ToolExecutionPipeline.executeStream(..., governance?: ToolBatchGovernanceSnapshot)` remains backward-compatible for callers that omit the last argument.

- [x] **Step 1: Write failing batch/pipeline tests**

Assert that one Provider capture serves two safe calls in one batch; decisions are matched by call ID and input digest; a denied call never invokes Hook or ToolRunner; a confirm decision reaches the existing RiskActionHook; an allow decision executes; mixed evidence/action batches evaluate only the executable evidence calls; a persisted pending-batch snapshot is reused without another Provider capture; and all newly constructed adapters expose the correct explicit `source`.

- [x] **Step 2: Run focused tests and verify missing evaluator/integration failure**

Run: `pnpm test -- test/governance-runtime.test.ts`

Expected: FAIL because no evaluator is composed and the batch/pipeline APIs do not accept governance snapshots.

- [x] **Step 3: Implement GovernanceEvaluator**

Capture impact once for the supplied call list. For each call in original order invoke `GuardianCoordinator.inspect`, pass its findings/unavailable IDs to `RiskPolicy.evaluate`, compute `checkpointChecksum(call.input)`, and return a `ToolBatchGovernanceSnapshot` with the Profile revision/digest and injected clock timestamp. Do not retain Run state in the evaluator.

- [x] **Step 4: Integrate batch evaluation without changing scheduling**

In `ToolBatchExecutor`, select evidence/utility calls before mixed-action deferral, reuse `context.pendingToolBatch.governance` when its Profile digest and step match, otherwise ask the pipeline for one snapshot, attach it to the pending batch, and pass the snapshot to every child pipeline stream. Preserve safe parallel/unsafe serial execution and input ordering.

- [x] **Step 5: Enforce the decision before existing Hooks**

Add optional governance input to `ToolExecutionPipeline.executeStream`. Use the matching decision and convert it to the legacy `ResolvedRisk` shape plus optional `disposition`/`policyVersion`. Publish `RISK_EVALUATED` with the policy version. For `deny`, return a terminal `POLICY_DENIED` ToolResult before `runBefore` and ToolRunner. For `confirm`/`allow`, continue through the existing Hook and execution flow. If a snapshot is missing or its digest does not match the normalized call, fail closed with `POLICY_DENIED` rather than silently re-evaluating with inconsistent facts.

- [x] **Step 6: Mark adapter source metadata and run focused tests**

Set `source: 'builtin'` for Bash, `mcp` for MCP adapters, `skill` for Skill adapters, and `subagent` for Subagent adapters. Run: `pnpm test -- test/governance-runtime.test.ts test/tool-batch-stream.test.ts test/tool-execution-stream.test.ts test/tool-boundaries.test.ts`

Expected: PASS.

- [x] **Step 7: Commit the evaluator/pipeline slice**

Run: `git add src/guard/governance-evaluator.ts src/tool src/contracts/governance.ts src/contracts/tool.ts src/mcp/readonly-tools.ts test/governance-runtime.test.ts; git commit -m "feat: enforce batch governance decisions"`

## Task 4: Resolve Profiles at Run creation and compose the runtime

**Files:**

- Modify: `src/agent/agent-harness.ts`
- Modify: `src/application/create-runtime.ts`
- Modify: `src/bootstrap/inspection-runtime.ts`
- Modify: `src/profiles/index.ts`
- Modify: `test/governance-runtime.test.ts`
- Modify: `docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md`

**Interfaces:**

- `AgentRuntimeOptions.profileResolver?: ProfileResolver`
- `AgentRuntimeOptions.impactSurfaceProvider?: ImpactSurfaceProvider`
- `AgentRuntimeOptions.enableGovernance?: boolean`

- [x] **Step 1: Write failing Profile lifecycle tests**

Use a recording model and resolver to prove the resolver runs before the first model stream; a missing Profile produces a failed Run with zero model calls; a supplied snapshot appears in `context.governance.profile`; a resumed Run does not call the resolver again; and the `RUN_STARTED` V2 version snapshot contains only Profile revision/digest/policyVersion.

- [x] **Step 2: Run the focused lifecycle tests and verify current Harness does not resolve Profiles**

Run: `pnpm test -- test/governance-runtime.test.ts`

Expected: FAIL because the Harness currently only creates a legacy initial snapshot.

- [x] **Step 3: Resolve once before RUN_STARTED and persist the snapshot**

Add the resolver to Harness dependencies. On a fresh Run, call it after creating the context and before the first model call/event, replace only `context.governance.profile`, and include the safe version snapshot in `RUN_STARTED`. On resume, keep the checkpoint profile unchanged. A resolver error follows the existing structured RUN_FAILED path and no model call is made.

- [x] **Step 4: Compose the governance path**

When `enableGovernance` is true, construct `GuardianCoordinator` with Bash plus supplied guardians, `DeterministicRiskPolicy`, `UnavailableImpactSurfaceProvider` unless an injected provider exists, and `GovernanceEvaluator`; pass the evaluator to the ToolBatchExecutor/Pipeline. Keep the existing legacy GuardEngine path when governance is disabled so old direct pipeline and compatibility tests remain valid. Export the new public ports and classes through the relevant barrels.

- [x] **Step 5: Run the full quality gates**

Run: `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm build`; `git diff --check`

Expected: all commands pass. The real Prometheus test may remain skipped if no endpoint is configured.

- [x] **Step 6: Update the Spec status and commit**

Record in the Spec that increment 2 is implemented and verified, while increments 3–6 remain pending. Run: `git add src docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md test; git commit -m "feat: complete profile impact guard increment"`

## Plan Self-Review

- Spec coverage: Profile snapshot and migration compatibility map to Tasks 1 and 4; impact capture, four Guardians, deterministic failure policy, and RiskPolicy map to Tasks 2 and 3; batch snapshot reuse and pre-ToolRunner enforcement map to Task 3; Profile-before-model and resume behavior map to Task 4.
- Explicit non-goals: Hooks observer separation, PolicyDenyHook, loop signatures/counters, L0/L1/L2 compression, and Prometheus/ELK data-plane internals remain outside this increment.
- Compatibility: legacy Guardian calls and direct Pipeline construction remain supported; governance is opt-in through the runtime composition option; persisted Profile snapshots are reused on resume.
- Failure handling: missing Profiles fail before model invocation; Guardian/impact failures do not become SAFE; missing or mismatched governance snapshots fail closed.
