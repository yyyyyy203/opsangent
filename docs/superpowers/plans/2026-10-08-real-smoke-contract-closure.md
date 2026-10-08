# 真实烟测跨层契约修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复已经离线复现的指标时间窗丢失、Logs 报告预算门槛不一致和 Source Trace 事件归属错误，并让下一次远端失败能够定位到明确阶段，而不是再次消耗模型额度猜测。

**Architecture:** 保留既有 Harness、Source Collector、V2 Publisher、SQLite 和摘要/引用边界；修复公开投影和验收适配器之间的契约。确定性回归、独立 LangSmith 探针、真实模型烟测分开运行，前一层失败时不进入下一层。

**Tech Stack:** TypeScript、仓库既有 Node.js 24 / pnpm 11.19.0、Vitest、better-sqlite3、已安装 OpenAI/LangSmith SDK；不升级依赖。

**Spec:** [真实模型联合验收与 LangSmith 观测闭环设计](../specs/2026-10-04-real-model-langsmith-acceptance-design.md)，尤其 §4–9；本计划 §2 是待审核的明确修订，不把与旧 Spec 冲突的行为偷偷作为普通实现。

**Status:** 2026-10-08 离线实现与质量门已完成（Tasks 1–6，详见 `.superpowers/sdd/2026-10-08-real-smoke-contract-closure/progress.md`）。真实 Trace 探针、真实模型、生产数据和人工复核仍未运行；不得将离线通过描述为历史远端 HTTP 422 已解决或生产验收通过。

## 1. Global Constraints

- 保留当前工作树全部 modified/untracked 文件；不覆盖无关改动，不自动 commit/push。
- 不修改 Harness 主循环、HITL、动作权限、ToolResponse、MessageBlock、SQLite Schema、V1/V2 事件生产者的已有归属语义。
- 证据页面继续只展示摘要与引用，`retrievable=false` 不变，不暴露原始数据。
- 一个父 Run、每个来源最多一个 child；模型 HTTP 最多 10 次；查询轮 512、报告/汇总轮 1024；共享输出预留上限 5120；父 90 秒、子 30 秒。
- `finishReason=length` 仍是失败；不执行残缺参数，不因输出截断自动重试，不新增隐藏 fallback 或第二个 Run。
- 缺失 usage 不补零，失败/缺失尝试的 Run 用量仍为 partial；远端核验成功不等于诊断成功。
- LangSmith 仍仅上传白名单元数据；队列 256、ingest 1 MiB、batch 64 KiB/32 操作、并发 1、SDK 重试 0。拒绝附件、原文、地址、凭据、请求/响应正文及错误堆栈。
- 默认测试全部离线；远端探针和真实模型烟测分别显式 opt-in，均不自动重跑。
- 时间、ID、外部调用与计时器使用现有注入方式；不得以 process.cwd() 决定业务路径。

## 2. 定位证据与待审核决策

### 2.1 确认的事实

定位 Run：`1945f0ac-45c5-4fca-99eb-b39efd59d04b`。报告记录的源码 SHA-256 与当前源码一致：
`66629ed54be27d0297c4ead1cb46759c53ee549d5dd31581a3311cb0d6e7b041`。

1. Logs 完成 capture 和 search 后，第三次调用被现有策略分配 512 tokens；实际输出 512，finishReason=length。100 条日志采集完整，总输出预算尚余 2813。失败内容未持久化，不能断言第三轮究竟在写报告还是生成其他内容。
2. 指标摘要与日志 manifest 的窗口均为 2026-10-08T01:11:15.000Z 至 01:16:15.000Z。公开指标视图没有 timeRange。仅在离线内存中补回该字段，SOURCE_WINDOW_VALID 从 false 变 true，SCENARIO_OUTCOME_VALID 仍为 false。
3. 真实 Source 生命周期事件的 runId 是 childRunId。Verifier 要求 parentRunId，触发 INVALID_SOURCE_INVOCATION 并在远端查询前返回 failed/0。仅离线规范化事件归属后返回 unavailable/0，证明当前失败不能解释为远端没有 Span。
4. 报告只记录一次 TRACE_REQUEST_TIMEOUT，无法判断是 info、batch、multipart 还是响应体读取超时；旧 HTTP 422 的具体原因也没有被远端诊断证实。

