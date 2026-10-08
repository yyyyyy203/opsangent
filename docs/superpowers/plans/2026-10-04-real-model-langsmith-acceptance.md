# 真实模型联合验收与 LangSmith 闭环 Implementation Plan

> 2026-10-07 修订实施以 [烟测失败修复计划](./2026-10-07-real-model-smoke-repair.md) 和最新 Spec 为准。下文 fixed-cap 512 示例保留为历史基线/兼容性测试，不再代表报告轮上限；当前查询 512、报告/汇总 1024、共享输出预留 5120。新增失败 snapshot、可选失败 usage、multipart/gzip 审计和本地/远端错误区分。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对现有只读 Metrics＋Logs Web 完成可复现的低费用真实模型验收，并验证 LangSmith 层级、用量及隐私边界。

**Architecture:** V2 事件仍是执行与审计事实来源；真实 LangSmith 仅通过事件专用观测端口导出。父子模型共享 smoke 请求预算，来源调查有单次调用限制。默认确定性评测无费用，真实烟测单独 opt in，最终自然语言诊断由人复核。

**Tech Stack:** 提案使用 Node.js 24 LTS、TypeScript、pnpm 11.19.0，复用 SQLite/OpenAI-compatible/MCP/LangSmith/Prometheus/Elasticsearch/Vitest/Playwright。

**Spec:** [真实模型联合验收设计](../specs/2026-10-04-real-model-langsmith-acceptance-design.md)。

## Global Constraints

- 本计划待审核；编写计划不等于开始实施、付费调用、提交或推送。
- 代码基线 `c8e15201f62e29109beec8cb5fba55075e83a20d`；工作目录 `D:\agentops\.worktrees\event-message-v2`，已有 worktree 不重建。
- 提案基线：Node.js 24 LTS，`engines.node = ">=24.0.0 <25.0.0"`，`.node-version = 24`。
- 保留 `packageManager = "pnpm@11.19.0"`；不升级无关依赖。
- 不修改已发布 V1/V2 事件/消息/ToolResponse、SQLite Schema、Harness 顺序、证据只展示摘要/引用的行为。
- 仅 `simulation/checkout` 和本地只读实验后端；不改业务仓库，不启用真实写动作，不上传原始证据。
- LangSmith 默认关闭；单次 HTTPS 超时 1,000 ms，flush 总等待最多 2,000 ms，pending 最多 256；SDK ingest 内存最多 1 MiB、batch 最多 64 KiB/32 操作、并发 1、自动重试为 0。
- 真实模型：一个父 Run、Metrics/Logs 各最多一次子调查、HTTP 最多 10 次、查询轮 512/报告汇总轮 1024 token、共享输出预留最多 5120、父 deadline 90 秒、子 deadline 沿用最多 30 秒；失败不自动重跑。
- 默认测试/CI 不用密钥、不发付费模型请求、不自动启动 Docker；真实后端和模型均分开 opt in。
- 遵守根 `AGENTS.md`；现有 modified/untracked 计划文件不覆盖、不暂存；每项实现按 TDD 和独立审核推进。

## 依赖与文件职责

```text
Task 1 工具链
  → Task 2 事件观测端口及模型身份
    → Task 3 Span 投影生命周期
      → Task 4 安全、有界 LangSmith 组装
Task 1 → Task 5 共享请求/来源预算
Task 2＋3＋4＋5 → Task 6 默认评测
Task 6 → Task 7 真实联合验收与交付
```

Task 2/5 都修改 Web bootstrap、Task 4/7 都修改启动或文档；不得让两个写入者同时编辑同一文件。推荐顺序 1→2→3→4→5→6→7；每项先实现审查、再规格审查/质量审查。本文代码片段是约束接口和最小实现切入点，不是把某个占位函数当作已完成代码。

| 模块 | 单一职责 |
| --- | --- |
| bootstrap model identity / LangSmith config | 解析配置并注入端口，不进入 Harness |
| trace span registry / V2 Projector | 管理语义键、层级、终态和安全投影 |
| export diagnostics / LangSmith Adapter | 有界 HTTPS、供应商格式、drop/timeout 可见性 |
| model bounded-smoke-fetch | 在真实 fetch 前执行共享请求额度限制 |
| tool source-invocation-limiter | 只限制同一 Run 的来源调用，不拥有主循环 |
| acceptance types/evaluator/runner | 本地纯评测、opt-in 场景运行、产物与远端核验 |

---

### Task 1：修正工具链基线与离线质量门

**Files:**

- Modify: `AGENTS.md`, `package.json`, `pnpm-lock.yaml`, `docs/README.md`。
- Modify: `docs/guides/agent-web-local.md`, `docs/guides/logs-web-elasticsearch-local.md`。
- Create: `.node-version`, `.github/workflows/quality-gates.yml`。
- Test: `test/toolchain-baseline.test.ts`。

**Interfaces:**

- Consumes: Spec §3 的 Node 升级 ADR、现有 pnpm scripts/allowBuilds。
- Produces: Node 24＋pnpm 11.19.0 的冻结安装和无付费 CI；保留现有命令名。

- [ ] **Step 1：先写基线失败测试。**

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('pins the supported runtime and package manager', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(pkg.engines.node).toBe('>=24.0.0 <25.0.0');
  expect(pkg.packageManager).toBe('pnpm@11.19.0');
  expect(readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim()).toBe('24');
});
```

- [ ] **Step 2：运行 `pnpm exec vitest run test/toolchain-baseline.test.ts`，确认是版本断言/缺文件失败。** 先用符合该 pnpm 的 Node 执行，不使用 Node 20＋pnpm 11 的失败作为测试 RED；无 Node 24 时记录环境阻塞，不修改系统安装或降低基线。
- [ ] **Step 3：实施 ADR，更新 types 和指南。** `pnpm add -D --save-exact @types/node@24` 锁定解析出的精确版本；保留现有原生构建 allowBuilds。指南注明 Node 20 不再是受支持开发/部署基线，不删除旧 Spec。CI 内容：

```yaml
name: quality-gates
on: [push, pull_request]
permissions:
  contents: read
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '24'
      - run: npm install --global pnpm@11.19.0
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - run: pnpm web:typecheck
      - run: pnpm web:build
