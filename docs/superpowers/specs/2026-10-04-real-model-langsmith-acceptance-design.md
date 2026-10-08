# 真实模型联合验收与 LangSmith 观测闭环设计

日期：2026-10-04

状态：已批准实施；2026-10-07 补充失败诊断、上传协议兼容和共享输出预算；2026-10-08 补充 multipart wire 格式、同窗取证、证据驱动预算策略及报告可信度门禁。实施与真实验收结果分别记录，不表示生产可上线。

代码基线：`codex/event-message-v2`，`c8e15201f62e29109beec8cb5fba55075e83a20d`。

实施计划：[逐任务计划](../plans/2026-10-04-real-model-langsmith-acceptance.md)。

## 1. 本轮目标与边界

在已完成的只读 Metrics＋Logs Web 链路上，补齐三个相互依赖的交付物：受支持的工具链、由 V2 事件驱动的安全 LangSmith 导出、可复现且低费用的联合验收。

本轮验收目标是：固定模拟遥测 → 真实 Prometheus/Elasticsearch → 只读 MCP → Metrics/Logs 子 Agent → 父 Agent → Web 摘要/引用 → LangSmith 执行链与 token 统计。

**真实后端不等于真实业务数据。** 本轮仍使用 `simulation/checkout` Profile，不接入或修改 `D:\xfg\group-buy-market`，不宣称完成生产根因诊断或真实保护动作。

非目标：公网访问、鉴权/RBAC、多租户、生产调度队列、Trace 数据源、发布变更、自动降级/熔断、真实写工具、长期经验晋级、远端 LangSmith 历史回填、付费 LLM-as-judge。证据页面继续只展示摘要与引用，`retrievable=false` 不变。

## 2. 已核实的现状

| 位置 | 代码现状 | 本轮处理 |
| --- | --- | --- |
| `package.json` | Node `>=20`、pnpm `11.19.0`；Node 类型为 20 系列 | 明确记录工具链升级决策 |
| `src/bootstrap/agent-web-runtime.ts` | 本地只读宿主支持 Metrics＋Logs；可注入 `observability` | 增加事件专用观测端口，保留原有端口 |
| `apps/agent-server/index.mjs` | 没有组装 LangSmith，环境变量存在不代表导出启用 | 加显式配置与组装 |
| `src/application/create-runtime.ts` | 同一个观测实现同时注入 Harness、Tool/重试观察器和 V2 Projector | 新宿主只让 V2 侧导出，避免重复 Span |
| `src/event/projectors/langsmith-projector.ts` | 子工具生命周期和子 Run 都使用 `run:<childRunId>`；缺暂停/取消/超时处理 | 区分调用包装与实际执行段，补完整终态 |
| `src/observability/langsmith-observability.ts` | pending 无上限，flush 无截止时间；异步清理可能产生未处理 rejection | 有界、非阻塞、安全导出 |
| `src/bootstrap/shared-source-child.ts` | 子模型事件默认使用 `configured` 标识 | 显式传递模型身份，不猜测供应商 |
| `test/fixtures/bounded-smoke-fetch.ts` | 已有 10 请求/512 token 使用示例，但仅是测试辅助 | 复用其机制并增加可核验的共享计数 |
| 现有 Logs E2E | 真实 ES/Prometheus、脚本模型；并非真实模型联合验收 | 保留回归，再增加独立 opt-in 烟测 |

基线测试曾通过，不替代本轮实施后的重新验证。已有未提交计划改动不属于本方案，不覆盖、不暂存。

## 3. 决策：先收口现有链路，再接业务系统

选择“小规模联合验收＋观测闭环”。相比立即接业务系统，这能先验证现有模型编排、证据归属和审计是否可信；相比建设完整评测平台，它不引入新的数据库、评测服务或 Judge 模型。

本轮仅使用现有 SQLite、V2 事件、SourceSubagentResult 和公开读模型。评测产物是本地受控 JSON，不新增生产 HTTP 契约。

