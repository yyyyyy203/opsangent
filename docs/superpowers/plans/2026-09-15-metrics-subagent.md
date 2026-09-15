# Metrics Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Implement canonical metrics_subagent as a parent-visible evidence Tool whose restricted child AgentHarness queries the existing settlement Prometheus/MCP Tool and returns a deterministic, recoverable, auditable SourceSubagentResult for the three simulator scenarios.

**Architecture:** Reuse the implemented SourceSubagentRunner and Source Tool Adapter instead of creating another loop. Generalize their prompt/collector seams, standardize a safe SourceEvidenceObservation in ToolResponse metadata, and add a Metrics-specific collector that recalculates every number from the low-level Tool result. Bootstrap exposes only metrics_subagent to the parent and exactly metrics.settlement plus source_report to the child.

**Tech Stack:** TypeScript 5.9, Node.js 20, pnpm 11.19, Zod 3.25, Vitest 3.2, existing AgentHarness, OpenAI-compatible SDK adapter, MCP SDK, Prometheus lab, EvidenceStore, Event/Message V2 and LangSmith projector.

**Spec:** docs/superpowers/specs/2026-09-15-metrics-subagent-design.md

## Global Constraints

- Work in D:/agentops/.worktrees/event-message-v2 on codex/event-message-v2; inspect git status before every task and preserve unrelated changes.
- Parent Registry exposes only metrics_subagent; metrics.settlement and source_report remain child-only.
- Child execution uses the existing AgentHarness, ToolAdmission, ToolBatchExecutor and ToolExecutionPipeline.
- No model-provided URL, PromQL, selector, threshold, minimum sample, environment, credential or simulator scenario is accepted.
- failed/total, failureRate, status, threshold comparison, sample sufficiency, window validity and coverage are deterministic code.
- Low sample maps to the metric fact insufficient_data and a complete source investigation, not to breached, partial or unavailable.
- Raw Prometheus responses stay in EvidenceStore and never enter parent Context, Public SSE, Audit or LangSmith.
- New contract fields are additive; existing ToolResponse blocks, V1 events and V2 event names retain their meaning.
- Retry shares the parent deadline, Tool-call ledger and network-attempt ledger, and never resets them.
- Default tests may use ScriptedModel and local HTTP/SSE; they do not prove online model quality or group-buy-market production connectivity.
- Every implementation task starts with a failing focused test and ends with a focused test plus a small commit.

## File Map

| File | Change | Responsibility |
|---|---|---|
| src/contracts/source-subagent.ts | modify | Add SourceEvidenceObservation and optional source-specific request validation |
| src/application/source-evidence-observation.ts | create | Build and strictly parse safe observation metadata |
| src/application/source-report-collector.ts | modify | Consume observation metadata before legacy source JSON |
| src/application/source-subagent-runner.ts | modify | Inject source prompt renderer and request-aware Collector factory |
| src/tool/adapters/source-subagent-tool-adapter.ts | modify | Invoke the optional source-specific host request validator |
| src/bootstrap/source-report-tool.ts | create | Shared child-only source_report Tool |
| src/bootstrap/source-subagent-identity.ts | create | Shared deterministic childRunId |
| src/bootstrap/logs-subagent.ts | modify | Use shared report/identity helpers without behavior change |
| src/profiles/settlement.ts | modify | Define the Metrics lab Profile and canonical fact type |
| src/application/metrics-source-report-collector.ts | create | Recalculate facts and produce deterministic Metrics report |
| src/bootstrap/settlement-evidence-tool.ts | modify | Stable evidence identity and SourceEvidenceObservation metadata |
| src/bootstrap/metrics-subagent.ts | create | Compose the Metrics child Toolkit and canonical parent Tool |
| src/bootstrap/index.ts | modify | Export the new Metrics and shared bootstrap factories |
| test/source-subagent-contract.test.ts | modify | Additive contract and request-validator coverage |
| test/source-report-collector.test.ts | modify | Observation metadata and legacy compatibility coverage |
| test/source-subagent-runner.test.ts | modify | Prompt and Collector factory injection coverage |
| test/logs-subagent-runtime.test.ts | modify | Logs regression after shared helper extraction |
| test/metrics-source-report-collector.test.ts | create | Three facts, window rules and model-antihallucination coverage |
| test/settlement-mcp.test.ts | modify | Stable metric evidence and safe metadata coverage |
| test/metrics-subagent-runtime.test.ts | create | Parent/child visibility and three-scenario Harness closure |
| test/metrics-subagent-recovery.test.ts | create | Retry, resume, Abort, budget and idempotency coverage |
| test/metrics-subagent-openai-compatible.test.ts | create | Local real SDK/SSE parent-child Tool loop |
| test/real-prometheus.test.ts | modify | Optional real Prometheus path through metrics_subagent |
| docs/implementation-status.md | modify | Record verified scope and non-claims |
| docs/architecture/05-subagents-and-mcp.md | modify | Record concrete Metrics source composition |
| docs/architecture/08-observability.md | modify | Record metrics parent/child spans and redaction |
| docs/architecture/14-settlement-mcp-evidence.md | modify | Replace direct-Tool-only status with Subagent status |

