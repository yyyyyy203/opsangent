# Agent Web Metrics Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本地 Agent Web 通过 Metrics Subagent 查询真实运行的 Prometheus 服务，并把模拟器指标形成可回查、可恢复、可降级的父子 Run 证据闭环。

**Architecture:** 在现有 AgentHarness 之上增加共享运行时事件/存储端口；父级只注册 `metrics_subagent`，child 只注册 `metrics.settlement` 和 `source_report`。MCP 连接采用固定 manifest 的延迟绑定，Prometheus/模拟器仍由 Metrics Lab 负责，Web 宿主只组装和关闭资源。

**Tech Stack:** TypeScript、Node.js 20、pnpm、SQLite、Vitest、Playwright、现有 MCP SDK、现有 Prometheus 模拟器与 OpenAI-compatible ChatModel。

**Spec:** `docs/superpowers/specs/2026-10-01-agent-web-metrics-integration-design.md`

## Global Constraints

- 本增量只验证“模拟器产数 → 真实 Prometheus → MCP → Metrics Subagent → Agent Web”，不修改 `D:\xfg\group-buy-market`。
- `group-buy-market` 不能消费 `simulation` Profile；业务指标名、PromQL、标签和统计方法另立规格。
- 不新增 Event/Message V2、ToolResponse、SourceSubagentResult 的破坏性字段；新增端口必须是内部或可选兼容扩展。
- Parent Toolkit 只有 `metrics_subagent`；child Toolkit 精确包含 `metrics.settlement` 和 `source_report`，不得包含 Bash、任意 HTTP、动作或其他 Subagent。
- AgentHarness、Guard、Hook、HITL 和四轮降级职责不重写；数据源失败必须产生 `unavailable`/`missingEvidence`，不得伪造健康结论。
- Prometheus 原始响应只进入 EvidenceStore；Public SSE、Web DTO、Audit、LangSmith 和模型上下文只接触有界摘要及 evidenceId。
- MCP URL、PromQL、阈值、窗口和认证信息由宿主/Profile 注入，不由浏览器或模型自由构造。
- CLI 只有在显式配置 `AGENTOPS_WEB_PROFILE=simulation` 与 `AGENTOPS_METRICS_MCP_URL` 后才开放实验指标 Profile；直接注入模型和工具的旧测试保持兼容。
- 所有时间、ID、重试、关闭和外部调用边界可注入；不使用 `process.cwd()` 推断数据路径。
- 每个任务先写失败测试、验证失败、最小实现、验证通过，再提交一个独立 commit；不自动 push。
- 最终至少运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build`、`pnpm e2e`；真实 Prometheus 测试保持显式 opt-in。

---

## Task 1: Shared runtime data-plane ports for child Runs

**Files:**
- Create: `src/application/runtime-ports.ts`
- Modify: `src/application/create-runtime.ts`
- Modify: `src/contracts/event-store.ts` only if an existing store intersection cannot be reused
- Test: `test/shared-runtime-child.test.ts`
- Test: `test/runtime-events-v2.test.ts` (add shared-port regression only)

**Interfaces:**
- Consumes existing `EventPublisherV2Dependencies`, `EventStore & MessageStore`, `CheckpointStore`, `EvidenceStore`, and `EvidenceRecorder`.
- Produces `SharedRuntimeEventPorts`, `RuntimeToolPorts.evidence`, `RuntimeToolPorts.sharedEvents`, and `RuntimeToolPorts.registerShutdownHook`.
- `createAgentRuntime({ sharedEvents })` must make the child Harness publish through the parent’s V2 publisher/factory/correlation path while reusing the parent event store.

```ts
export interface SharedRuntimeEventPorts {
  store: EventStore & MessageStore;
  events: EventPublisherV2Dependencies;
}