### 2.2 必须先写入 Spec 的 ADR

- **报告预算资格不等于证据充分性。** Logs 成功 capture 后，取得同一 evidenceId 的成功 search 或 read-slice 即可进入报告预算；aggregate 是可选补充，不再是提升 cap 的强制前提。失败、空引用、不同快照仍不得提升。Collector 的事实校验、missingEvidence、partial 和验收硬门禁不放宽。
- **保留实际 Source 事件归属。** Verifier 按 childRunId、parentRunId、父 toolCallId 建立关系；不修改生产者。旧父 Run 归属仅作为显式兼容分支，必须匹配同一 Run 树和调用，不能任意放行。
- **有界验收超时独立于运行默认值。** 默认 exporter 保留 request=1000ms / flush=2000ms；独立探针和显式 smoke 使用 request=10000ms / flush=15000ms。三处 SDK/外层 fetch/审计 transport 同源注入，不能遗漏内层固定 1 秒。这是有界验收配置，不宣称延长超时已经修复远端协议。
- **本地安全诊断可选扩展。** 验收 JSON 保持 schemaVersion=2，新增可选 diagnostics，旧报告可读；既有 checks/verdict 语义不变。更新严格读端/人工复核校验。诊断不进入 V2 事件或模型上下文。

## 3. 任务依赖与文件边界

```text
Task 1 指标公开投影 ─┐
Task 2 Logs 预算策略 ├─> Task 5 真实 Runtime 离线联合回归 ─> Task 6 分级验收
Task 3 Trace 校验器 ┤
Task 4 上传诊断/探针 ┘
```

Task 1–3 可分开实施和审查；Task 2/3 若增加报告诊断字段，必须与 Task 4 的共享类型先协调。禁止并行改写同一个 types/evaluator/runner 文件。

## Task 1: 修复指标证据的公开时间窗投影

**Files:** Modify `src/contracts/read-model.ts`；Test `test/inspection-query-sqlite.test.ts`、`test/inspection-query.test.ts`、`test/acceptance-reader.test.ts`、`test/acceptance-evaluator.test.ts`。

**Interfaces:** 保持 `publicEvidenceFromRecord(record: EvidenceRecord): PublicEvidenceView`；使用已有可选 `PublicEvidenceView.timeRange`，不向 EvidenceRecord/SQLite 添加必填字段。

- [ ] 在现有公开投影测试加入失败断言；记录必须包含 summary.start/end 的 Unix 秒，不能直接构造已填好 timeRange 的 PublicEvidenceView：

```ts
const record: EvidenceRecord = {
  evidenceId: 'metric-window-1', runId: 'metrics-child', source: 'metric',
  summary: { start: 1791421875, end: 1791422175 },
  raw: { privateCanary: 'RAW_MUST_NOT_LEAK' }, businessTraceIds: [],
  capturedAt: '2026-10-08T01:16:15.000Z',
};
const view = publicEvidenceFromRecord(record);
expect(view.timeRange).toEqual({
  start: '2026-10-08T01:11:15.000Z', end: '2026-10-08T01:16:15.000Z',
});
expect(view.retrievable).toBe(false);
expect(JSON.stringify(view)).not.toContain('RAW_MUST_NOT_LEAK');
```

- [ ] 跑 `pnpm exec vitest run test/inspection-query.test.ts test/inspection-query-sqlite.test.ts test/acceptance-reader.test.ts test/acceptance-evaluator.test.ts`，先记录缺失 timeRange 的 RED。
- [ ] 实现仅针对 metric.summary.start/end 的确定性转换：两者必须是非负安全整数、start<end、换算 Date 有效；输出 toISOString()。无效/旧记录省略可选字段，不从 capturedAt/raw 猜测窗口。
- [ ] 测试负数、NaN、Infinity、超 Date 范围、字符串、缺字段、反向/相等窗口；非 metric 不推断。SQLite save → query → acceptance-reader 必须保留相同窗口，真实错窗仍失败。
- [ ] 重跑上述命令；单独审查 diff。交付标准：修复公开投影，不能通过修改 sameWindow 或跳过 SOURCE_WINDOW_VALID 换通过。

## Task 2: 对齐 Logs 报告预算与真实取证路径