---

### Task 1: Add the safe source-evidence observation protocol

**Files:**

- Modify: src/contracts/source-subagent.ts
- Create: src/application/source-evidence-observation.ts
- Modify: src/application/source-report-collector.ts
- Modify: test/source-subagent-contract.test.ts
- Modify: test/source-report-collector.test.ts

**Interfaces:**

- Consumes: existing SourceSubagentType, SourceSubagentRequest, SourceSubagentExecution, ToolResponse and DefaultSourceReportCollector.
- Produces: SourceEvidenceObservation, SourceSubagentDescriptor.validateRequest, SourceReportFinalizeInput, attachSourceEvidenceObservation and readSourceEvidenceObservation.

- [ ] **Step 1: Write the failing contract tests.**

Add a compile-time object assertion for:

~~~ts
const observation = {
  schemaVersion: 1,
  source: 'metrics',
  evidenceId: 'metric-evidence-1',
  state: 'committed',
  coverage: 1,
  timeRange: {
    start: '2026-09-15T00:00:00.000Z',
    end: '2026-09-15T00:05:00.000Z',
  },
  missingEvidence: [],
} satisfies SourceEvidenceObservation;
~~~

Extend the descriptor fixture with:

~~~ts
validateRequest: (request, execution) => {
  expect(request.profileId).toBe(execution.profileId);
}
~~~

Assert existing descriptors without validateRequest still typecheck and canonical names remain unchanged.

- [ ] **Step 2: Write the failing Collector tests.**

Cover all of these exact cases:

- response.evidenceIds plus metadata.sourceEvidence produces coverage/state/missingEvidence;
- observation evidenceId absent from response.evidenceIds throws MCP_PROTOCOL_ERROR;
- malformed schemaVersion, source, state, coverage or timeRange throws MCP_PROTOCOL_ERROR;
- sourceEvidence containing raw, url, promql, storageKey or headers is rejected by strict key validation;
- existing logs.capture JSON with top-level status/evidenceId/coverage still produces the same result.

Use this response shape:

~~~ts
const response: ToolResponse = {
  blocks: [{ type: 'json', value: { status: 'breached', total: 100, failed: 15 } }],
  evidenceIds: ['metric-evidence-1'],
  metadata: { sourceEvidence: observation },
};
~~~

- [ ] **Step 3: Run the focused tests and verify the missing exports/behavior fail.**

Run:

~~~text
pnpm exec vitest run test/source-subagent-contract.test.ts test/source-report-collector.test.ts
~~~

Expected: FAIL because SourceEvidenceObservation and its parser do not exist and the Collector ignores metadata.sourceEvidence.

- [ ] **Step 4: Add the additive contracts.**

Add to src/contracts/source-subagent.ts:

~~~ts
export interface SourceEvidenceObservation {
  schemaVersion: 1;
  source: SourceSubagentType;
  evidenceId: string;
  state: 'committed' | 'partial';
  coverage: number;
  timeRange?: { start: string; end: string };
  missingEvidence: string[];
}

~~~

Add this optional field to SourceSubagentDescriptor:

~~~ts
validateRequest?: (
  request: SourceSubagentRequest,
  execution: Omit<SourceSubagentExecution, 'childRunId'>,
) => void | Promise<void>;
~~~

Do not change existing required descriptor fields.

In src/application/source-report-collector.ts, name the existing inline finalize input:

~~~ts
export interface SourceReportFinalizeInput {
  source: SourceSubagentType;
  startedAt: number;
  finishedAt: number;
  parentRunId: string;
  childRunId: string;
}
~~~

Change SourceReportCollector.finalize to consume this interface without changing its fields or behavior.

- [ ] **Step 5: Implement the observation helper.**

Create src/application/source-evidence-observation.ts with:

~~~ts
export const SOURCE_EVIDENCE_METADATA_KEY = 'sourceEvidence';

export function attachSourceEvidenceObservation(
  response: ToolResponse,
  observation: SourceEvidenceObservation,
): ToolResponse;

export function readSourceEvidenceObservation(
  response: ToolResponse,
): SourceEvidenceObservation | undefined;

export class SourceEvidenceObservationError extends Error {
  public readonly code = 'MCP_PROTOCOL_ERROR';
  public readonly retryable = false;
}
~~~

Implementation rules:

- accept only the keys schemaVersion/source/evidenceId/state/coverage/timeRange/missingEvidence;
- require schemaVersion=1, coverage in [0,1], bounded non-empty IDs and at most 20 missing items;
- require ISO start/end and start < end when timeRange exists;
- require observation.evidenceId in response.evidenceIds and an evidence_ref block;
- clone metadata instead of mutating the caller response;
- reject unsafe extra keys rather than deleting them.

- [ ] **Step 6: Update DefaultSourceReportCollector.**

At the start of observeToolResult:

1. increment toolCallsUsed exactly once;
2. return for isError=true;
3. read metadata.sourceEvidence;
4. when present, record its evidence/state/coverage/missingEvidence and skip legacy control parsing;
5. when absent, retain the current top-level JSON compatibility path.

Do not parse metric status such as healthy/breached as evidence commit state.

- [ ] **Step 7: Run focused tests and verify they pass.**

Run:

~~~text
pnpm exec vitest run test/source-subagent-contract.test.ts test/source-report-collector.test.ts
~~~

Expected: PASS.

- [ ] **Step 8: Run typecheck and commit.**

Run:

~~~text
pnpm typecheck
git diff --check
~~~

Commit:

~~~text
git add src/contracts/source-subagent.ts src/application/source-evidence-observation.ts src/application/source-report-collector.ts test/source-subagent-contract.test.ts test/source-report-collector.test.ts
git commit -m "feat: add source evidence observation contract"
~~~

### Task 2: Generalize Source Runner and share bootstrap primitives

**Files:**

- Modify: src/application/source-subagent-runner.ts
- Modify: src/tool/adapters/source-subagent-tool-adapter.ts
- Create: src/bootstrap/source-report-tool.ts
- Create: src/bootstrap/source-subagent-identity.ts
- Modify: src/bootstrap/logs-subagent.ts
- Modify: src/bootstrap/index.ts
- Modify: test/source-subagent-runner.test.ts
- Modify: test/logs-subagent-runtime.test.ts

**Interfaces:**

- Consumes: SourceSubagentRequest, SourceSubagentExecution, SourceReportCollector and existing source_report schema.
- Produces: SourcePromptRenderer, SourceReportCollectorFactory, createSourceReportTool and stableSourceChildRunId.

- [ ] **Step 1: Write failing Runner seam tests.**

Add a Runner fixture with:

~~~ts
renderPrompt: (request, execution) =>
  'source=metrics\nprofile=' + execution.profileId + '\nquestion=' + request.question,
collector: ({ request, execution }) => {
  expect(request.service).toBe('checkout');
  expect(execution.childRunId).toBe('child-1');
  return collector;
},
~~~

Capture replyStream.options.message and assert it begins source=metrics and contains no “日志取证”.
Also construct a Runner without renderPrompt and assert its neutral default names options.source.
Add a Collector that throws { code: 'MCP_PROTOCOL_ERROR', retryable: false } from
observeToolResult and assert the Runner preserves that code instead of wrapping it as MCP_SERVER_ERROR.

- [ ] **Step 2: Write failing shared-helper regression tests.**

In test/logs-subagent-runtime.test.ts assert:

- logs_subagent child Tool list remains unchanged;
- source_report remains strict and returns accepted=true;
- stableSourceChildRunId('logs', parentRunId, toolCallId) exactly equals the pre-refactor logs childRunId;
- two sources with the same parent IDs produce different childRunIds.

- [ ] **Step 3: Run focused tests and verify they fail.**

Run:

~~~text
pnpm exec vitest run test/source-subagent-runner.test.ts test/logs-subagent-runtime.test.ts
~~~

Expected: FAIL because Runner injection and shared bootstrap helpers do not exist.

- [ ] **Step 4: Add Runner extension types and use them.**

In src/application/source-subagent-runner.ts define:

~~~ts
export type SourcePromptRenderer = (
  request: SourceSubagentRequest,
  execution: SourceSubagentExecution,
) => string;

export type SourceReportCollectorFactory = (input: {
  request: SourceSubagentRequest;
  execution: SourceSubagentExecution;
}) => SourceReportCollector;
~~~

Change SourceSubagentRunnerOptions to:

~~~ts
export interface SourceSubagentRunnerOptions {
  source: SourceSubagentType;
  childAgentFactory: SourceChildAgentFactory;
  childTools: SourceChildToolsFactory;
  checkpoints?: CheckpointStore;
  clock?: Clock;
  collector?: SourceReportCollectorFactory;
  renderPrompt?: SourcePromptRenderer;
}
~~~

Call the factory with request/execution and render the prompt with the injected renderer. The default prompt must say “只读 <source> 来源取证 Subagent” and retain the current bounded, stable field ordering.
When Collector or observation validation throws a structured code/retryable error, convert it to
SourceSubagentFailure with the same code and retryability. Only unclassified child failures use
MCP_SERVER_ERROR.