```

上述 action 版本来自本轮已查证的官方 README；实施时确认 tag 存在且 runner 支持，按组织要求可锁定其已验证 SHA，不编造 SHA。这个 workflow 不运行真实后端/真实模型任务。

- [ ] **Step 4：在隔离干净安装中运行 `pnpm install --frozen-lockfile` 与上述六道质量门。** 不删除现有 node_modules，使用新建临时目录/CI验证原生依赖加载。记录本机结果及 Windows/Linux CI 分别是否实际执行；未运行的操作系统不能写“通过”。
- [ ] **Step 5：审核 Task 1 后，只暂存本项明确文件；提交 `build: align supported Node 24 and pnpm baseline`。** 不暂存无关设计计划。

### Task 2：新增事件专用观测端口与父子模型身份

**Files:**

- Modify: `src/application/create-runtime.ts`, `src/bootstrap/agent-web-runtime.ts`。
- Modify: `src/bootstrap/shared-source-child.ts`, `src/bootstrap/metrics-web-source.ts`, `src/bootstrap/logs-web-source.ts`。
- Create: `src/bootstrap/model-identity.ts`；Modify: `src/bootstrap/index.ts`。
- Create: `test/fixtures/recording-observability.ts`。
- Test: `test/runtime-event-observability.test.ts`, `test/agent-web-runtime.test.ts`, `test/metrics-web-source.test.ts`, `test/logs-web-source.test.ts`。

**Interfaces:**

- Consumes: 现有 `Observability`、`SharedRuntimeEventPorts`、`ChatModel`。
- Produces: `eventObservability?: Observability`、根/ Web runtime 的 `flushEventObservability(): Promise<void>`。
- Produces: `ModelIdentity { provider: string; model: string }`；Web/来源/SharedChild 可选 `modelIdentity`，来源配置中对应独立 child 的身份。

- [ ] **Step 1：构造测试用记录端口，再写事件专用端口失败测试。**

```ts
export class RecordingObservability implements Observability {
  readonly starts: SpanStart[] = [];
  readonly endings: { spanKey?: string; output?: unknown; error?: unknown }[] = [];
  flushes = 0;
  startSpan(input: SpanStart): SpanHandle {
    this.starts.push(input);
    return {
      setAttributes: () => undefined,
      end: (output) => { this.endings.push({ spanKey: input.spanKey, output }); },
      fail: (error) => { this.endings.push({ spanKey: input.spanKey, error }); },
    };
  }
  async flush(): Promise<void> { this.flushes += 1; }
}
```

```ts
it('exports V2 spans without enabling direct Harness instrumentation', async () => {
  const exporter = new RecordingObservability();
  const model: ChatModel = {
    async *stream() {
      yield { type: 'text_delta' as const, delta: 'done' };
      return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runtime = createAgentRuntime({ model, workspaceRoots: [], includeExternalBash: false,
    eventObservability: exporter });
  await runtime.agent.reply({ message: 'inspect', profileId: 'simulation' });
  expect(exporter.starts.some((span) => span.name === 'agent.run')).toBe(true);
  expect(exporter.starts.some((span) => span.name === 'inspection.run')).toBe(false);
  await runtime.flushEventObservability();
  expect(exporter.flushes).toBe(1);
  await runtime.close();
});
```

增加旧 `observability` 注入仍收到旧 span、sharedEvents child 不重复订阅、disabled 无网络、启停 flush 所有权、模型身份独立/继承测试。

- [ ] **Step 2：运行 `pnpm exec vitest run test/runtime-event-observability.test.ts`，确认缺新端口/flush 行为失败。**
- [ ] **Step 3：仅更改组装边界，保持直接观测兼容。**

```ts
const observability = options.observability ?? new NoopObservability();
const eventObservability = options.eventObservability ?? observability;
const langSmithProjectorV2 = new LangSmithEventProjectorV2(eventObservability);
// Harness/Tool/ObservabilityModelAttemptObserver 继续拿 observability。
// 仅根 Runtime 注册 Projector；子 Runtime 使用 sharedEvents。
const flushEventObservability = async (): Promise<void> => {
  if (options.sharedEvents === undefined) await langSmithProjectorV2.flush();
};
```

根 close 在 shutdown hooks 后、持久化关闭前兜底调用该函数；不让观测异常跳过本地关闭。Web 返回该函数。`ModelIdentity` 在 bootstrap 定义并显式传入已有 `modelProvider/modelName`；父子复用模型才继承，独立 child 未标身份保留 configured。不要改变所有模型重试策略。

- [ ] **Step 4：运行 Task 2 四个测试文件、`test/model-harness-contract.test.ts` 和 `test/runtime-events-v2.test.ts`；再运行 `pnpm typecheck`。** 把实际文件名与 `rg --files test` 核对；兼容测试必须保留 V1 generator 和 EventBus 的既有断言。
- [ ] **Step 5：审核并提交 `feat(observability): add event-only runtime tracing port`。**

### Task 3：修复 V2 Span 身份、终态和投影隐私

**Files:**

- Modify: `src/event/projectors/langsmith-projector.ts`。
- Create: `src/event/projectors/trace-span-registry.ts`。
- Test: `test/event-v2-audit-langsmith.test.ts`, `test/langsmith-span-lifecycle.test.ts`。

**Interfaces:**

- Consumes: Task 2 的 `Observability` 注入、现有 V2 envelope。
- Produces: `TraceTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'paused' | 'incomplete'`；`TraceSpanRegistry` 管理 `start(input: SpanStart): void`, `end(key: string, output?: unknown): void`, `fail(key: string, error: unknown): void`, `closeDescendants(key: string, status: TraceTerminalStatus): void`。registry 持有 active handles 和当前执行组内的去重键，不含 SDK/网络。
- Produces: 现有 `LangSmithEventProjectorV2.project/flush` 保持签名；执行段、来源包装和尝试分别拥有唯一语义键。

- [ ] **Step 1：在现有测试的 `event()` helper 基础上写取消关闭和来源包装/子执行段不覆盖测试。** 新文件沿用相同 factory 构造模式，不复制实际来源实现。

```ts
it('closes a cancelled execution segment once', async () => {
  const observer = new RecordingObservability();
  const projector = new LangSmithEventProjectorV2(observer);
  const start = event('RUN_STARTED', { profile: 'simulation', trigger: 'manual',
    deadline: '2026-10-04T10:01:30.000Z', versionSnapshot: {} }, { streamId: 's1' });
  const end = event('RUN_CANCELLED', { actor: 'user', reason: 'cancel', stage: 'triage' },
    { streamId: 's1' });
  await projector.project(start);
  await projector.project(start);
  await projector.project(end);
  await projector.project(end);
  expect(observer.starts).toHaveLength(1);
  expect(observer.endings).toHaveLength(1);
  expect(observer.endings[0]?.output).toMatchObject({ status: 'cancelled' });
});
```

追加：parent tool → invocation → child segment → model/tool 的 parentSpanKey；SUBAGENT_STARTED 上的父 stream 不冒充子 stream；RUN_PAUSED→RUN_RESUMED 新段；超时/失败残留子句柄关闭；迟到终态不重开；缺父 start 的 orphan 诊断；正常归档后 map 释放。加入 trigger/finalText/inputSummary/error.message 的 synthetic secret canary，所有投影输出均不能含 canary。

- [ ] **Step 2：运行 `pnpm exec vitest run test/event-v2-audit-langsmith.test.ts test/langsmith-span-lifecycle.test.ts`，确认现存取消/重复/隐私断言失败。**
- [ ] **Step 3：引入 registry 与安全字段投影，按 Spec §5/6 固定键和终态。**

```ts
function segmentKey(runId: string, streamId?: string): string {
  return `run:${runId}:${streamId ?? 'initial'}`;
}
function invocationKey(parentRunId: string, toolCallId: string, childRunId: string): string {
  return `source:${parentRunId}:${toolCallId}:${childRunId}`;
}
// RUN_STARTED/RESUMED 用 segmentKey；SUBAGENT_STARTED 用 invocationKey。
// RUN_FINISHED 只投影 outcome/status/duration/usage，不传 finalText。
// fail 只使用 code/retryable/category，不传 Error.message 或 stack。
```

沿用现有 model/tool attempt 键，并显式关联活跃 segment。把重复 eventId/语义 start/end 和 registry 内存上限纳入实现；source 包装与执行段不是重复 span。供应商 `usage_metadata` 不在这里构造，留给 Task 4。

- [ ] **Step 4：运行两份测试与 `pnpm typecheck`。** 现有断言里的内部 spanKey 按新语义更新；不改 event 字段来配合测试。
- [ ] **Step 5：审核并提交 `fix(observability): make V2 trace spans lifecycle-safe`。**

### Task 4：安全、有界 LangSmith Adapter 与 CLI 组装

**Files:**

- Modify: `src/observability/langsmith-observability.ts`, `src/index.ts`。
- Create: `src/observability/export-diagnostics.ts`, `src/observability/langsmith-payload.ts`。
- Create: `src/bootstrap/langsmith.ts`；Modify: `src/bootstrap/index.ts`。
- Modify: `apps/agent-server/index.mjs`, `.env.example`。
- Test: `test/langsmith-config.test.ts`, `test/langsmith-observability.test.ts`, `test/langsmith-runtime.integration.test.ts`。

**Interfaces:**

- Consumes: Task 2 的 eventObservability，Task 3 白名单 span metadata，既有 LangSmith SDK `Client/RunTree`。
- Produces: `readLangSmithEventConfig(env: Readonly<Record<string, string | undefined>>): LangSmithEventConfig`。
- Produces: `createLangSmithEventObservability(config: LangSmithEventConfig, dependencies?: { fetch?: typeof globalThis.fetch; now?: () => number }): LangSmithEventExporter`。

```ts
export type LangSmithEventConfig = { enabled: false } | {
  enabled: true; apiKey: string; projectName: string; endpoint: string;
};
export type ExportDiagnosticCode = 'TRACE_QUEUE_FULL' | 'TRACE_NETWORK_ERROR'
  | 'TRACE_REQUEST_TIMEOUT' | 'TRACE_FLUSH_TIMEOUT' | 'TRACE_PARENT_MISSING'
  | 'TRACE_PAYLOAD_DROPPED';
export interface ExportDiagnostics {
  pending: number; dropped: number;
  counts: Partial<Record<ExportDiagnosticCode, number>>;
}
export interface TraceLink {
  spanKey: string; agentRunId: string; remoteRunId: string; traceId: string;
  parentRemoteRunId?: string;
}
export interface LangSmithEventExporter {
  eventObservability: Observability;
  getDiagnostics(): ExportDiagnostics;
  getTraceLinks(): readonly TraceLink[];
}
```

Exporter 的 link 快照最多 256 项，受限 smoke 中足够核验；不是生产 trace-history repository。实现类可有同名诊断方法，但不扩展公共 `Observability` 必选接口。

- [ ] **Step 1：先写关闭/缺 key、canary 脱敏与 canonical usage 的失败测试。**

```ts
expect(readLangSmithEventConfig({ LANGSMITH_TRACING: 'false' })).toEqual({ enabled: false });
expect(() => readLangSmithEventConfig({ LANGSMITH_TRACING: 'true' }))
  .toThrow('LANGSMITH_CONFIG_INVALID');
```

Adapter 测试用本地 recording HTTP server 或注入 fetchImplementation 记录 SDK 请求，不用真实 Key。输入包含 `input: { prompt: 'SENSITIVE-CANARY' }`、错误全文和地址 canary；发送体不得出现这些值。当 token 为 input=12/output=8/cache=4 时，发送体含 `ls_provider/ls_model_name`、`usage_metadata.input_tokens=12/output_tokens=8/total_tokens=20/input_token_details.cache_read=4`；缺字段不补 0、不猜金额。

- [ ] **Step 2：运行 `pnpm exec vitest run test/langsmith-config.test.ts test/langsmith-observability.test.ts`，确认缺配置工厂/usage/限界行为失败。**
- [ ] **Step 3：实现双重 allowlist 与队列限界，配置 SDK。**

```ts
const client = new Client({
  apiUrl: config.endpoint, apiKey: config.apiKey,
  timeout_ms: 1_000, callerOptions: { maxRetries: 0 },
  autoBatchTracing: true, blockOnRootRunFinalization: false,
  maxIngestMemoryBytes: 1_048_576, batchSizeBytesLimit: 65_536,
  batchSizeLimit: 32, traceBatchConcurrency: 1,
  omitTracedRuntimeInfo: true, debug: false,
  fetchImplementation: timedFetch,
});
```

`timedFetch` 由 Adapter 创建，合并调用 signal 与所属 controller，1秒截止，finally 清理；flush 用同一所属 controller 2秒兜底，超时真实 abort 后完成安全诊断。Pending 加入前校验容量；满队列拒绝整个新 Span。promise 的两个分支都消费：

```ts
void operation.then(
  () => { pending.delete(operation); },
  () => { diagnostics.record('TRACE_NETWORK_ERROR'); pending.delete(operation); },
);
```

`diagnostics.record` 是本项计数器的方法，仅接受上述 enum，不接受异常参数。`langsmith-payload.ts` 输出安全属性/inputs/outputs；只映射已有已知 token，用安全整数检查总量。错误只输出固定码。保留已公开构造器选项 `client/projectName/enabled/tags` 的兼容，tags 只保留固定 allowlist。

- [ ] **Step 4：CLI 用显式工厂组装。**

```js
const tracing = createLangSmithEventObservability(readLangSmithEventConfig(process.env));
// startAgentWebRuntime 原有选项不变，只增加：
// eventObservability: tracing.eventObservability
// modelIdentity: { provider: configuredProvider, model: process.env.AGENTOPS_MODEL }
```

`configuredProvider` 从新增 `AGENTOPS_MODEL_PROVIDER` 读取，未提供用 `openai-compatible`；模型名沿用已解析 model config。同步 `.env.example` 说明关闭默认、真实 exporter 不上传正文。不要把 LangSmith key 或 endpoint 放进 VITE。为 Node CLI 加启动/关闭测试，使用本地 SDK server，不发模型请求。

- [ ] **Step 5：扩展挂起/拒绝/429/queue full/final flush 测试并跑集成。** 使用 Vitest fake timers＋Abort-aware fake fetch 验证 1秒/2秒、active句柄释放、无 unhandledRejection；SDK 实际本地 HTTP 测试验证请求次数和 parent_run_id/trace_id。LangSmith 故障下本地 Run、取消和查询仍完成；`getDiagnostics()` 不能误报成功。

Run: `pnpm exec vitest run test/langsmith-config.test.ts test/langsmith-observability.test.ts test/langsmith-runtime.integration.test.ts test/event-v2-audit-langsmith.test.ts`；随后 `pnpm lint`、`pnpm typecheck`。

- [ ] **Step 6：审核并提交 `feat(observability): wire bounded privacy-safe LangSmith export`。**

### Task 5：共享模型请求预算与单次来源调查限制

**Files:**

- Create: `src/model/bounded-smoke-fetch.ts`, `src/model/smoke-request-budget.ts`。
- Create: `src/tool/source-invocation-limiter.ts`。
- Modify: `src/bootstrap/agent-web-runtime.ts`, `src/index.ts`。
- Modify: `test/fixtures/bounded-smoke-fetch.ts`（保留旧 import 路径的 re-export）。
- Test: `test/bounded-smoke-fetch.test.ts`, `test/smoke-request-budget.test.ts`, `test/source-invocation-limiter.test.ts`, `test/agent-web-runtime.test.ts`。

**Interfaces:**

- Consumes: 现有 bounded-smoke-fetch 的 Request/body/Abort 处理、`Tool` 与 `ToolCallOptions.runId`。
- Produces: `SmokeRequestBudget` 的 `reserve(): boolean`, `rejectReserved(): void`, `markSent(): void`, `snapshot(): SmokeBudgetSnapshot`。
- Produces: `createBoundedSmokeFetch(options: BoundedSmokeFetchOptions): typeof globalThis.fetch`，原 options 保留，可选 `budget` 支持读取 ledger。
- Produces: `SourceInvocationLimiter({ maxPerSource: 1 })` 的 `wrap(tool: Tool): Tool` 和 `clear(): void`；bootstrap 可选 `sourceInvocationLimit?: 1`。

```ts
export interface SmokeBudgetSnapshot {
  limit: number; attempted: number; sent: number; rejected: number;
}
// new SmokeRequestBudget(limit: number)，limit必为1..10。
// reserve同步预留、rejectReserved记录本地拒绝、markSent记录实际发送。
export interface BoundedSmokeFetchOptions {
  fetch: typeof globalThis.fetch; limit: number; maxOutputTokens: number;
  onAttempt: (count: number) => void; budget?: SmokeRequestBudget;
}
```

- [ ] **Step 1：先测试共享名额、并发和输入上限。**

```ts
it('never sends an eleventh paid request', async () => {
  const sentBodies: string[] = [];
  const budget = new SmokeRequestBudget(10);
  const fetch = createBoundedSmokeFetch({ budget, limit: 10, maxOutputTokens: 512,
    onAttempt: () => undefined,
    fetch: async (_input, init) => {
      sentBodies.push(String(init?.body));
      return new Response('{}', { status: 200 });
    },
  });
  const responses = await Promise.all(Array.from({ length: 11 }, () => fetch(
    'https://model.example/v1/chat/completions',
    { method: 'POST', body: JSON.stringify({ max_tokens: 4096, messages: [] }) },
  )));
  expect(sentBodies).toHaveLength(10);
  expect(responses.filter((response) => response.status === 402)).toHaveLength(1);
  expect(sentBodies.every((body) => JSON.parse(body).max_tokens === 512)).toBe(true);
  expect(budget.snapshot()).toEqual({ limit: 10, attempted: 11, sent: 10, rejected: 1 });
});
```

来源测试用计数 Tool：同一 runId 第二次调用拒绝、child函数只执行一次；另一 Run 的限额隔离；metrics/logs 分别计数；拒绝/Abort 不返还来源名额；call 仍经过管线，结果错误码为 BUDGET_EXCEEDED。

- [ ] **Step 2：运行 `pnpm exec vitest run test/smoke-request-budget.test.ts test/source-invocation-limiter.test.ts`，确认缺 ledger/limiter 失败。**
- [ ] **Step 3：复用现有 body/Request 安全逻辑，加入保守计数，不新写 SSE 解析器。**

```ts
// reserve 在任何异步读取之前：attempted 增加；用尽则 rejected 增加。
if (!budget.reserve()) return new Response(null, { status: 402 });
// 解析＋1MiB 限界失败：rejected 增加，不归还预留；不回显输入。
// body 校验、clamp max_tokens、删除 max_completion_tokens 完成后：
budget.markSent();
return options.fetch(forwardedInput, forwardedInit);
```

ledger 内部需要 `rejectReserved(): void` 供解析/超大 body 拒绝记录；`markSent` 必须验证有预留且不超限。构造器 limit 为 1..10；maxOutputTokens 为 1..512；外部 ledger limit 必须匹配 options.limit。非 chat-completions 请求在 smoke fetch 返回固定 402，不转发至未知付费 API。保留 Abort/Timeout 的名称和安全文案，不把故障误报成 Key 内容。

Limiter 的 Map 由实例拥有，键为 runId＋规范来源名；只包装两个 canonical 来源 Tool，保持 schema/name/source/kind 原样。先增加计数再调用原始 call，超限抛标准结构化 BUDGET_EXCEEDED；不能发起 child，也不能直接执行工具绕过 ToolRunner。bootstrap 仅在显式 limit=1 时组装，并在 close 中 clear，正常 Web 启动不受影响。

- [ ] **Step 4：跑上述四份测试，保留已有 19 个 fetch 安全场景。** 补 URL/Request 两种 body、非法 JSON/超大流、网络错误安全化、亲子模型/重试/L2共享单实例，以及 per-run 来源额度。执行 `pnpm typecheck`。
- [ ] **Step 5：审核并提交 `feat(acceptance): bound shared model and source calls`。**

### Task 6：默认确定性联合评测与安全产物

**Files:**

- Create: `src/acceptance/types.ts`, `src/acceptance/evaluator.ts`, `src/acceptance/source-reports.ts`, `src/acceptance/index.ts`。
- Create: `src/bootstrap/acceptance-reader.ts`；Modify: `src/bootstrap/index.ts`。
- Create: `test/fixtures/acceptance-cases.ts`, `test/fixtures/scripted-acceptance-runtime.ts`。
- Test: `test/acceptance-evaluator.test.ts`, `test/acceptance-reader.test.ts`, `test/acceptance-scripted.integration.test.ts`。

**Interfaces:**

- Consumes: `PublicRunDetail`, `PublicEvidenceView`, V2 events、`SourceSubagentResult`、`SettlementMetricFact`、Task 4/5 的诊断及预算快照。
- Produces: `readSourceReports(events: readonly AgentEventEnvelopeV2[]): SourceSubagentResult[]`；仅识别对应 source ToolResult 中已校验的 JSON，不信任任意 tool/free text。
- Produces: `evaluateAcceptance(input: AcceptanceInput): AcceptanceReport`，纯函数，不执行工具/HTTP/LLM；`applyManualReview(report: AcceptanceReport, review: ManualReview): AcceptanceReport` 只更新人工结果并重新计算verdict。
- Produces: `readAcceptanceSnapshot(input: { dataDirectory: string; runId: string }): Promise<AcceptanceSnapshot>`，仅对本轮宿主已关闭且路径受控的 SQLite 使用现有 persistence bundle 读取，不新增 HTTP 接口。

```ts
export type AcceptanceCaseId = 'normal' | 'settlement_failure' | 'low_sample'
  | 'logs_offline' | 'capture_window_mismatch';
export type TraceVerification = {
  status: 'verified' | 'failed' | 'unavailable'; checkedSpanCount: number;
};
export type ManualReview = { status: 'pending' }
  | { status: 'approved' | 'rejected'; unsupportedClaimCount: number };
export type AcceptanceCheckCode = 'SOURCE_ALLOWLIST' | 'SOURCE_CALL_LIMIT'
  | 'METRIC_FACT_VALID' | 'SOURCE_WINDOW_VALID' | 'MISSING_EVIDENCE_VISIBLE'
  | 'EVIDENCE_OWNERSHIP' | 'TERMINAL_COMPLETE' | 'MODEL_HTTP_BUDGET'
  | 'USAGE_CONSISTENT' | 'PUBLIC_DATA_SAFE' | 'TRACE_EXPORT_SAFE';
export interface AcceptanceSnapshot {
  parent: PublicRunDetail; children: readonly PublicRunDetail[];
  evidence: readonly PublicEvidenceView[]; events: readonly AgentEventEnvelopeV2[];
}
export interface AcceptanceInput extends AcceptanceSnapshot {
  caseId: AcceptanceCaseId; codeRevision: string; profileRevision: string; snapshotId: string;
  reports: readonly SourceSubagentResult[];
  metricFact: SettlementMetricFact;
  budget: SmokeBudgetSnapshot; exportDiagnostics: ExportDiagnostics;
  traceVerification: TraceVerification; manualReview: ManualReview;
  boundaryChecks: { publicDataSafe: boolean; traceExportSafe: boolean };
}
export interface AcceptanceReport {
  schemaVersion: 1; caseId: AcceptanceCaseId; codeRevision: string; profileRevision: string;
  snapshotId: string; runId: string; childRunIds: string[];
  checks: { code: AcceptanceCheckCode; passed: boolean }[];
  budget: SmokeBudgetSnapshot; usage: RunUsageSummary;
  exportDiagnostics: ExportDiagnostics; traceVerification: TraceVerification;
  manualReview: ManualReview; verdict: 'passed' | 'failed' | 'review_required';
}
```

- [ ] **Step 1：构造五种输入与反例，先写 verdict 失败测试。** `createAcceptanceFixture(caseId): AcceptanceInput` 由本项 fixture 提供；其 reports 必须经现有 source collector 归一化，不仅伪造 passed=true。

```ts
it('does not call an unreviewed narrative passed', () => {
  const input = createAcceptanceFixture('settlement_failure');
  const report = evaluateAcceptance({ ...input,
    manualReview: { status: 'pending' },
    traceVerification: { status: 'verified', checkedSpanCount: 8 },
  });
  expect(report.checks.every((check) => check.passed)).toBe(true);
  expect(report.verdict).toBe('review_required');
  expect(report).not.toHaveProperty('events');
  expect(report).not.toHaveProperty('reports');
});
```

反例：引用不存在的 evidence、错误 parentRunId、source互换、低样本标breached、窗口冲突标complete、Logs不可用却无missingEvidence、重复调用、发送数>10、漏终态、远端失败、人工rejected。每个反例必须触发具体 check code，不按自然语言断言“诊断对了”。

- [ ] **Step 2：运行 `pnpm exec vitest run test/acceptance-evaluator.test.ts`，确认 evaluator 缺失/规则失败。**
- [ ] **Step 3：实现确定性 check 与安全对象重建。**

```ts
function verdict(checks: readonly { passed: boolean }[], trace: TraceVerification,
  review: ManualReview): AcceptanceReport['verdict'] {
  if (checks.some((check) => !check.passed) || trace.status === 'failed'
    || review.status === 'rejected') return 'failed';
  if (review.status === 'approved' && review.unsupportedClaimCount !== 0) return 'failed';
  if (trace.status !== 'verified' || review.status !== 'approved') return 'review_required';
  return 'passed';
}
```

固定 check codes：`SOURCE_ALLOWLIST`、`SOURCE_CALL_LIMIT`、`METRIC_FACT_VALID`、`SOURCE_WINDOW_VALID`、`MISSING_EVIDENCE_VISIBLE`、`EVIDENCE_OWNERSHIP`、`TERMINAL_COMPLETE`、`MODEL_HTTP_BUDGET`、`USAGE_CONSISTENT`、`PUBLIC_DATA_SAFE`、`TRACE_EXPORT_SAFE`。check.code 使用联合类型/enum，不让 LLM 自造字段。

`METRIC_FACT_VALID` 用 `assessSettlementMetrics({ total, failed }, settlementMetricsLabProfile)` 对比 fact.status/failureRate，不解析 finding.statement 算数。五类场景：normal→healthy；settlement_failure→breached；low_sample→insufficient_data；logs_offline→Metrics有效＋Logs不可用显式缺失；capture_window_mismatch→Logs partial＋capture_window_mismatch。后三者预期降级不是自动失败，但绝不能被当完整证据。

Reader 先验证绝对 dataDirectory/存在的 run，使用 `createSqlitePersistence({ path: join(dataDirectory, 'agent.sqlite') })`；读取父与实际最多两个来源 child，分页 events/evidence，finally close。先按 eventId 去重，再对本次 Run 树调用现有 `summarizeRunUsage`；不能把包含子用量的父 summary 再加一次子 summary。Reader 不能开启 runtime、重放模型或导出原始数据。

报告用显式字段重建；不 spread input。过滤错误文本、自由文本、地址/secret/原文 canary；不把 events/reports/messages复制进文件。`ManualReview` 默认 pending，只有人工授权记录才可 approved。boundaryChecks 来自实际公开响应扫描及 Adapter 发送前的结构 allowlist 校验，不能由模型或用户请求填写；脚本集成 additionally 扫描实际 SDK HTTP body，远端 verifier 有数据时再校验其 inputs/outputs/metadata。

- [ ] **Step 4：实现 scripted runtime 集成 fixture。** 使用现有只读 bootstrap 与 fake MCP/HTTP seams，父只调 canonical来源 Tool，child 使用现有 query/report Tools。复用现有 collector；默认测试不连接真实 Compose。验证窗口错配、降级、取消、恢复、证据API/SSE canary，并对实际 exporter HTTP 体检查 canary，不仅检查 evaluator 的 boolean。
- [ ] **Step 5：运行三份本项测试＋`test/source-report-collector.test.ts`、`test/metrics-source-report-collector.test.ts`、`test/logs-source-report-collector.test.ts`、`test/web-query-sqlite.test.ts`、`pnpm typecheck`。** 5种场景全部有可复现确定性结果；真实模型仍未调用。
- [ ] **Step 6：审核并提交 `test(acceptance): add deterministic combined-source evaluation`。**

### Task 7：一次 opt-in 真实模型/后端/LangSmith 联合验收

**Files:**

- Create: `src/acceptance/real-model-runner.ts`, `src/acceptance/langsmith-verifier.ts`。
- Create: `apps/acceptance/real-model.mjs`。
- Create: `apps/acceptance/review.mjs`。
- Modify: `src/acceptance/index.ts`, `src/index.ts`, `package.json`。
- Create: `docs/guides/real-model-langsmith-acceptance.md`。
- Modify: `docs/README.md`, `docs/implementation-status.md`, `docs/architecture/08-observability.md`, `docs/architecture/10-reliability-and-evaluation.md`。
- Test: `test/real-model-acceptance-runner.test.ts`, `test/langsmith-verifier.test.ts`。
- Artifact: 忽略目录 `test-results/real-model-acceptance/`；不提交真实凭据/完整网络输出。

**Interfaces:**

- Consumes: Task 2 的 flush/modelIdentity，Task 4 config/exporter，Task 5预算/limiter，Task 6 snapshot/evaluator。
- Produces: `runRealModelAcceptance(options: RealModelAcceptanceOptions, dependencies?: RealModelAcceptanceDependencies): Promise<AcceptanceReport>`；创建自己的 Lab/Web，finally仅关闭自己创建的服务。
- Produces: `verifyLangSmithTrace(input: { client: Client; links: readonly TraceLink[]; snapshot: AcceptanceSnapshot }): Promise<TraceVerification>`；最多3次本次ID限定查询。

```ts
export interface RealModelAcceptanceOptions {
  authorization: 'explicit-smoke' | 'none';
  dataDirectory: string; workspaceRoot: string; artifactDirectory: string;
  modelConfig: CreateOpenAICompatibleModelOptions; modelIdentity: ModelIdentity;
  langSmithConfig: LangSmithEventConfig;
  lab: { elasticsearchUrl: string; prometheusUrl: string;
    labCursorSecret: string; evidenceCursorSecret: string };
  codeRevision: string; profileRevision: string;
}
export interface RealModelAcceptanceDependencies {
  startLab?: typeof startLogsLab; startWeb?: typeof startAgentWebRuntime;
  fetch?: typeof globalThis.fetch; now?: () => number;
}
```

CLI 从服务端 env 解析选项；不得接受浏览器传入 key/endpoint。测试注入 fake startLab/startWeb/fetch（LangSmith通过Task4的fetch seam测试），避免真实网络。库入口先检查authorization，不允许绕过CLI保护。所有可注入资源返回与既有starter相同的close契约。

- [ ] **Step 1：写 runner 的无授权/缺配置/后端未ready/快照过期失败测试。**

```ts
it('rejects an unauthorized smoke before starting the Lab', async () => {
  const startLab = vi.fn(async () => { throw new Error('MUST_NOT_START'); });
  const root = resolve(tmpdir(), 'agentops-acceptance-unit');
  const options: RealModelAcceptanceOptions = {
    authorization: 'none', dataDirectory: root, workspaceRoot: root,
    artifactDirectory: resolve(root, 'artifacts'),
    modelConfig: { baseUrl: 'https://model.example', apiKey: 'test-only-key', model: 'test' },
    modelIdentity: { provider: 'test', model: 'test' }, langSmithConfig: { enabled: false },
    lab: { elasticsearchUrl: 'http://127.0.0.1:19200', prometheusUrl: 'http://127.0.0.1:19290',
      labCursorSecret: 'test-only-lab-secret-0123456789012345',
      evidenceCursorSecret: 'test-only-evidence-secret-0123456789' },
    codeRevision: 'test-revision', profileRevision: 'simulation-v1',
  };
  await expect(runRealModelAcceptance(options, { startLab })).rejects.toThrow('SMOKE_NOT_AUTHORIZED');
  expect(startLab).not.toHaveBeenCalled();
});
```

此测试导入 `resolve`（node:path）、`tmpdir`（node:os）、Vitest和本项runner/types。CLI另用子进程测试清掉付费开关，预期固定 PRECHECK_*、model_http_sent=0且无父Run。fake Web统计POST /runs仅一次；query/close/LangSmith拒绝时仍写安全失败产物并关闭owned services。

另写 verifier 测试：父子远端 parent_run_id/trace_id正确，execution/invocation分别一个；缺终态/usage不匹配/查到其他Run/重复Span必须failed；404/403/网络不可用不能verified。用 fake Client 或本地 LangSmith server，不在 unit test 中读真实 Key。

- [ ] **Step 2：运行 `pnpm exec vitest run test/real-model-acceptance-runner.test.ts test/langsmith-verifier.test.ts`，确认 runner/verifier 缺失失败。**
- [ ] **Step 3：实现受限组装、preflight和唯一父请求。**

```ts
const budget = new SmokeRequestBudget(10);
const fetch = createBoundedSmokeFetch({ budget, fetch: dependencies?.fetch ?? globalThis.fetch,
  limit: 10, maxOutputTokens: 512, onAttempt: () => undefined });
const model = createOpenAICompatibleModel({ ...options.modelConfig, fetch });
const tracing = createLangSmithEventObservability(options.langSmithConfig);
const runtime = await startAgentWebRuntime({
  dataDirectory: options.dataDirectory, workspaceRoots: [options.workspaceRoot],
  model, modelIdentity: options.modelIdentity, sourceInvocationLimit: 1,
  metrics: { profileId: 'simulation', mcpUrl: lab.metricsMcpUrl },
  logs: { profileId: 'simulation', mcpUrl: lab.logsMcpUrl,
    cursorSecret: options.lab.evidenceCursorSecret },
  eventObservability: tracing.eventObservability, host: '127.0.0.1', port: 0,
});
const response = await globalThis.fetch(`${runtime.url}/runs`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: '请结合指标和日志巡检结算失败，证据不足时明确说明。',
    profileId: 'simulation', maxDurationMs: 90_000, maxToolCalls: 12 }),
});
```

`lab` 为 `startLogsLab({ initialScenario:'settlement_failure', ...本项options.lab的后端配置 })` 返回的对象；secret按不同用途映射。所有 readiness/config/path/snapshot 检查必须在POST前完成。固定 backend `19200/19290` 与现有 Lab端口；Web用port=0避免Windows排除端口，不结束占用者。snapshot剩余少于100秒直接precheck失败，不自动重建快照后再花钱。

以本地真实时钟轮询本次 runId（每500ms、最多90秒＋关闭余量）；终态后显式flush，读取公开父/子Run、证据与消息元数据。随后关闭宿主、用Task6 Reader读取自己的SQLite审计，得到reports/usage；trace links从本次exporter获取，远端只查这些ID。不开第二个browser诊断Run。

LangSmith verifier 用SDK `readRun/listRuns` 的本次ID过滤和请求deadline，每次完整有限查询而非无界 AsyncIterable；最多3次、间隔1秒、全程最多10秒。remote canonical usage与本地V2唯一attempt集合对比；failed attempt的usage缺失必须partial，不能作为完整账单。

- [ ] **Step 4：新增 CLI 与命令，并写本地指南。**

```json
{
  "acceptance:real-model": "pnpm build && node apps/acceptance/real-model.mjs",
  "acceptance:review": "pnpm build && node apps/acceptance/review.mjs"
}
```

CLI 最先检查 `AGENTOPS_REAL_MODEL_SMOKE === '1'`，再解析配置并传 `authorization: 'explicit-smoke'`。指南说明Node24/pnpm shim、现有 `logs:backend:up`、两个独立secret、LangSmith key/project、模型key/模型名/provider、绝对测试目录；PowerShell隐藏输入只写提示“待输入”，不写真实密钥。未启用LangSmith时允许本地诊断产物，但verdict为review_required，不能报告远端闭环通过。

报告默认保存 `<dataDirectory>/acceptance/<runId>.json` 并另复制至显式仓库 artifact目录 `test-results/real-model-acceptance/`；CLI显式传入artifactDirectory绝对路径，不靠process.cwd推导。测试覆盖目录边界。HTTP/SDK异常输出固定码；不序列化options或异常对象。人工审核同一个持久化Run的最终消息，只记录decision/count，不把正文附入报告。

`review.mjs` 使用Node内置 `parseArgs` 读取 `--report <绝对JSON路径> --decision approved|rejected --unsupported-claims <非负整数>`，校验schemaVersion及报告结构，调用Task6 `applyManualReview`。批准必须count=0，拒绝不要求count>0；结果写入同目录新的 `<runId>.reviewed.json`，不覆盖原报告/原SQLite。脚本不读取模型/远端Key，不调用fetch。补测试：未知decision、负数、相对路径、不同schema、批准不能覆盖原失败或remote unavailable，以及fetch计数为0。

- [ ] **Step 5：先跑默认完整门和已有无付费 E2E。**

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm web:typecheck
pnpm web:build
pnpm e2e
```