export interface RuntimeShutdownRegistry {
  register(callback: () => void | Promise<void>): void;
}
```

- [ ] **Step 1: Write failing tests**

Add a parent runtime with SQLite persistence and a child runtime created with the new shared event ports. The child must emit a `SUBAGENT_STARTED`-style V2 event into the same store, and the parent’s `eventStreamV2.open({ runId })`/query path must read it. Assert the child Toolkit remains isolated and the parent Toolkit does not gain the child Tool.

```ts
expect(parentEventStore === childEventStore).toBe(true);
expect(parent.toolkit.get('metrics.settlement')).toBeUndefined();
expect(child.toolkit.get('metrics.settlement')).toBeDefined();
expect(await parent.eventStoreV2.readRun(childRunId, 0, 20)).toHaveLength(1);
```

Run: `pnpm exec vitest run test/shared-runtime-child.test.ts`

Expected: FAIL because the shared port and child composition do not exist.

- [ ] **Step 2: Add the narrow shared-port types**

Put the types in `src/application/runtime-ports.ts`; keep concrete SQLite, MCP, and HTTP types out of `src/contracts`. Extend `RuntimeToolPorts` with:

```ts
evidence: EvidenceStore;
evidenceRecorder: EvidenceRecorder;
sharedEvents: SharedRuntimeEventPorts;
registerShutdownHook(callback: () => void | Promise<void>): void;
```

Do not expose a mutable global registry. The registry belongs to one `createAgentRuntime()` call.

- [ ] **Step 3: Make `createAgentRuntime` consume shared V2 dependencies**

Add an optional `sharedEvents?: SharedRuntimeEventPorts` option. When it is present:

1. Reuse `sharedEvents.store` and `sharedEvents.events` for the AgentHarness, EventedChatModel, EvidenceRecorder event channel, and lifecycle Tools.
2. Skip creation of a second durable outbox dispatcher and skip registering duplicate V1, audit, LangSmith, and message-assembler projectors.
3. Keep the returned runtime shape source-compatible; local child-only `replayV2`/query helpers may exist but must not own or close the shared stores.
4. Pass the runtime-owned `evidence`, `evidenceRecorder`, `sharedEvents`, and shutdown registry to every `toolFactory`.
5. Run registered shutdown hooks before closing any persistence owned by this runtime.

The parent path must retain its current publisher/projector setup and startup replay behavior.

- [ ] **Step 4: Run focused tests**

Run: `pnpm exec vitest run test/shared-runtime-child.test.ts test/runtime-events-v2.test.ts test/durable-harness-recovery.test.ts`

Expected: all focused tests pass, with no duplicate V2 projection rows and no close of parent-owned persistence from a shared child runtime.

- [ ] **Step 5: Commit**

```powershell
git add src/application/runtime-ports.ts src/application/create-runtime.ts test/shared-runtime-child.test.ts test/runtime-events-v2.test.ts test/durable-harness-recovery.test.ts
git commit -m "feat(runtime): share event and evidence ports with child runs"
```

## Task 2: Lazy, manifest-checked Prometheus MCP Tool

**Files:**
- Create: `src/bootstrap/lazy-settlement-tool.ts`
- Modify: `src/bootstrap/settlement-evidence-tool.ts` only to expose reusable fixed-manifest binding if needed
- Modify: `src/infrastructure/mcp/http-connection.ts` only for injected clock/reconnect cleanup if required by tests
- Test: `test/lazy-settlement-tool.test.ts`
- Test: `test/settlement-evidence-tool.test.ts`

**Interfaces:**
- Consumes `McpConnection`, `EvidenceRecorder`, `ResilientExecutor`, `settlementInput`, and `bindSettlementEvidenceTool`.
- Produces `createLazySettlementEvidenceTool(options): { tool: Tool; close(): Promise<void> }`.
- The returned Tool has the fixed `metrics.settlement` name, `kind: 'evidence'`, `source: 'mcp'`, and exactly `{ service: 'checkout' }` as its local input schema.

```ts
export interface LazySettlementToolOptions {
  mcpUrl: string;
  recorder: EvidenceRecorder;
  executor: ResilientExecutor;
  clock: Clock;
  onClose?: (callback: () => void | Promise<void>) => void;
}
```

- [ ] **Step 1: Write failing tests**

Cover these deterministic cases:

1. Constructing the lazy Tool makes no network request.
2. The first valid call connects, lists the remote manifest, and returns the existing deterministic evidence response.
3. A missing or schema-mismatched remote Tool returns `MCP_PROTOCOL_ERROR` and never exposes a wider schema.
4. A failed first connection can be retried on a later call without reconstructing the parent Toolkit.
5. Abort and timeout propagate as `ABORTED`/`MCP_TIMEOUT`; the shared attempt ledger is decremented once per network attempt.
6. `close()` closes the MCP connection exactly once.

Run: `pnpm exec vitest run test/lazy-settlement-tool.test.ts test/settlement-evidence-tool.test.ts`

Expected: FAIL because lazy binding is absent.

- [ ] **Step 2: Implement static Tool and deferred connection**

Create the local Tool synchronously. On `call`, validate the input first, then run a single-flight `ensureBound(signal)` that connects and invokes the existing manifest binder. Cache only a successful bound Tool. On a connection/protocol failure, clear the cached binding and retain the fixed local Tool; never replace it with remote descriptors.

Use the existing `ResilientExecutor` for connect/list/call attempts. Do not add a second exponential retry loop. Preserve `callOptions.runId`, `stepId`, `toolCallId`, deadline, signal, and shared network budget when delegating to the bound Tool.

- [ ] **Step 3: Implement lifecycle cleanup and safe errors**

Register the MCP connection’s close function through the runtime shutdown registry when one is supplied. Make `close()` idempotent. Do not include MCP URL, response body, credentials, or PromQL in the ToolResponse error or event payload.

- [ ] **Step 4: Run focused tests**

Run: `pnpm exec vitest run test/lazy-settlement-tool.test.ts test/settlement-evidence-tool.test.ts test/mcp-resilience.test.ts`

Expected: all tests pass; existing eager `bindSettlementEvidenceTool` callers remain unchanged.

- [ ] **Step 5: Commit**

```powershell
git add src/bootstrap/lazy-settlement-tool.ts src/bootstrap/settlement-evidence-tool.ts src/infrastructure/mcp/http-connection.ts test/lazy-settlement-tool.test.ts test/settlement-evidence-tool.test.ts
git commit -m "feat(metrics): add lazy manifest-checked MCP binding"
```

## Task 3: Shared child Agent factory and trusted inspection context

**Files:**
- Create: `src/bootstrap/shared-source-child.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/agent-harness.ts`
- Modify: `src/application/run-execution-coordinator.ts`
- Test: `test/trusted-run-context.test.ts`
- Test: `test/shared-source-child.test.ts`

**Interfaces:**
- Consumes `SharedRuntimeEventPorts`, the runtime-owned stores/recorder, and `SourceChildAgentFactory`.
- Produces `createSharedSourceChildAgentFactory(options): SourceChildAgentFactory`.
- Adds optional `ReplyOptions.trustedSystemContext?: string`; it is an internal host-generated message, not accepted by the HTTP request parser.
- Adds an optional `prepareStart` callback to `RunExecutionCoordinator` that decorates only a new Run; resume reads the persisted context and does not regenerate it.

```ts
export interface SharedSourceChildFactoryOptions {
  model: ChatModel;
  workspaceRoots: readonly string[];
  checkpoints: CheckpointStore;
  evidence: EvidenceStore;
  evidenceRecorder: EvidenceRecorder;
  sharedEvents: SharedRuntimeEventPorts;
}
```

- [ ] **Step 1: Write failing tests**

Test that a child factory creates an Agent with only the supplied child Tools, uses the parent checkpoint/evidence/event stores, preserves `childRunId`, and does not register Bash or any parent-level Subagent. Test that a new Web Run stores one `role: 'system'` message containing the host Profile/window scope before the user message; after a checkpoint reload/resume the exact message remains unchanged.

```ts
expect(context.messages[0]?.role).toBe('system');
expect(context.messages[0]?.blocks[0]).toMatchObject({ type: 'text' });
expect((await resumed.checkpoints.load(runId))?.context.messages[0]).toEqual(context.messages[0]);
```

Run: `pnpm exec vitest run test/trusted-run-context.test.ts test/shared-source-child.test.ts`

Expected: FAIL because no trusted context option or shared child factory exists.

- [ ] **Step 2: Add the optional trusted context message**

Extend `ReplyOptions` with an optional `trustedSystemContext`. In `AgentHarness.createContext`, create a bounded system `AgentMessage` with an injected ID and clock timestamp, then place it before the user message. Do not accept arbitrary extra fields from HTTP. Preserve legacy context shape when the option is omitted.

- [ ] **Step 3: Add coordinator start decoration**

Extend `RunExecutionCoordinator` with an optional constructor callback:

```ts
prepareStart?: (options: ReplyOptions) => ReplyOptions;
```

Apply it immediately before the first `agent.replyStream()` call. Do not apply it to `resume()`. The callback must not mutate the caller’s object; return a new object.

- [ ] **Step 4: Implement the child factory**

`createSharedSourceChildAgentFactory` must call `createInspectionRuntime` with:

```ts
{
  model,
  workspaceRoots: [...workspaceRoots],
  tools: [...input.tools],
  allowedToolNames: input.tools.map((tool) => tool.name),
  checkpoints,
  evidence,
  evidenceRecorder,
  eventMessageStore: sharedEvents.store,
  sharedEvents,
  includeExternalBash: false,
  actionMode: 'dry_run',
}
```

Return only `runtime.agent`. The child runtime must not close the shared stores; its local close hook is a no-op because MCP cleanup belongs to the parent lazy source.

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm exec vitest run test/trusted-run-context.test.ts test/shared-source-child.test.ts test/run-execution-coordinator.test.ts test/durable-harness-recovery.test.ts`