- [ ] **Step 5: Extract createSourceReportTool.**

Create src/bootstrap/source-report-tool.ts. Move the existing strict schema and function without changing behavior:

~~~ts
export function createSourceReportTool(
  collector: SourceReportCollector,
): Tool;
~~~

The Tool remains:

- name=source_report;
- kind=utility;
- source=builtin;
- recoveryPolicy=replay_safe;
- isConcurrencySafe=false;
- strict input fields summary/findings/businessTraceIds/missingEvidence.

- [ ] **Step 6: Extract stableSourceChildRunId.**

Create src/bootstrap/source-subagent-identity.ts:

~~~ts
export function stableSourceChildRunId(
  source: SourceSubagentType,
  parentRunId: string,
  parentToolCallId: string,
): string;
~~~

Use SHA-256 over source, a NUL separator, parentRunId, a NUL separator and parentToolCallId;
keep 32 hex characters and prefix source-child-<source>-.

- [ ] **Step 7: Update logs_subagent to use the shared helpers.**

Remove its local source_report schema/function and local stableChildRunId. Import the two shared helpers.
Pass an explicit logs prompt renderer so no existing Logs behavior depends on the neutral default.
Do not alter Logs child Tool order, result schema, retry policy or evidence validation.

- [ ] **Step 8: Invoke descriptor.validateRequest in the Source Tool Adapter.**

In src/tool/adapters/source-subagent-tool-adapter.ts call:

~~~ts
await descriptor.validateRequest?.(request, executionBase);
~~~

Place it after createExecutionBase and before childRunId creation, validateEvidenceIds, lifecycle events, model calls or source calls. Preserve existing error code/retryable fields through the current error helpers.

- [ ] **Step 9: Run focused tests and verify they pass.**

Run:

~~~text
pnpm exec vitest run test/source-subagent-runner.test.ts test/source-subagent-tool.test.ts test/logs-subagent-runtime.test.ts
~~~

Expected: PASS with unchanged logs child identity and Tool list.

- [ ] **Step 10: Run typecheck and commit.**

Run:

~~~text
pnpm typecheck
git diff --check
~~~

Commit:

~~~text
git add src/application/source-subagent-runner.ts src/tool/adapters/source-subagent-tool-adapter.ts src/bootstrap/source-report-tool.ts src/bootstrap/source-subagent-identity.ts src/bootstrap/logs-subagent.ts src/bootstrap/index.ts test/source-subagent-runner.test.ts test/source-subagent-tool.test.ts test/logs-subagent-runtime.test.ts
git commit -m "refactor: share source subagent composition seams"
~~~

### Task 3: Implement the Metrics Profile and deterministic report collector

**Files:**

- Modify: src/profiles/settlement.ts
- Create: src/application/metrics-source-report-collector.ts
- Create: test/metrics-source-report-collector.test.ts

**Interfaces:**

- Consumes: assessSettlementMetrics, SourceSubagentRequest, SourceReportCandidate, SourceReportCollector and ToolResponse.
- Produces: SettlementMetricsProfile, settlementMetricsLabProfile, SettlementMetricFact and MetricsSourceReportCollector.

- [ ] **Step 1: Write failing three-scenario tests.**

Use the exact cases:

~~~ts
[
  { total: 100, failed: 0, expected: 'healthy', sourceStatus: 'complete' },
  { total: 100, failed: 15, expected: 'breached', sourceStatus: 'complete' },
  { total: 10, failed: 8, expected: 'insufficient_data', sourceStatus: 'complete' },
]
~~~

For each case:

1. observe one metrics.settlement response with a valid JSON fact, evidence_ref and sourceEvidence metadata;
2. submit source_report citing that ID;
3. finalize;
4. assert one deterministic observation finding, evidence ID, coverage=1 and businessTraceIds=[];
5. assert the summary contains exact counts and a two-decimal percentage;
6. assert low_sample does not contain a breached conclusion.

- [ ] **Step 2: Write failing adversarial and state tests.**

Cover:

- candidate summary says 1% and “MySQL is root cause”; final output still says 15.00% and contains no MySQL claim;
- threshold or minSamples in the Tool JSON differs from Profile; throw MCP_PROTOCOL_ERROR;
- failureRate differs from failed/total; throw MCP_PROTOCOL_ERROR;
- Tool status differs from assessSettlementMetrics recomputation; throw MCP_PROTOCOL_ERROR;
- report omits source_report after evidence; return partial;
- no evidence; return unavailable;
- two different metric evidence IDs; return partial with multiple_metric_snapshots;
- actual window outside the request tolerance; return partial with deterministic coverage;
- unknown cited evidence ID; throw POLICY_DENIED.

- [ ] **Step 3: Run the new test and verify it fails.**