确认自有Logs后端启动授权/端口后，单独设置 `AGENTOPS_REAL_LOGS_WEB=1` 跑 `pnpm logs:e2e`；该开关仍只使用脚本模型。停止仅自己启动的实验栈，禁止down -v。记录默认/E2E的实际结果，不把skip当pass。

- [ ] **Step 6：凭已明确的单次烟测授权运行真实联合验收。** 设置 `AGENTOPS_REAL_MODEL_SMOKE=1`，保留服务端模型配置，运行 `pnpm acceptance:real-model` 一次。运行前展示10请求/512输出token/90秒预算；不启动收费Judge，不自动retry整个run。失败保留安全产物，先定位，不执行第二次来刷通过。
- [ ] **Step 7：远端/本地/人工结果分别交付。** 记录实际sent/usage completeness、父子层级/证据可追溯、LangSmith远端核验和脱敏、最终消息人工复核。人工pending或远端unavailable时明确本项仍未最终验收；可以提交实现，但不能标Spec已全部闭环。
- [ ] **Step 8：同步知识库为实际状态，审核并提交 `feat(acceptance): close real-model and LangSmith verification loop`。** 提交不等于push；远端推送按用户后续请求执行，不包含ignored产物、secret或原有无关计划。

## 方案自审与覆盖矩阵