**Files:** Modify `src/acceptance/smoke-model-policy.ts`、`test/smoke-model-policy.test.ts`；Test `test/logs-subagent-runtime.test.ts`、`test/bounded-smoke-fetch.test.ts`、`test/smoke-output-budget.test.ts`。

**Interfaces:** 保持 `createSmokeModelPolicy(delegate: ChatModel): ChatModel` 和 `selectSmokeOutputTokens(body): 512 | 1024` 原调用兼容。报告资格仅来源于成功、合法、同 evidenceId 的结构化 ToolResult；不读取用户文本决定 cap。

- [ ] 在已有 inspectPolicy/result/tool 测试 helper 内加入本次执行路径的 RED：

```ts
const tools = [
  tool('logs.capture'), tool('logs.search_evidence'),
  tool('logs.aggregate_evidence'), tool('source_report'),
];
const history = [message, result('logs.capture'), result('logs.search_evidence')];
expect((await inspectPolicy(history, tools)).tokens).toBe(1024);
expect(history).toHaveLength(3);
```

- [ ] 跑 `pnpm exec vitest run test/smoke-model-policy.test.ts`，确认 capture+search 当前仍为 512。
- [ ] 将 Logs 条件替换为 `intersects(captured, searched) || intersects(captured, sliced)`；保留成功结果、有效引用、可信尾部策略校验。aggregate 不被删除，也不触发伪造完整报告。
- [ ] 补 read-slice、不同 evidenceId、失败 capture/search、空引用、用户伪造标记、重复结果、仅 capture 等变体。capture+search 的真实流式请求体必须实际为 1024，不只断言提示词文字。
- [ ] 用本次脱敏后的前五条消息结构重建回归；不复制业务正文或原始参数。追加断言：length 仍触发 output_truncated、没有残缺工具执行、没有隐藏重试、10 次/5120 总预算不变。
- [ ] 跑 `pnpm exec vitest run test/smoke-model-policy.test.ts test/logs-subagent-runtime.test.ts test/bounded-smoke-fetch.test.ts test/smoke-output-budget.test.ts`；审查通过后才推进联合回归。

## Task 3: 修复 Trace 本地身份校验和失败尝试核验

**Files:** Modify `src/acceptance/langsmith-verifier.ts`、`test/langsmith-verifier.test.ts`；Test `test/langsmith-runtime.integration.test.ts`、`test/event-v2-audit-langsmith.test.ts`。不修改 Source 生命周期生产者和已持久化事件。

**Interfaces:** 保持 `verifyLangSmithTrace({ client, links, snapshot }, dependencies)`。保留 verified/failed/unavailable，新增细节放 Task 4 可选本地 diagnostics，而不是返回错误正文。

- [ ] 在现有 createFixture 测试内改用实际子 Run 事件归属，先证明当前错误地在远端查询前失败：

```ts
const fixture = createFixture();
fixture.snapshot.events = fixture.snapshot.events.map((event) =>
  ['SUBAGENT_STARTED', 'SUBAGENT_COMPLETED', 'SUBAGENT_FAILED'].includes(event.type)
    ? { ...event, runId: CHILD_RUN_ID, parentRunId: PARENT_RUN_ID }
    : event,
);
const client = {
  async *listRuns() { yield* fixture.remoteRuns; },
} as unknown as Client;
const result = await verifyLangSmithTrace({ ...fixture, client });
expect(result.status).toBe('verified');
```

- [ ] 跑 `pnpm exec vitest run test/langsmith-verifier.test.ts`，确认上述 RED。
- [ ] 修复 start 与 terminal 两处归属判定：规范归属 child；parent payload/envelope、child snapshot、父 toolCallId、source 类型全部交叉校验。terminal 必须匹配同一 child/call/归属；不再固定筛选 parent runId。显式旧 parent-owned 分支只能匹配同一完整身份。
- [ ] 保留 wrapper stream 与 child execution stream 的区别。重复 start/terminal、跨父 Run、跨 callId、错误子 Run、缺 Tool start、错误 remote parent/traceId 必须失败，不对未知关系静默规范化。
- [ ] 失败 ModelAttempt 保留其合法可选 usage/finishReason；远端失败状态与成功状态分别比较。已知失败 usage 可以一致核验；缺失仍 unavailable，不补零。即便 Trace verified，含子 Run 失败的 SCENARIO_OUTCOME_VALID 仍 false。
- [ ] 补 fake Client 查询次数断言：本地身份无效为 0；合法本地树可以进入远端查询；远端缺 Span 只能 unavailable。核验失败的机器码不再被含混解释成“没有远端 Span”。
- [ ] 跑 `pnpm exec vitest run test/langsmith-verifier.test.ts test/langsmith-runtime.integration.test.ts test/event-v2-audit-langsmith.test.ts`；审查身份、终态和 usage 三组断言。