```powershell
git add src/bootstrap/shared-source-child.ts src/agent/types.ts src/agent/agent-harness.ts src/application/run-execution-coordinator.ts test/trusted-run-context.test.ts test/shared-source-child.test.ts
git commit -m "feat(agent): compose isolated child runs with trusted scope"
```

## Task 4: Web bootstrap configuration and Metrics Subagent wiring

**Files:**
- Create: `src/bootstrap/metrics-web-source.ts`
- Modify: `src/bootstrap/agent-web-runtime.ts`
- Modify: `apps/agent-server/index.mjs`
- Modify: `docs/guides/agent-web-local.md`
- Modify: `test/agent-web-runtime.test.ts`
- Create: `test/metrics-web-source.test.ts`

**Interfaces:**
- Consumes `RuntimeToolPorts`, `settlementMetricsLabProfile`, `createLazySettlementEvidenceTool`, `createMetricsSubagentTool`, and `createSharedSourceChildAgentFactory`.
- Produces an optional `metrics` field on `AgentWebRuntimeOptions`:

```ts
metrics?: {
  profileId: 'simulation';
  mcpUrl: string;
  childModel?: ChatModel;
};
```

- [ ] **Step 1: Write failing composition tests**

Add tests that:

1. `metrics` configuration registers only `metrics_subagent` in the parent Toolkit.
2. The child factory sees exactly `metrics.settlement` and `source_report`.
3. Missing `mcpUrl` or an unsupported `profileId` fails before the HTTP server starts.
4. No metrics configuration preserves direct test injection of `options.tools`.
5. The generated trusted context contains fixed `simulation`, `checkout`, `start`, `end`, and the allowed-tool statement.