Run:

~~~text
pnpm exec vitest run test/metrics-source-report-collector.test.ts
~~~

Expected: FAIL because the Metrics Profile and collector do not exist.

- [ ] **Step 4: Extend the settlement Profile.**

Add:

~~~ts
export interface SettlementMetricsProfile extends SettlementRule {
  profileId: string;
  service: 'checkout';
  environment: 'simulation';
  windowSeconds: 300;
  maxWindowSkewSeconds: 120;
  maxFutureSkewSeconds: 30;
}

export const settlementMetricsLabProfile: Readonly<SettlementMetricsProfile> =
  Object.freeze({
    profileId: 'simulation',
    service: 'checkout',
    environment: 'simulation',
    windowSeconds: 300,
    maxWindowSkewSeconds: 120,
    maxFutureSkewSeconds: 30,
    threshold: 0.05,
    minSamples: 20,
  });

export interface SettlementMetricFact {
  status: 'healthy' | 'breached' | 'insufficient_data';
  total: number;
  failed: number;
  failureRate: number | null;
  threshold: number;
  minSamples: number;
  service: 'checkout';
  environment: 'simulation';
  start: number;
  end: number;
}
~~~

Keep settlementLabRule exported and derive its values from settlementMetricsLabProfile so existing callers remain compatible.

- [ ] **Step 5: Implement MetricsSourceReportCollector.**

Expose:

~~~ts
export interface MetricsSourceReportCollectorOptions {
  request: SourceSubagentRequest;
  profile: SettlementMetricsProfile;
}

export class MetricsSourceReportCollector implements SourceReportCollector {
  public constructor(options: MetricsSourceReportCollectorOptions);
  public observeToolResult(toolName: string, response: ToolResponse): void;
  public acceptReport(candidate: SourceReportCandidate): void;
  public finalize(input: SourceReportFinalizeInput): SourceSubagentResult;
}
~~~

Implementation:

- delegate evidence/reference bounds to DefaultSourceReportCollector;
- parse facts only from toolName=metrics.settlement;
- recompute assessSettlementMetrics and compare every deterministic field;
- require exactly one evidence ID and paired sourceEvidence;
- mark reportAccepted only after the delegate validates all citations;
- ignore candidate numeric/root-cause prose in final output;
- construct final summary/finding from the templates in Spec §9.3;
- keep businessTraceIds empty;
- derive source-local missingEvidence only from protocol/window/report state;
- treat insufficient_data as complete when report/window/evidence are valid.

- [ ] **Step 6: Run focused tests and verify they pass.**

Run:

~~~text
pnpm exec vitest run test/metrics-source-report-collector.test.ts test/source-report-collector.test.ts
~~~

Expected: PASS.

- [ ] **Step 7: Run lint/typecheck and commit.**

Run:

~~~text
pnpm lint
pnpm typecheck
git diff --check
~~~

Commit:

~~~text
git add src/profiles/settlement.ts src/application/metrics-source-report-collector.ts test/metrics-source-report-collector.test.ts
git commit -m "feat: add deterministic metrics source report"
~~~

### Task 4: Make settlement evidence recoverable and observable by the Source Collector

**Files:**

- Modify: src/bootstrap/settlement-evidence-tool.ts
- Modify: test/settlement-mcp.test.ts
- Create: test/settlement-evidence-recovery.test.ts

**Interfaces:**

- Consumes: attachSourceEvidenceObservation, EvidenceRecorder, ToolCallOptions, SettlementMetricFact.
- Produces: stable metric evidence identity and metadata.sourceEvidence on successful settlement responses.

- [ ] **Step 1: Write failing metadata tests.**

In test/settlement-mcp.test.ts assert a successful response has:

~~~ts
expect(response.metadata).toEqual({
  sourceEvidence: {
    schemaVersion: 1,
    source: 'metrics',
    evidenceId: 'evidence-1',
    state: 'committed',
    coverage: 1,
    timeRange: {
      start: '1970-01-01T00:11:40.000Z',
      end: '1970-01-01T00:16:40.000Z',
    },
    missingEvidence: [],
  },
});
~~~

Also assert JSON.stringify(response.metadata) excludes the raw marker, URL, query and credential fields.
Unavailable responses must have no sourceEvidence and no evidenceId.

- [ ] **Step 2: Write the failing stable-recovery test.**

Call the same bound metrics.settlement Tool twice with identical runId/toolCallId against one
InMemoryEvidenceStore and no injected id. Assert:

- both responses return the same evidenceId;
- the source record remains readable once by that ID;
- captureKey is metric:<runId>:<toolCallId>:0;
- changing raw content for the same identity fails with STORAGE_ERROR instead of overwriting.

- [ ] **Step 3: Run focused tests and verify they fail.**

Run:

~~~text
pnpm exec vitest run test/settlement-mcp.test.ts test/settlement-evidence-recovery.test.ts
~~~

Expected: FAIL because the default ID is random and metadata.sourceEvidence is absent.

- [ ] **Step 4: Implement stable default evidence IDs.**

Retain the existing id?: () => string test hook. When it is omitted, derive:

~~~ts
function stableMetricEvidenceId(runId: string, toolCallId: string): string {
  const digest = createHash('sha256')
    .update(runId + '\u0000' + toolCallId)
    .digest('hex')
    .slice(0, 32);
  return 'metric-evidence-' + digest;
}
~~~

Require toolCallId before deriving the ID. Keep the existing stable captureKey. Do not mark the Tool
replay_safe; ambiguous crash recovery remains verify-before-retry.

- [ ] **Step 5: Attach the safe observation after durable capture.**

Only after recorder.capture returns successfully, call attachSourceEvidenceObservation with:

~~~ts
{
  schemaVersion: 1,
  source: 'metrics',
  evidenceId,
  state: 'committed',
  coverage: 1,
  timeRange: {
    start: new Date(result.start * 1000).toISOString(),
    end: new Date(result.end * 1000).toISOString(),
  },
  missingEvidence: [],
}
~~~

Keep the first JSON summary and evidence_ref order unchanged. Keep legacy missingEvidence=['logs','traces']
in the first JSON for direct low-level callers; MetricsSourceReportCollector must not use it as source-local
coverage.

- [ ] **Step 6: Run focused tests and verify they pass.**

Run:

~~~text
pnpm exec vitest run test/settlement-mcp.test.ts test/settlement-evidence-recovery.test.ts
~~~

Expected: PASS.

- [ ] **Step 7: Run lint/typecheck and commit.**

Run:

~~~text
pnpm lint
pnpm typecheck
git diff --check
~~~

Commit:

~~~text
git add src/bootstrap/settlement-evidence-tool.ts test/settlement-mcp.test.ts test/settlement-evidence-recovery.test.ts
git commit -m "feat: make settlement evidence source-aware"
~~~

### Task 5: Compose canonical metrics_subagent and prove the complete child Harness loop

**Files:**

- Create: src/bootstrap/metrics-subagent.ts
- Modify: src/bootstrap/index.ts
- Create: test/metrics-subagent-runtime.test.ts
- Create: test/metrics-subagent-recovery.test.ts
- Create: test/metrics-subagent-openai-compatible.test.ts

**Interfaces:**

- Consumes: DefaultSourceSubagentRunner, MetricsSourceReportCollector, createSourceReportTool, stableSourceChildRunId, pre-bound metrics.settlement Tool, SourceChildAgentFactory and settlement Metrics Profile.
- Produces: metricsSubagentInputSchema, MetricsSubagentOptions and createMetricsSubagentTool.

- [ ] **Step 1: Write failing parent/child composition tests.**

Create test/metrics-subagent-runtime.test.ts. Use a SourceChildAgentFactory that builds an actual
createAgentRuntime with ScriptedModel and input.tools. Assert:

~~~ts
expect(parent.toolkit.get('metrics_subagent')).toBe(metricsTool);
expect(parent.toolkit.get('metrics.settlement')).toBeUndefined();
expect(childTools.map((tool) => tool.name)).toEqual([
  'metrics.settlement',
  'source_report',
]);
~~~

Drive the parent through metrics_subagent for normal, settlement_failure and low_sample. Inspect the
parent Checkpoint ToolResult and assert the deterministic outcomes from Spec §9.3.

- [ ] **Step 2: Add failing scope tests to the same file.**

Assert wrong profile, service other than checkout, non-300-second window, stale/future end, unknown field
and non-empty evidenceIds all fail before childFactory.create. Assert the low-level Tool is also validated
at construction: wrong name, action kind, missing call or non-MCP source throws.

- [ ] **Step 3: Write failing recovery tests.**

Create test/metrics-subagent-recovery.test.ts covering:

- same parentRunId/toolCallId creates the same source-child-metrics ID on retry;
- a child Checkpoint causes resumeStream, not replyStream;
- a completed child ToolResult prevents a second metrics source call;
- transient timeout emits STARTED -> RETRY_SCHEDULED -> COMPLETED once;
- evidence followed by report/model failure returns partial with the evidence ID;
- source failure before evidence returns unavailable/UNAVAILABLE;
- ABORTED, INVALID_INPUT, POLICY_DENIED and BUDGET_EXCEEDED do not retry;
- fewer than two remaining Tool calls prevents child creation;
- networkAttemptBudget is the same object received by the child.

- [ ] **Step 4: Write the failing OpenAI-compatible nested-loop test.**

Create a loopback HTTP server in test/metrics-subagent-openai-compatible.test.ts. Inspect each request body:

- requests whose tool list contains metrics_subagent receive a tool_call for metrics_subagent, then parent final text;
- requests whose tool list contains metrics.settlement and source_report receive a metrics.settlement call,
  then a source_report call citing the returned evidence ID, then child final text.

Return valid SSE chunks ending in [DONE]. Build both parent and child models with
createOpenAICompatibleModel and apiKey=test-api-key. Assert:

- both actual SDK clients made requests;
- parent -> metrics_subagent -> child -> metrics.settlement -> source_report -> parent completed;
- the parent ToolResult contains deterministic facts;
- no request body contains raw-only-marker;
- server-observed child tool names are exactly the two allowed names.

- [ ] **Step 5: Run all new tests and verify missing-module failures.**

Run:

~~~text
pnpm exec vitest run test/metrics-subagent-runtime.test.ts test/metrics-subagent-recovery.test.ts test/metrics-subagent-openai-compatible.test.ts
~~~

Expected: FAIL because createMetricsSubagentTool does not exist.

- [ ] **Step 6: Implement the strict input schema and Metrics errors.**

In src/bootstrap/metrics-subagent.ts define:

~~~ts
export const metricsSubagentInputSchema = z.object({
  profileId: z.string().min(1),
  service: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  question: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).max(20).optional(),
}).strict();

export interface MetricsSubagentOptions {
  profile: SettlementMetricsProfile;
  settlementTool: Tool;
  childAgentFactory: SourceChildAgentFactory;
  checkpoints?: CheckpointStore;
  clock?: Clock;
  lifecycle?: SubagentLifecyclePorts;
  maxAttempts?: number;
}
~~~

Use errors carrying exact code/retryable fields:

- malformed date/window/question -> INVALID_INPUT, false;
- configured profile/service mismatch or non-empty evidenceIds -> POLICY_DENIED, false;
- invalid settlement Tool composition -> throw synchronously during bootstrap.

- [ ] **Step 7: Implement createMetricsSubagentTool.**

Build childTools per invocation:

~~~ts
const childTools: SourceChildToolsFactory = {
  create: ({ collector }) => Object.freeze([
    options.settlementTool,
    createSourceReportTool(collector),
  ]),
};
~~~

Construct DefaultSourceSubagentRunner with:

- source=metrics;
- request-aware MetricsSourceReportCollector;
- Metrics prompt renderer;
- inherited Checkpoint/Clock;
- the injected SourceChildAgentFactory.

Construct SourceSubagentDescriptor with:

~~~ts
{
  publicToolName: 'metrics_subagent',
  subagentType: 'metrics',
  childRunId: (execution) => stableSourceChildRunId(
    'metrics',
    execution.parentRunId,
    execution.parentToolCallId,
  ),
  validateRequest: metricsRequestValidator,
}
~~~

The validator checks the exact Profile/window/question rules from Spec §6 before child creation.

- [ ] **Step 8: Implement the Metrics prompt renderer.**

Use a fixed prefix and fixed dynamic field order:

~~~text
你是只读 Metrics 取证 Subagent。
只能调用 metrics.settlement 和 source_report。
失败率、阈值、样本充分性由工具结果决定；不要自行计算或猜测根因。
低样本必须视为 insufficient_data。
profileId=<bounded>
service=<bounded>
start=<bounded>
end=<bounded>
question=<bounded>
最后调用 source_report，并只引用本次实际观察到的 evidenceId。
~~~

Use a UTF-8 byte bound before rendering and do not include raw evidence or credentials.

- [ ] **Step 9: Run the three new test files and verify they pass.**

Run:

~~~text
pnpm exec vitest run test/metrics-subagent-runtime.test.ts test/metrics-subagent-recovery.test.ts test/metrics-subagent-openai-compatible.test.ts
~~~

Expected: PASS.

- [ ] **Step 10: Run the existing Source/Logs/OpenAI regression set.**

Run:

~~~text
pnpm exec vitest run test/source-subagent-contract.test.ts test/source-subagent-tool.test.ts test/source-subagent-runner.test.ts test/source-subagent-recovery.test.ts test/source-subagent-budget.test.ts test/logs-subagent-runtime.test.ts test/openai-compatible-runtime.test.ts
~~~

Expected: PASS.

- [ ] **Step 11: Commit the Metrics Subagent composition.**

Run:

~~~text
pnpm lint
pnpm typecheck
git diff --check
~~~

Commit:

~~~text
git add src/bootstrap/metrics-subagent.ts src/bootstrap/index.ts test/metrics-subagent-runtime.test.ts test/metrics-subagent-recovery.test.ts test/metrics-subagent-openai-compatible.test.ts
git commit -m "feat: compose metrics source subagent"
~~~

### Task 6: Extend real Prometheus acceptance and close documentation