## Task 4: 安全诊断、统一验收超时与独立 Trace 探针

**Files:** Create `src/observability/langsmith-export-policy.ts`、`src/acceptance/diagnostics.ts`、`src/acceptance/langsmith-trace-probe.ts`、`apps/acceptance/trace-probe.mjs`、`test/acceptance-diagnostics.test.ts`、`test/langsmith-trace-probe.test.ts`。

Modify `src/bootstrap/langsmith.ts`、`src/acceptance/langsmith-export-transport.ts`、`src/acceptance/real-model-runner.ts`、`src/acceptance/types.ts`、`src/acceptance/evaluator.ts`、`src/acceptance/smoke-model-policy.ts`、`src/acceptance/index.ts`、`apps/acceptance/review.mjs`、`package.json`。Test `test/langsmith-config.test.ts`、`test/langsmith-export-transport.test.ts`、`test/langsmith-export-multipart.integration.test.ts`、`test/langsmith-observability.test.ts`、`test/acceptance-review-cli.test.ts`。

**Interfaces / 新增决策：**

```ts
export interface LangSmithExportLimits {
  readonly requestTimeoutMs: number;
  readonly flushTimeoutMs: number;
}
export const DEFAULT_LANGSMITH_EXPORT_LIMITS = {
  requestTimeoutMs: 1000, flushTimeoutMs: 2000,
} as const;
export const ACCEPTANCE_LANGSMITH_EXPORT_LIMITS = {
  requestTimeoutMs: 10000, flushTimeoutMs: 15000,
} as const;

export interface SmokeModelDecision {
  readonly runId: string;
  readonly stepId: string;
  readonly streamId?: string;
  readonly phase: 'query' | 'report' | 'summary';
  readonly maxOutputTokens: 512 | 1024;
}
export interface TraceRequestDiagnostic {
  readonly route: 'info' | 'batch' | 'multipart';
  readonly phase: 'audit' | 'send' | 'headers' | 'body' | 'complete';
  readonly outcome: 'ok' | 'local_reject' | 'http_error' | 'timeout' | 'aborted' | 'network_error';
  readonly elapsedMs: number;
  readonly httpStatus?: number;
}
export interface TraceVerificationDiagnostic {
  readonly phase: 'local_snapshot' | 'local_links' | 'remote_query' | 'remote_compare' | 'complete';
  readonly reason: 'verified' | 'invalid_local_tree' | 'invalid_source_invocation'
    | 'missing_link' | 'invalid_link' | 'remote_unavailable' | 'remote_mismatch'
    | 'usage_unavailable' | 'usage_mismatch';
  readonly remoteQueriesSent: number;
}
export interface AcceptanceDiagnostics {
  readonly modelDecisions: readonly SmokeModelDecision[];
  readonly traceRequests: readonly TraceRequestDiagnostic[];
  readonly traceVerification?: TraceVerificationDiagnostic;
}
```

AcceptanceInput/AcceptanceReport 增加可选 `diagnostics?: AcceptanceDiagnostics`；现有 ExportDiagnostics 计数结构保持不变。每次采样上限分别为 16 model decisions、64 trace requests；超限不保留正文，记录 dropped 计数。ID 沿用既有合法标识规则，所有数值校验有限非负安全整数。