Run: `pnpm exec vitest run test/metrics-web-source.test.ts test/agent-web-runtime.test.ts`

Expected: FAIL because the Web runtime has no Metrics configuration or source factory.

- [ ] **Step 2: Implement the Web source composition**

Create `createMetricsWebSource(ports, options)` that:

1. Constructs the lazy fixed-manifest settlement Tool with `ports.evidenceRecorder`, `ports.clock`, and `ports.registerShutdownHook`.
2. Builds the shared child factory from `ports.sharedEvents`, `ports.checkpoints`, `ports.evidence`, and the configured parent/child model.
3. Creates `metrics_subagent` with `settlementMetricsLabProfile`, the lazy Tool, the child factory, `ports.checkpoints`, `ports.clock`, and `{ ...ports.events, ids: ports.ids }` lifecycle ports.
4. Returns only the parent `metrics_subagent` to the parent Tool registry.

The source factory must not invoke MCP at bootstrap time. It must register the lazy source close hook with the runtime.

- [ ] **Step 3: Add explicit Profile behavior**

When `options.metrics` is supplied, expose only the `simulation` Profile and set its description to say it uses the local Prometheus lab. When it is absent, retain explicit custom Profiles and change the default `group-buy-market` description to “尚未接入指标来源”；do not imply that it has live metrics. Reject a `metrics.profileId` other than `simulation`.

- [ ] **Step 4: Add trusted window preparation**

For the `simulation` Profile, use the Web runtime clock once per start request to build a five-minute window:

```ts
const end = Math.floor(clock.now().getTime() / 1000) * 1000;
const start = end - 300_000;
```

Pass a bounded Chinese/English-neutral system message through `prepareStart`; do not expose it as a browser field. Resume must reuse the persisted message.

- [ ] **Step 5: Wire the CLI and documentation**

In `apps/agent-server/index.mjs`, parse `AGENTOPS_WEB_PROFILE` and `AGENTOPS_METRICS_MCP_URL`. If one is present without the other, throw a configuration error. For `simulation`, pass `metrics: { profileId: 'simulation', mcpUrl }`. Document startup order: Prometheus Compose, Metrics Lab/MCP, Agent Web server, then Agent Web page. State explicitly that data is simulated and `group-buy-market` is not connected.

- [ ] **Step 6: Run focused tests and commit**

Run: `pnpm exec vitest run test/metrics-web-source.test.ts test/agent-web-runtime.test.ts test/metrics-subagent-runtime.test.ts`

```powershell
git add src/bootstrap/metrics-web-source.ts src/bootstrap/agent-web-runtime.ts apps/agent-server/index.mjs docs/guides/agent-web-local.md test/agent-web-runtime.test.ts test/metrics-web-source.test.ts
git commit -m "feat(web): wire simulation metrics subagent"
```

## Task 5: Durable Web integration and failure/recovery tests

**Files:**
- Create: `test/metrics-web-durable.test.ts`
- Modify: `src/infrastructure/sqlite/inspection-query-service.ts` only if a bounded child relation query is missing
- Modify: `src/storage/in-memory-inspection-query.ts` only for parity if the same relation behavior is needed
- Modify: `src/application/metrics-source-report-collector.ts` only if public unavailable/partial mapping is not deterministic
- Modify: `test/real-prometheus.test.ts` to share assertions with the Web path without changing its opt-in behavior

**Interfaces:**
- Consumes the configured Web runtime and existing `InspectionQueryService`, `WebMessageQueries`, and EvidenceStore.
- Produces no new public event type; verifies the existing parent/child relation and evidence read models.

- [ ] **Step 1: Write failing durable integration tests**

Use a local deterministic MCP connection or existing local MCP server and a separate scripted parent/child model. Assert:

1. Parent detail has one child Run ID.
2. Child detail, public messages, and evidence can be queried through the same SQLite directory.
3. Parent ToolResult and child evidence use the same evidenceId.
4. Raw metric exposition is absent from parent checkpoint messages, public messages, SSE frames, and LangSmith/audit payloads.
5. Close and reopen the Web runtime with the same data directory; parent and child history remain queryable.
6. Invalid remote schema, MCP timeout, and disconnected source produce `unavailable`/`missingEvidence` or a structured failure, never a healthy conclusion.
7. A valid evidence capture followed by report failure returns `partial` and does not capture the same `captureKey` twice after retry/resume.

Run: `pnpm exec vitest run test/metrics-web-durable.test.ts`

Expected: FAIL at child persistence, public relation, or unavailable mapping until the integration is connected.

- [ ] **Step 2: Fix only deterministic mapping gaps**

If the test shows an unavailable MCP result is being surfaced as a healthy or unstructured result, map it at the Metrics Source Adapter/Collector boundary to the existing `SourceSubagentResult.status` values. Do not parse natural-language text. If the test shows duplicate capture, reuse the existing stable `evidenceId`/`captureKey` and checkpoint verification path rather than adding a second retry loop.

- [ ] **Step 3: Verify restart and isolation**

Run the durable tests twice in one process and once with a close/reopen boundary. Assert two parent Runs do not share child IDs, evidence IDs, messages, or missing evidence. Assert a child completion is not replayed as a duplicate after startup recovery.

- [ ] **Step 4: Commit**

```powershell
git add test/metrics-web-durable.test.ts src/infrastructure/sqlite/inspection-query-service.ts src/storage/in-memory-inspection-query.ts src/application/metrics-source-report-collector.ts test/real-prometheus.test.ts
git commit -m "test(web): verify durable metrics source recovery"
```

## Task 6: Opt-in real Prometheus and browser acceptance