| Spec 要求 | 实施/验证位置 |
| --- | --- |
| Node24/pnpm11＋Windows/Linux基线 | Task1测试、冻结安装、CI |
| event-only注入、旧端口兼容、唯一flush所有者 | Task2运行时/亲子兼容测试 |
| 执行段/包装/attempt去重、取消暂停恢复终态 | Task3生命周期测试 |
| 无原文/提示词/地址/Key，canonical usage不造零 | Task3投影canary＋Task4 HTTP体/usage测试 |
| 队列/网络/flush有界与可见诊断 | Task4假时钟/本地HTTP/故障隔离 |
| 父子/重试共享10次、每次512、每来源一次 | Task5并发/管线测试＋Task7实际ledger |
| 5个无费用fixture、事实/引用/缺失/窗口 | Task6纯评测＋脚本集成 |
| 真实snapshot freshness、单次Run、远端有限查询 | Task7 preflight/runner/verifier |
| 自然语言人工复核与review_required | Task6 verdict测试＋Task7人工结果 |
| 只读/契约兼容/不改业务/未来生产缺口不混入 | 全局约束、回归与Spec非目标 |

## 完成判据与交接

先交付可审核实现和默认质量门，再交付一次真实烟测证据。只有自动硬检查、远端核验、人工复核全部通过，才把本轮标为passed；未执行项逐项写明。不要把工具链/观测/评测完成描述为真实业务系统上线完成。

下一阶段另写 `group-buy-market` 只读预生产数据接入 Spec，定义真实counter/日志的语义、最小凭证、业务金标准与数据新鲜度；不在本计划中顺手实现鉴权、生产队列或动作系统。