- [ ] 先写 RED：旧 V2 报告没有 diagnostics 仍可读；新字段经过白名单保存和 review 后不会丢失；超界/未知字段/凭据 canary 拒绝；不修改原报告、不将失败人工复核成通过。
- [ ] 给 createSmokeModelPolicy 增加可选第二参数 `{ onDecision?: (value: SmokeModelDecision) => void }`。从已有 ModelCallOptions 获取 runId/stepId/streamId，在 delegate 前记录固定 phase/cap，不保存消息和参数。Verifier 增加可选依赖 `onDiagnostic?: (value: TraceVerificationDiagnostic) => void`；本地失败记录 remoteQueriesSent=0。
- [ ] bootstrap dependencies 与 audited-fetch 可选 options 接收同一 LangSmithExportLimits。使用注入的单调 now 计耗时；外层、审计前后、SDK timeout 均遵循同一限额。Abort 原因区分用户取消、request deadline、flush deadline；清理 socket/body/timer/listener，禁止只延长外层而保留内层 1000ms。
- [ ] 用 fake timer + delayed fake fetch 证明：默认 1000ms 仍超时；acceptance 配置下 1500ms 请求成功；慢 headers、慢 body、无穷流、用户 Abort、flush 超时均有界。HTTP 401/403/422/429/5xx 分别保留 route/phase/status，不保存远端正文，不自动重试。
- [ ] 新增 `pnpm acceptance:trace-probe`，脚本仅接受显式 `AGENTOPS_TRACE_PROBE=1` 和 LangSmith 配置，不要求 DeepSeek 配置，不启动 Lab/MCP/Agent 诊断。通过生产 exporter 创建两个 synthetic Span，known usage 为 input=12/output=5/cache=4：

```ts
const root = exporter.eventObservability.startSpan({
  name: 'agent.run', kind: 'chain', runId: probeRunId,
  spanKey: 'trace-probe-root', input: { profile: 'simulation' },
});
const child = exporter.eventObservability.startSpan({
  name: 'model.trace-probe', kind: 'llm', runId: probeRunId,
  spanKey: 'trace-probe-model', parentSpanKey: 'trace-probe-root',
  input: { purpose: 'inspection' },
  attributes: { provider: 'test-provider', model: 'trace-probe' },
});
child.end({ status: 'completed', usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 4 } });
root.end({ status: 'completed' });
await exporter.eventObservability.flush();
```

由 probe 函数的 ID 依赖生成 probeRunId；使用既有 getTraceLinks 得到远端 ID，回查仅限定两个 ID，最多 3 次查询，探针整体 30000ms。核验父子、traceId、终态和 usage，不调用需要 Source Run 树的 verifier 冒充完整 Agent 验收。

- [ ] 探针缺配置必须在发请求前失败；固定失败码包含 TRACE_PROBE_UPLOAD_FAILED / TRACE_PROBE_QUERY_UNAVAILABLE / TRACE_PROBE_MISMATCH / TRACE_PROBE_DEADLINE。遇 422/超时保留安全诊断立即停止；不能切 endpoint 或 bypass 审计，不能自动启动真实模型。
- [ ] 真实模型 runner 在 Lab/模型请求前执行相同探针准入；探针失败时 modelRequestsSent=0、parentRunCreated=false。由用户直接运行独立探针也可诊断，但不能复用陈旧通过报告绕过当前运行预检。
- [ ] 跑 `pnpm exec vitest run test/acceptance-diagnostics.test.ts test/langsmith-trace-probe.test.ts test/langsmith-config.test.ts test/langsmith-export-transport.test.ts test/langsmith-export-multipart.integration.test.ts test/langsmith-observability.test.ts test/acceptance-review-cli.test.ts test/real-model-acceptance-runner.test.ts`。

## Task 5: 用真实生产者和读模型完成离线联合回归

**Files:** Create `test/acceptance-runtime-contract.integration.test.ts`；Modify `test/langsmith-runtime.integration.test.ts`、`test/real-model-acceptance-runner.test.ts`。只用临时 SQLite、fake MCP/HTTP、ScriptedModel 和本地 fake LangSmith，禁止外部网络。

**Interfaces:** 消费现有 startAgentWebRuntime、Source Tool Adapter、EventFactory/Publisher、readAcceptanceSnapshot、evaluateAcceptance、verifyLangSmithTrace；不得自己手填 timeRange 或伪造 SUBAGENT 事件来绕过生产链。