**Files:**
- Create: `test/metrics-web-real-prometheus.test.ts`
- Modify: `test/e2e/fixture-server.mjs` only if a separate metrics fixture server is needed; keep the existing fixed-tool E2E intact
- Create: `test/e2e/metrics-web.spec.ts`
- Modify: `playwright.config.ts` only to register the opt-in project without changing the default `pnpm e2e`
- Modify: `docs/architecture/13-metrics-lab-implementation.md` with the new validation boundary

**Interfaces:**
- Consumes existing `SettlementSimulator`, `PrometheusSettlementSource`, `startSettlementMcpServer`, `startAgentWebRuntime`, and Docker Compose Prometheus.
- Produces opt-in acceptance guarded by `AGENTOPS_REAL_PROMETHEUS_WEB=1`; default tests do not require Docker or credentials.

- [ ] **Step 1: Write the opt-in test harness**

Start the simulator, connect to the dedicated local Prometheus at `127.0.0.1:19090`, start the existing MCP service, and start Web with `metrics: { profileId: 'simulation', mcpUrl }`. Use a parent model that emits a `metrics_subagent` ToolCall and a child model that emits `metrics.settlement`, `source_report`, and final text. Wait for actual Prometheus scrape freshness before starting each case.

- [ ] **Step 2: Add deterministic assertions for three scenarios**

For `normal`, `settlement_failure`, and `low_sample`, assert the stored metric fact and exact status/rate. Assert the browser/public result uses the deterministic Chinese summary and never includes model-invented root cause text or raw exposition. For a stopped MCP server, assert `unavailable`/`missingEvidence` and no healthy statement.

- [ ] **Step 3: Add browser checks**

In `test/e2e/metrics-web.spec.ts`, open the actual Agent Web page, submit a simulation inspection, wait for completion, open the child Run card, and verify the evidence summary. Close/restart the Agent server and reload the same Run; verify parent/child history and evidence remain visible. Keep confirmation expiry and existing fixed-tool HITL tests in the current E2E suite.

- [ ] **Step 4: Run opt-in acceptance when Docker is available**

```powershell
pnpm lab:backend:up
$env:AGENTOPS_REAL_PROMETHEUS_WEB = '1'
pnpm exec vitest run test/metrics-web-real-prometheus.test.ts
pnpm exec playwright test test/e2e/metrics-web.spec.ts
Remove-Item Env:AGENTOPS_REAL_PROMETHEUS_WEB
pnpm lab:backend:stop
```

Expected: the commands pass only when the local Prometheus backend and lab services are running; otherwise the result is reported as not run, not as a code failure.

- [ ] **Step 5: Commit**

```powershell
git add test/metrics-web-real-prometheus.test.ts test/e2e/metrics-web.spec.ts test/e2e/fixture-server.mjs playwright.config.ts docs/architecture/13-metrics-lab-implementation.md
git commit -m "test(web): accept real Prometheus metrics flow"
```

## Task 7: Full verification and delivery report

**Files:**
- Modify: `docs/guides/agent-web-local.md` with exact verified commands and limitations
- Modify: `docs/architecture/13-metrics-lab-implementation.md` with actual test date/results
- No source changes unless a verification failure identifies a concrete regression

- [ ] **Step 1: Run the mandatory quality gates**

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm web:typecheck
pnpm web:build
pnpm e2e
```

Record exit status and test counts for every command. Run `git diff --check` and inspect `git status --short`.

- [ ] **Step 2: Run the plan coverage audit**

Confirm each Spec section is evidenced by code/tests:

| Spec section | Evidence |
| --- | --- |
| Shared parent/child data plane | Task 1 tests and child runtime composition |
| Lazy fixed MCP manifest | Task 2 unit tests |
| Trusted window and Profile scope | Task 3/4 tests |
| Four-round unavailable/partial behavior | Task 5 tests |
| Web durable read model | Task 5 restart tests |
| Real Prometheus path | Task 6 opt-in tests |
| No raw evidence leakage | Task 5/6 assertions |

Any unchecked row blocks a completion claim.

- [ ] **Step 3: Commit documentation and report status**

```powershell
git add docs/guides/agent-web-local.md docs/architecture/13-metrics-lab-implementation.md
git commit -m "docs: record metrics Web integration verification"
```

The final report must distinguish default deterministic tests, opt-in real Prometheus tests, and real online model smoke tests. It must state that `group-buy-market` remains unconnected until its own Profile/spec is implemented.