**Files:**

- Modify: test/real-prometheus.test.ts
- Modify: docs/implementation-status.md
- Modify: docs/architecture/05-subagents-and-mcp.md
- Modify: docs/architecture/08-observability.md
- Modify: docs/architecture/14-settlement-mcp-evidence.md

**Interfaces:**

- Consumes: complete createMetricsSubagentTool composition and existing opt-in Metrics Lab.
- Produces: real-backend acceptance path, final architecture/status record and quality-gate evidence.

- [ ] **Step 1: Extend the opt-in real Prometheus test.**

For each existing simulator case:

1. keep the real Prometheus scrape readiness loop;
2. bind metrics.settlement through the actual MCP HTTP connection;
3. create a ScriptedModel child that calls metrics.settlement, then source_report;
4. create parent runtime with only metrics_subagent;
5. assert SourceSubagentResult fact/status/evidence for that scenario;
6. load EvidenceStore by returned evidenceId and assert source=metric;
7. assert serialized parent Context, public events and lifecycle payloads exclude raw Prometheus data.

Keep describe.skipIf(process.env.AGENTOPS_REAL_PROMETHEUS !== '1') and the current 50-second timeout.

- [ ] **Step 2: Run the default version and verify the opt-in suite is skipped.**

Run:

~~~text
pnpm exec vitest run test/real-prometheus.test.ts
~~~

Expected: one skipped test when AGENTOPS_REAL_PROMETHEUS is not 1.

- [ ] **Step 3: Run real Prometheus only when Docker backend is available.**

Run:

~~~powershell
pnpm lab:backend:up
$env:AGENTOPS_REAL_PROMETHEUS = '1'
pnpm exec vitest run test/real-prometheus.test.ts
Remove-Item Env:AGENTOPS_REAL_PROMETHEUS
pnpm lab:backend:stop
~~~

Expected when executed: all three simulator scenarios pass through real Prometheus, MCP and
metrics_subagent. If Docker is unavailable, record the skipped verification and do not claim real-backend
acceptance.

- [ ] **Step 4: Update implementation and architecture documentation.**

Record exact implemented files and verification counts. State all of the following explicitly:

- Metrics Subagent is implemented over the simulation checkout Profile;
- parent/child Tool isolation and deterministic three-scenario reporting are verified;
- OpenAI-compatible local protocol is verified;
- real Prometheus is only verified if the opt-in command actually ran;
- group-buy-market Prometheus, online model quality, Run/Evidence API, frontend, ELK/Trace and actions remain outside this increment;
- no new Event/Message type was introduced.

- [ ] **Step 5: Run the complete quality gate.**

Run one command at a time:

~~~text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
~~~

Expected: lint/typecheck/build exit 0; all default tests pass; only the explicit real Prometheus test may be skipped.

- [ ] **Step 6: Review implementation against every Spec section.**

Verify:

- each completion item in Spec §18 has a test or a documented opt-in boundary;
- parent has no metrics.settlement;
- child has no forbidden Tool;
- low_sample is complete+insufficient_data;
- model prose cannot alter the final facts;
- raw marker is absent from parent/public/audit/LangSmith fixtures;
- no file contains a real API key, internal Prometheus address or company credential.

Search src, docs and test for credential-like names, authorization headers, internal URLs and
raw-only-marker. Review every match; test-only markers and documented non-secret names are allowed,
real secret values are not.

- [ ] **Step 7: Commit the acceptance and documentation increment.**

Commit:

~~~text
git add test/real-prometheus.test.ts docs/implementation-status.md docs/architecture/05-subagents-and-mcp.md docs/architecture/08-observability.md docs/architecture/14-settlement-mcp-evidence.md
git commit -m "docs: record metrics subagent acceptance"
~~~

## Completion Checklist

- [ ] Source observation protocol is strict, bounded and backward compatible.
- [ ] Source Runner no longer contains a Logs-only default prompt.
- [ ] Logs behavior remains unchanged after shared helper extraction.
- [ ] Metrics Profile owns service/window/threshold/sample rules.
- [ ] Metrics Collector recalculates all facts and ignores contradictory model prose.
- [ ] Settlement evidence uses stable IDs and safe observation metadata.
- [ ] Parent exposes only metrics_subagent.
- [ ] Child exposes exactly metrics.settlement and source_report.
- [ ] Three simulator scenarios pass through parent and child Harnesses.
- [ ] Retry, resume, partial, unavailable, Abort and budgets are covered.
- [ ] Local OpenAI-compatible SDK/SSE loop passes.
- [ ] Real Prometheus result is recorded only if the opt-in test actually ran.
- [ ] Event/Message V2 remains additive and raw data is absent from all outward projections.
- [ ] lint, typecheck, test, build and diff check pass.