- [ ] 将真实 Logs 顺序固定为 capture → search → source_report → 简短结束；Metrics 走真实 collector/report。从 SQLite 回读公开证据和事件，用同一批生产事件驱动 exporter，再用 fake remote readback 检查 trace。
- [ ] 正常用例精确断言：指标公开 timeRange 等于 Lab 窗口，Logs 报告轮 cap=1024，所有预期子 Run completed，全部硬检查 true，trace verified，manualReview pending，最终 verdict=review_required。
- [ ] 失败用例注入 length+usage512，断言 child failed、partial 报告明确 source_report/child_run_failed、SCENARIO_OUTCOME_VALID=false、已知 token 计入小计、usage partial、不自动重跑。时间窗修复不能顺便把该失败改成成功。
- [ ] 分别注入错窗、不同 evidenceId、跨父 Run、重复生命周期、缺 Span、usage mismatch、export 422、request/body/flush timeout；每个只改变一个变量，断言不同阶段和机器码，不止断言退出码。
- [ ] 跑 `pnpm exec vitest run test/acceptance-runtime-contract.integration.test.ts test/langsmith-runtime.integration.test.ts test/real-model-acceptance-runner.test.ts`；核实 fake fetch 明确阻断非本地网络。

## Task 6: 质量门、远端准入和收口记录

**Files:** Modify `docs/superpowers/specs/2026-10-04-real-model-langsmith-acceptance-design.md`、`docs/guides/real-model-langsmith-acceptance.md`、`docs/implementation-status.md`；Create `docs/verification/2026-10-08-real-smoke-contract-closure.md`。

- [ ] Spec 先记录 §2.2 ADR；指南注明 trace-probe 不调用模型、过探针仍不代表完整验收通过。历史两轮记录保留，追加真实失败及本轮边界，不重写为已成功。
- [ ] 使用仓库声明工具链运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build`。逐条记录新鲜结果，未运行的 opt-in 明确 not_run。
- [ ] 独立审查契约兼容、隐私 canary、失败关闭、监听器/计时器清理；报告 optional 字段旧读兼容，原始证据仍不可公开取回。
- [ ] 凭据仅来自当前进程的安全输入；不读取聊天密钥、终端历史或无关配置。真实探针需独立显式授权；上传/回查任一失败，停止在该层，模型请求保持 0。
- [ ] 探针通过且用户批准真实模型烟测后，仅执行一次 settlement_failure；不再为浏览器截图创建 Run，不自动重跑失败。保持模型 HTTP 10 次、输出预留 5120。
- [ ] 通过条件逐项写入记录：无 output_truncated、全部预期 Run 正常完成、窗口与归属正确、usage 可核验、远端父子/终态/usage verified、公开边界安全。人工复核前仅 review_required；approved 且无无根据断言后才能 passed。
- [ ] 每个已审查任务形成独立可提交 diff；只有用户明确要求提交/推送时，才精确暂存本轮文件并 commit/push，禁止顺手包含其他未提交改动。

## 4. 停止条件与剩余风险

- 离线通过不是远端通过；远端 Trace 探针通过不是生产业务通过。
- 1024 tokens 是 cap，不是成功保证。再次出现 length 必须查看已记录 phase/cap/usage；先判断内容预算或协议，不继续提额或自动重跑。
- 422 再现时依据 route/phase/status 定位，仍未明确服务端拒绝字段时保持 unresolved。不得绕过隐私审计、无限重试或无证据更换 SDK/供应商。
- 超时延长只能排除不合理验收截止时间，不能证明网络/账号/服务协议正常。探针无法通过时模型验收保持 blocked/not_run。
- 当前方案不接入真实 group-buy-market，不添加动作能力，不承诺生产可上线。

## 5. 计划自审

- 已定位缺陷：Task 1/2/3 分别覆盖；上传不确定性：Task 4 独立验证；跨层夹具盲区：Task 5；验收与文档：Task 6。
- 与旧 Spec 冲突的两项行为（Logs gate、验收超时）在 §2.2 显式声明，实施前更新 ADR。
- 无数据库迁移、无生产事件重命名/改归属、无 raw 接口放开；可选本地报告字段由严格读端同步适配。
- 未把“已有报告 failed”改成 passed，也未把远端未查询解释为没有 Span。
- 按任务执行 RED→GREEN→负向回归→审查；Task 5/6 未通过前不得宣布整轮修复完成。