### ADR：工具链基线

- 提案基线：Node.js 24 LTS，`engines.node = ">=24.0.0 <25.0.0"`，`.node-version = 24`。
- 保留 `packageManager = "pnpm@11.19.0"`，不顺手升级所有依赖。
- `@types/node` 改为 24 系列，实施时解析并锁定一个精确版本；更新 lockfile。
- 同步修改 `AGENTS.md` 的技术栈声明和当前启动指南；历史 Spec 的 Node 20 描述保留历史语义，不做全仓机械替换。
- 冻结安装需验证 `better-sqlite3` 和 `esbuild` 的本地构建许可；CI 覆盖 Windows/Linux。
- 这是对现有 Node 20 约定的明确修改提案。用户审核方案后才能实施，不在规划期间安装运行时。

依据：[Node 支持周期](https://nodejs.org/en/about/previous-releases)、[pnpm 兼容矩阵](https://pnpm.io/installation#compatibility)。截至本次查证，Node 20 已 EOL，pnpm 11 不支持 Node 20。

## 4. 分层与兼容性

```text
模型 / Tool / 子 Agent
  → 既有 V2 Publisher + Store
    → LangSmithEventProjectorV2（执行元数据投影）
      → Observability（稳定端口）
        → 有界 LangSmith Adapter（SDK / HTTPS）

Smoke runner → 同一个受限 model fetch → 父/子模型与重试
Smoke runner → 本地 V2/公开读模型 → 确定性检查 → 本地验收 JSON
```

不修改 ReAct 主循环、工具安全管线、V1 Generator 输出、已发布事件既有字段语义、MessageBlock/ToolResponse、SQLite Schema 或证据接口语义。

### ADR：2026-10-07 烟测失败元数据兼容修订

用户已批准失败诊断修复：`MODEL_CALL_FAILED` 新增可选 `usage` / `finishReason`，沿用既有 `error.details.category` 保留白名单模型错误类别。缺失字段不填零，旧 V2 事件仍可解析，无需 SQLite 表迁移。读端应先部署支持可选字段的新 Schema；严格旧读端不得假定永远没有新增字段。失败用量按 Run/attempt 去重，与已成功用量形成已知小计，任何失败或缺失尝试仍明确标记 partial。截断依然是失败，不修补残缺参数执行，不自动 fallback。报告新增可选检查状态/安全失败摘要，不删除 `passed` 或改变原字段含义。

新增可选 `AgentRuntimeOptions.eventObservability?: Observability`；选择规则是 `eventObservability ?? observability ?? Noop`。原 `observability` 仍服务旧注入路径，兼容已有宿主和测试；默认行为不被偷偷切换。新 Web/CLI 把真实 LangSmith 只注入 `eventObservability`，直接 Harness/Tool 观测仍为 Noop。

根 Runtime 是事件导出的唯一所有者；共享 `sharedEvents` 的子 Runtime 不注册第二个导出器，不负责父导出器 flush。根 Runtime 增加 `flushEventObservability(): Promise<void>`；Web 返回对象提供同名方法。运行中可显式 flush，关闭时兜底 flush，均受 Adapter 的时间上限约束。启动 replay 继续只修复本地投影，不自动重发历史 trace。

模型身份使用宿主传入的 `modelIdentity?: { provider: string; model: string }`。同一模型实例被父子共用时传递同一身份；独立 `childModel` 可以提供独立 `modelIdentity`，未提供时保持 `configured`，不得冒充父模型。身份仅用于已有模型事件字段，不包含 URL 或 Key。

## 5. Span 身份、层级与生命周期

必须区分两个真实语义：一次来源工具调用，以及它内部的一段子 Harness 执行。它们不是同一个 Span。

```text
父执行段 run:<runId>:<streamId>
  ├─ 父 model attempt
  └─ 父 tool attempt（metrics_subagent / logs_subagent）
       └─ source invocation:<parentRunId>:<toolCallId>:<childRunId>
            └─ 子执行段 run:<childRunId>:<childStreamId>
                 ├─ 子 model attempt
                 └─ 子只读 tool attempt
```

- `RUN_STARTED`/`RUN_RESUMED` 创建执行段；有 streamId 时按 streamId 区分，缺失时使用内部 `initial` 标识。`RUN_RESUMED` 以 `newStreamId` 为权威。
- `SUBAGENT_STARTED` 创建来源调用包装 Span，登记父 Tool → childRun 的归属。其 streamId 可能来自父执行段，**不能**当成子执行段的 streamId。
- 子 `RUN_STARTED` 在来源包装下创建独立执行段，不覆盖包装句柄。重试的模型/Tool 按 attemptId 独立记录。
- 同一语义键重复 start 不重复发送；重复终态最多关闭一次。结束移除 active map；已关闭键在当前活跃执行组内有界记忆，执行组结束后释放。
- `RUN_FINISHED` 关闭为 completed；`RUN_FAILED` 关闭为 failed；`RUN_CANCELLED` 关闭为 cancelled；`RUN_TIMED_OUT` 关闭为 timed_out；`RUN_PAUSED` 关闭当前执行段为 paused。
- 执行段终态时清理仍在其下活跃的 model/tool Span，以结构化 incomplete/cancelled 状态结束，不能永久悬挂。来源包装由 `SUBAGENT_COMPLETED/FAILED` 结束；父终态兜底关闭未结束的包装。
- 暂停后恢复新建执行段，通过相同 agentRunId/新 streamId 关联。进程重启后不承诺恢复同一个远端 Span，也不承诺一个 trace 跨 Worker 永不分段。
- 缺失父 start 时记录安全诊断 `TRACE_PARENT_MISSING` 并创建标记 orphan 的执行段，不伪造父 Span，不改变 Run 状态。

远端 Span ID、trace ID 与本地 agentRunId/toolCallId 分开。它们也不是业务请求的 `businessTraceId`。本轮不接入分布式业务 Trace，不给被监测系统伪造 trace header。

## 6. 上传边界与 usage 映射

LangSmith 只接收白名单执行元数据：本地运行/步骤/调用/尝试 ID，合法固定名称，模型 provider/model，状态、耗时、TTFT、重试数、证据 ID 数组、coverage、缺失证据机器码和 token 数。

**不上传**：系统/用户完整提示词、模型正文或 thinking、Tool 参数、SourceReport 自由文本、原始日志/trace、脱敏样本、HTTP/MCP URL、SQLite/Blob 路径、Key/secret、错误 message/stack、运行时环境变量。不能直接透传 `RUN_STARTED.trigger`、`RUN_FINISHED.finalText` 或整个 event.payload。Adapter 二次 allowlist，避免旧观测调用者绕过 Projector。

供应商字段隔离在具体 LangSmith Adapter：

```ts
// 只有已知的 token 字段才发送；缺失不是 0。
metadata.ls_provider = provider;
metadata.ls_model_name = model;
outputs.usage_metadata = {
  input_tokens: usage.inputTokens,
  output_tokens: usage.outputTokens,
  // 两者都已知且安全整数相加时才有 total_tokens。
  total_tokens: usage.inputTokens + usage.outputTokens,
  // cachedInputTokens 已知时增加 input_token_details.cache_read。
};
```

已有本地 `usage` 字段仍保留。本地 V2 events 是用量权威，父＋子合并按唯一 Run/attempt 计数。失败或缺失 usage 保持 `partial/unavailable`，不估成零；缓存 token 是输入 token 的子集，不能再次加到总 token。不得据此声称精确人民币账单。远端标准字段依据 [LangSmith LLM trace 格式](https://docs.langchain.com/langsmith/log-llm-trace)。

## 7. LangSmith 组装与失败隔离

### 配置

沿用 `.env.example` 的 `LANGSMITH_TRACING`、`LANGSMITH_API_KEY`、`LANGSMITH_PROJECT`、`LANGSMITH_ENDPOINT`。

- 默认关闭；仅 `true`/`1` 显式开启。非法开关或启用时缺 Key/Project，启动阶段返回固定配置错误，不在首次 Run 中才报错。
- 默认 HTTPS `https://api.smith.langchain.com`。Endpoint 禁止 userinfo、query、fragment；远端只允许 HTTPS，loopback HTTP 仅用于显式测试注入。不会把不受信输入作为 Endpoint。
- 不输出 secret、Endpoint 全文或异常全文；禁用 SDK debug，禁用自动环境 metadata。
- 手工 `RunTree` 调用不会靠环境变量自动关闭：关闭时必须组装 Noop，不实例化真实 exporter。

### 有界行为

- 内部 pending 最多 256 个操作；SDK ingest 内存最多 1 MiB、batch 最多 64 KiB/32 操作、并发 1。
- 单次导出 HTTPS 超时 1,000 ms；SDK 自动重试为 0，不额外套自己的重试循环。
- `flush()` 总等待最多 2,000 ms；超时取消所属网络请求并清理定时器/监听器。仅 Promise.race 不算完成，不能留下悬挂 socket 或 rejection。
- Projector 只做同步转换与排队，不等待 HTTPS；取消、证据查询与主执行不因远端故障受阻。
- promise 的成功/失败都显式处理，再移除 pending；不得使用未消费的 `void promise.finally(...)` 链。
- 队列满时丢弃整个新 Span，不能留下只发送 end 的半 Span；记录 `TRACE_QUEUE_FULL`。网络失败/超时、映射丢弃、flush 超时分别计数，不吞成“已上报”。
- 诊断是本地计数快照/安全回调，不再作为 V2 event 递归导出。快照只含稳定码与数量，不含错误正文或请求数据。

这是 best-effort 外部观测；本地 V2/审计持久化继续是权威，不把 LangSmith 当成事务存储。参考 [手工 instrumentation](https://docs.langchain.com/langsmith/annotate-code)、[敏感输入输出控制](https://docs.langchain.com/langsmith/mask-inputs-outputs)。

## 8. 真实模型烟测预算

2026-10-07 上传审计修订：兼容 SDK 真实 `/info` 协商及 JSON batch、multipart、gzip；对 post/patch 主记录和 JSON 部分按 ID 重组后复用同一白名单。拒绝附件、未知/重复/孤立部分、敏感数据和解压后超过 1 MiB 的正文；仅去除 SDK runtime，再重建审计后的请求。禁止重定向，不伪造协商、不修改 SDK 私有字段。本地阻断计 `TRACE_LOCAL_AUDIT_REJECTED`，远端 HTTP 计 `TRACE_HTTP_ERROR`（兼容保留历史 `TRACE_NETWORK_ERROR` 聚合），真正网络异常仍计原网络码；不得把本地阻断说成远端 400。

新增独立 opt-in 命令 `pnpm acceptance:real-model`，默认 `pnpm test`/CI/现有 Playwright 不触发。必须设置 `AGENTOPS_REAL_MODEL_SMOKE=1`，准备合法 Key 和已有模型名；不自动切换供应商或开第二个 Run。

硬边界：**一个父 Run、最多一个 Metrics child 和一个 Logs child、实际发往模型的 HTTP 请求最多 10 次、查询轮输出最多 512 token、报告/汇总轮最多 1024 token、整次共享输出预留上限 5120 token、父 Run 最长 90 秒、子 Run 沿用当前最多 30 秒**。不创建独立压缩模型，不启用隐藏 fallback。若需 L2，其模型必须使用同一受限实例/ledger。

烟测专用模型装饰器根据结构化已完成 ToolResult 追加固定精简输出策略，不修改生产 Tool schema、主循环或来源 Collector。Metrics 取得指标后进入报告轮；Logs 取得聚合和搜索证据后进入报告轮；父 Run 收到两个来源结果后进入汇总轮。报告建议 summary ≤100 字、findings ≤3 条、每条 ≤80 字；父摘要 ≤250 字，保留 evidenceId 和 missingEvidence。它们是 smoke 提示约束，不把自然语言限长当作安全校验。

输出 ledger 与 HTTP 次数 ledger 分离，所有父子/重试共用。发送前原子预留本轮上限；余额不足在本地拒绝。只在响应完整结束且最终 usage 合法、可对应本次请求时结算并释放未用预留；Abort、网络故障、缺失或异常 usage 保留预留，不按零结算。上限不是人民币费用上限，不含输入 token 和供应商额外计费项。

Web bootstrap 增加可选 `sourceInvocationLimit?: 1`，仅 smoke runner 使用。宿主为本 Runtime 创建 limiter 并包装注册的两个来源 Tool 的 call；按 `runId + toolName` 在调用 child runner 前计数，第二次返回标准 `BUDGET_EXCEEDED` 失败。包装仍在统一 Tool 管线内，不更改 name/schema，不绕过 Guard/Hook。实例状态不放在模块顶层，关闭宿主后释放；正常 CLI 不启用这个 smoke 限制。

模型请求拦截器由同一个 closure/ledger 被父子和重试共享，在实际 fetch 前原子扣除名额；并发不能穿透。第 11 次或共享输出余额不足时，在本地返回安全 402，禁止网络发送。除 smoke 专用精简提示和输出上限外，不篡改其余模型语义；非 chat-completion 的模型调用在 smoke 模式拒绝，防止绕过预算。

分别记录 attempted/sent/rejected：解析失败/超限不算 sent，但不归还保守预留名额；SDK/模型重试的每次 HTTP 都计数。请求体上限沿用 1 MiB，过限/非法 JSON 只返回固定错误，不能回显输入。输出上限不能保证固定人民币费用，输入 token 与账户定价仍会影响账单。

Preflight 在付费调用前完成：工具链/构建、ES/Prometheus ready、MCP 能力、只读 Profile、模型与 LangSmith 配置、隔离绝对目录/端口、固定快照剩余有效期至少 100 秒。使用真实时钟，让 Lab 与宿主窗口一致，不用 frozen Clock 绕过现实 deadline。失败不创建模型请求，不重跑 Lab 或模型来掩盖失败。

只使用本轮新建的模拟快照与测试目录，不复用用户业务索引。脚本只关闭自己创建的 runtime/Lab；不停止用户进程，不删除旧索引，不做 Compose down -v。

## 9. 两层评测，禁止伪闭环

### 9.1 默认离线、确定性评测

新增 5 个 fixture：`normal`、`settlement_failure`、`low_sample`、`logs_offline`、`capture_window_mismatch`。它们使用脚本模型/假 HTTP，默认无外部网络费用。

自动检查：

1. 只调用注册的来源工具，父/子工具边界与调用次数符合预算。
2. 数值事实/阈值来自现有确定性 collector；低样本不判作已确认故障。
3. 来源窗口不匹配保持 partial/missingEvidence，不合并成同窗口确定根因。
4. Logs 离线时 Metrics 仍可返回；缺失来源显式记录，不伪造日志证据。
5. 父证据列表包含可追溯子证据；每个 finding 引用均属于所属来源/Run 树。
6. 公开页面/API/SSE/远端 export 不含 synthetic 原文、secret、地址 canary。
7. 终态/取消、暂停后恢复不重复执行已完成工具；usage 不重复累计。

失败场景还包括模型超时/Abort、预算耗尽和 LangSmith 离线。它们是上述 fixture 的变体测试，不增加付费用例。

### 9.2 一次真实模型联合烟测

仅对 `settlement_failure` 运行一遍真实模型＋真实后端。验收查询同一个父 Run 及其实际子 Run；浏览器观察已存在的 Run，不为截图再发起模型请求。远端读取限定本次创建的 Span IDs/trace IDs，最多 3 次有限查询；未查到不是通过。

本地验收 JSON 当前 schemaVersion=2：caseId、codeRevision、sourceFingerprint、profileRevision、runId/childRunIds、固定快照 ID、check codes/boolean/status、request ledger、usage/completeness、traceVerification、exportDiagnostics、manualReview、verdict。只保存必要数值和 ID，不保存 event/prompt/raw report/网络响应全文；产物存忽略目录 `test-results/real-model-acceptance/`。旧 schemaVersion=1 报告仍可读取；人工复核时升级到 v2，并将旧报告无法证明的 `SCENARIO_OUTCOME_VALID` 与 `SOURCE_FINGERPRINT_VALID` 标为 `not_run`，不能因人工批准而判为通过。

`traceVerification` 为 `verified | failed | unavailable`：有远端凭据且查询到正确层级/终态/usage 才是 verified。关闭 LangSmith 或无权限可以做本地验证，但本轮“LangSmith 闭环”仍未通过。

`manualReview` 为 `pending | approved | rejected`：由人查看本地已持久化最终消息，检查证据不足提示、推测措辞、无根据根因断言和结论可读性。默认 pending；不得用关键词匹配或无授权 LLM Judge 自动批准。审核结果仅记录决定与 unsupportedClaimCount，不复制最终正文。

新增本地 `pnpm acceptance:review`，只读取/校验指定验收报告并记录人工决定，不启动 runtime/Lab、不调用任何模型或 LangSmith。approved 必须明确填写 unsupportedClaimCount=0；有无根据断言则 rejected。人工决定不能覆盖已有硬检查失败，也不能把 unavailable 的远端核验改成 verified。审核旧 Run 可通过已持久化 Web 消息回放，不能点击“开始巡检”来生成新的收费 Run。

最终 verdict：任何硬检查失败或人工 rejected → failed；自动检查均通过但远端 unavailable/人工 pending → review_required；所有硬检查和远端核验通过且人工 approved → passed。passed 只表示本轮开发验收通过，**不表示生产上线许可**。

### ADR：2026-10-08 烟测 422、窗口一致性与报告可信度补强

- Multipart 上传在审计后由应用重新编码：每个 JSON part 使用独立 `Content-Length` 头声明 UTF-8 字节数，`Content-Type` 保持 `application/json`，不附带 SDK Blob 自动生成的 `filename`；边界随机生成并检查与正文无冲突。格式对齐官方 SDK serializer。离线兼容服务验证实际发出的 wire bytes、part 长度及无 filename，并确认无效格式返回 422。此测试不能单独证明之前 LangSmith 远端 422 的具体拒绝原因，真实远端接收仍需独立核验。
- Smoke Lab 在创建固定遥测快照时同时产出规范 UTC `sourceWindow`；父 Agent 上下文、Metrics 查询、Logs 查询和 Logs capture 均使用该窗口，并对内部来源请求实施精确一致性校验，避免 Lab 刷新时钟造成同一 Run 证据窗口漂移。
- 报告轮只有在来源工具成功且返回有效证据引用后才放宽至报告 token cap；Metrics 必须有证据 ID，Logs 必须有可交叉验证的 capture/aggregate/search 或 read-slice 引用。失败、不可用、空引用或互不匹配不得升级预算。
- 验收增加 `SCENARIO_OUTCOME_VALID`：父 Run 和全部预期子 Run 必须完整结束，且不含模型输出截断失败；增加 `SOURCE_FINGERPRINT_VALID`：报告记录 64 位 SHA-256，覆盖 `src/`、`apps/` 和构建清单，哈希不记录文件路径或内容。该指纹补足脏工作树场景下仅记录 HEAD revision 无法识别实际源码快照的问题；哈希失败须在任何付费模型请求前 fail closed。
- 本次报告采用 schemaVersion=2；schemaVersion=1 仅作为历史输入兼容。人工复核旧报告时新增门禁为 `not_run`，禁止把旧数据补推断成已通过。

### ADR：2026-10-08 跨层契约闭环修复（已批准）

对应计划：[真实烟测跨层契约修复](../plans/2026-10-08-real-smoke-contract-closure.md)。以下修订取代上文中相冲突的预算资格和验收超时描述，其余安全约束不变。

- 指标公开证据从 metric.summary.start/end 的有效 Unix 秒确定性投影既有可选 timeRange；旧记录或无效窗口不推测，不放宽同窗检查，不迁移 SQLite。
- Logs 成功 capture 后，同一合法 evidenceId 的成功 search 或 read-slice 即可取得报告轮预算；aggregate 为可选补充。预算资格不等于证据充分，Collector、partial、missingEvidence 和验收硬门禁仍为权威。
- Source 生命周期保持生产者的 childRunId 归属，Verifier 交叉校验 parentRunId、childRunId、父 toolCallId 和来源类型。旧 parent-owned 事件仅走完整身份匹配的显式兼容分支；不重写历史事件，不混淆 wrapper stream 与 child execution stream。
- 失败模型尝试的已知 usage/finishReason 参与远端核验；缺失仍 unavailable，不补零。Trace verified 不能把失败诊断升级成通过。
- 运行默认 request/flush 超时保留 1000/2000ms；显式验收和独立探针统一注入 10000/15000ms 至 SDK、外层 fetch、审计 transport。该有界配置不证明历史 HTTP 422 已修复。
- schemaVersion=2 本地报告新增可选、严格白名单且有界 diagnostics，记录模型阶段/cap、上传 route/phase/status 和核验阶段；旧报告仍可读，人工复核保留字段。诊断不进入事件、模型上下文或原文证据接口。
- 新增独立 opt-in Trace 探针，仅上传两个 synthetic Span 并有界回查，不调用模型或启动 Lab/MCP。真实模型 runner 在 Lab/模型调用前执行同一准入，探针失败时模型请求为 0 且不创建父 Run；独立探针成功也不等于诊断验收通过。
- 本轮默认只执行离线回归和质量门，真实探针/模型不自动重跑。10 次模型 HTTP、512/1024 cap、5120 共享输出预算、90/30 秒 Run 截止时间、摘要与引用公开边界均不变。

## 10. 测试与验收门槛

- Node 24＋锁定 pnpm 11 的冻结安装，Windows/Linux 各跑 lint/typecheck/test/build/web:typecheck/web:build。
- 保留所有现有 V1/V2、Hook/HITL、证据、Logs Web 回归测试，不降低用例或跳过断言换通过。
- 新测试覆盖事件专用端口与旧注入兼容、父子模型身份、Span 去重/包装/取消/暂停/恢复、usage 缺失与 cache、隐私 allowlist。
- Fake Client 和本地 HTTP server 覆盖 exporter拒绝/超时/挂起/限流/队列满/close；断言不出现 unhandledRejection，网络不阻塞主 Run。
- 有界模型 fetch 的 Request/URL、交叉并发、重试/子 Agent共用名额、超大 body与保留 Abort 测试保留。
- 默认脚本评测 5/5；真实后端 scripted E2E 继续通过；真实模型最多一次，失败保留产物再诊断，不反复消费额度。

## 11. 完成后的下一阶段

下一份独立 Spec 应定义 `group-buy-market` 的只读预生产接入：真实结算计数器的分母/重置/窗口、日志字段与脱敏、服务标识和保留策略、来源最小只读凭证、数据新鲜度和诊断金标准。不得把本轮模拟 gauge 的查询直接当业务 counter 查询。

再后续分开建设访问控制、触发/任务调度/恢复、部署健康检查/备份与 retention、Trace/变更、多环境运行，以及白名单保护动作＋HITL＋执行后验证/回滚。它们不隐藏进本轮 7 个任务。
