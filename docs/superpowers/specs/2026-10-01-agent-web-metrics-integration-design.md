# Agent Web 指标取证闭环设计规格

日期：2026-10-01

状态：待用户审核；本文件是新增集成规格，不替代既有 Metrics 和 Source Subagent 规格
适用分支：`codex/event-message-v2`

## 1. 规格关系与边界

本规格在以下已批准约束之上增加本地 Web 组装和验收要求：

- `AGENTS.md`
- `docs/superpowers/specs/2026-09-14-source-subagent-design.md`
- `docs/superpowers/specs/2026-09-15-metrics-subagent-design.md`
- `docs/superpowers/specs/2026-10-01-run-evidence-read-api.md`
- `docs/architecture/15-event-message-v2.md`

目标是让个人开发者从 Agent Web 发起一次 `simulation` Profile 巡检，指标由模拟器产生，但查询实际经过 Prometheus HTTP API、只读 MCP、`metrics.settlement`、Metrics child Harness、父级 `metrics_subagent`，最终在本地 SQLite 和公开 Web 视图中留下可回查证据。这里的“真实 Prometheus”指查询真实运行的 Prometheus 服务，不表示数据是生产遥测，也不表示 `group-buy-market` 已接入。

本增量不改 `D:\xfg\group-buy-market`，不新增 ELK/Trace/动作，不开放公网，不把模拟器控制并入 Agent Web，不把脚本模型 E2E 宣称为线上模型验收。业务系统实际指标名、PromQL、标签和统计方法需下一份独立规格确定；不能把本实验 Profile 的 URL 换成业务地址就声称完成接入。

## 2. 已核实的代码基线

1. `src/bootstrap/metrics-subagent.ts` 已实现 canonical `metrics_subagent`、严格 300 秒请求校验和受限 child Toolkit；`src/application/metrics-source-report-collector.ts` 已确定性重算指标事实。
2. `src/bootstrap/settlement-evidence-tool.ts`、`src/mcp/readonly-tools.ts`、`src/infrastructure/prometheus/settlement-source.ts` 已实现实验指标查询、MCP 工具适配、证据记录及重试/熔断。当前只接受 `checkout/simulation` 和实验用 gauge 快照。
3. `test/real-prometheus.test.ts` 可选地验证模拟器 → Prometheus → MCP → 父子 Harness，但使用脚本模型与内存 EvidenceStore，不覆盖 Web、SQLite 和进程重启。
4. `src/bootstrap/agent-web-runtime.ts` 默认只注册 `options.tools`；`apps/agent-server/index.mjs` 未注入任何指标 Tool。Web E2E 的 `fixture.metrics` 是固定返回值，不是 Prometheus。
5. Web 默认暴露的 `group-buy-market` Profile 尚未绑定此实验指标来源；不得用 `simulation` 数据填充该 Profile。
6. `RuntimeToolFactory` 同步执行，现有 MCP binder 先异步发现远端工具；工厂端口未提供运行时 EvidenceRecorder。直接在工厂里调用 binder 或另建内存 EvidenceStore 均无法满足持久化闭环。
7. 父级查询和 SSE 读取当前 Runtime 的 SQLite/V2 事件链路。独立创建一个拥有自己事件发布器的 child Runtime，不能保证子 Run 的实时消息和审计能由 Web 宿主读取。

## 3. 设计选择

采用“显式启用实验 Profile + 固定 manifest 注册 + 按需 MCP 连接 + 共享父子运行时数据平面”。

不采用父级直接注册 `metrics.settlement`：这绕开 Metrics Subagent 的受限 Toolkit、预算和报告收敛。不采用启动时必须完成 MCP 握手才能注册工具：来源短暂离线会令整个 Web 宿主不可用，无法展示受控降级。不采用 child 独立 SQLite/V2 Publisher：同库多发布器的投影、回放和 SSE 一致性缺少当前契约保证。

```text
Agent Web (simulation Profile)
  → HTTP start / Web query / Public V2 SSE
  → Parent AgentHarness / parent Toolkit: metrics_subagent
  → SourceSubagentToolAdapter / DefaultSourceSubagentRunner
  → Child AgentHarness / child Toolkit: metrics.settlement + source_report
  → 只读 MCP → Prometheus /api/v1/query → 模拟器 /metrics
  → 同一 SQLite Evidence / Checkpoint / V2 Event+Message 数据平面
  → SourceSubagentResult → 父级 ToolResult → 公开证据摘要
```

父子是同一个 `AgentHarness` 实现的两个隔离 Run，不增加第二套 ReAct 主循环。`tool_call` 仍经过既有 Admission、Guard、Hook、HITL、批调度和 Pipeline。

## 4. 配置、Profile 与时间窗口

实验链路必须显式启用：CLI 使用 `AGENTOPS_WEB_PROFILE=simulation` 与 `AGENTOPS_METRICS_MCP_URL`，缺少其中任一项就以配置错误停止启动，而不是开放一个无指标工具的假巡检页面。配置完整但来源暂时离线时宿主仍启动，让 Run 得到可审计的 `unavailable`。模拟器和 Prometheus 的启动仍由现有 Metrics Lab/Compose 入口负责；Web 宿主不隐式启动 Docker、模拟器或 Prometheus。MCP URL、Prometheus URL、凭据、PromQL 和阈值只来自宿主/Profile，不从浏览器表单或模型 Tool 参数取得。

在实验模式下，Web 仅向新 Run 开放 `simulation` Profile，使用 `settlementMetricsLabProfile` 的 `checkout`、300 秒、5% 阈值和最小样本 20。直接调用 `startAgentWebRuntime()` 的现有显式模型/工具测试注入保持兼容；正式 CLI 不再默认开放未绑定来源的 `group-buy-market`。生产目标 Profile 不能消费实验来源。

本次 Run 的请求窗口由宿主时钟在 Run 创建时固定：`end = floor(now / 1000) * 1000`，`start = end - 300000`。通过仅由宿主可注入的受信任 system 上下文消息告知父模型 Profile、service、start、end 和“只可用 `metrics_subagent`”；浏览器输入不能伪造或覆盖该消息。消息随 Run checkpoint 保存，恢复时不重新计算窗口；不在每轮改变 Tool schema 或 system 前缀。模型若仍输出错误时间或服务，现有输入闸门按 `INVALID_INPUT`/`POLICY_DENIED` 拒绝，不静默改写其 ToolCall。

实验快照由模拟器在切换场景时产生并保持不变，只有最新 120 秒窗口有效。验收脚本必须在每个场景切换后等待 Prometheus 实际抓取完成再创建 Run；不能把 Prometheus 尚未抓取、过期或缺失序列解释为健康。请求与快照不完全重合时沿用 Metrics Collector 的 coverage/partial 规则。

## 5. 组装与运行时所有权

`src/bootstrap/` 拥有实验 Profile、MCP 连接管理、Source Subagent、模型和 Web 宿主的组装；`agent/` 不引入 Prometheus、MCP SDK、SQLite 或 HTTP 依赖。保留 `startAgentWebRuntime()` 的现有测试注入能力，新增配置为可选且不会让旧调用自动获得实验数据。

本地 Runtime 扩展一个最小的内部晚绑定端口，允许同步 Tool 工厂取得其已经建立的 `EvidenceRecorder`，以及创建共享数据平面 child Run 所需的窄接口。MCP Tool 的固定本地 schema/manifest 与执行时握手分开：启动时可同步注册 canonical `metrics.settlement`；首次调用和每次重连时校验远端名称与输入 schema 是否符合宿主预定义的只读 manifest，不信任远端 annotation 赋予额外权限。不一致时返回 `MCP_PROTOCOL_ERROR`，不得扩大 Tool 列表或权限。连接、请求和熔断仅由现有 MCP 可靠性执行层管理，禁止叠加无账本重试。

父级只注册 `metrics_subagent`。child Toolkit 精确注册 `metrics.settlement` 与 `source_report`，无 Bash、任意 HTTP、写动作、其他来源 Tool 或 Subagent。child 继承父级 signal、绝对 deadline、剩余 Tool 预算和网络尝试账本。一个 Web 宿主只拥有一套 SQLite 持久化 bundle、V2 发布/投影链路和证据记录器；child 使用独立 Run/Toolkit/AgentHarness，但其 checkpoint、消息、事件及证据进入这套共享数据平面。不得以第二个 Runtime 打开同一 SQLite 文件并注册第二套同名投影器作为共享方案。

Source Runner 继续使用稳定 `childRunId`，证据继续使用稳定 `evidenceId` 与 `captureKey`。子 Run 完成而父 ToolResult 尚未落库时，恢复先查 child checkpoint 和证据，不无条件重复 MCP 调用。关闭宿主时先停止接受新 Run、取消并等待活跃调查进入可恢复 checkpoint，再关闭 MCP 和 SQLite；不得先关闭数据库再让子调查继续写入。

## 6. 结果、降级与公开视图

正常、超阈值和低样本分别由确定性 `assessSettlementMetrics` 与 Metrics Collector 给出 `healthy`、`breached`、`insufficient_data`。低样本即使观测失败率很高，也不作阈值结论；指标异常只证明症状，不单独确认数据库或其他根因。

MCP/Prometheus 不可用时，canonical Tool 仍可被调用；既有 Retry → Resume/Verify → Reduced scope → Unavailable 四轮路径在共享预算和 deadline 内运行。没有有效指标证据时，父级和页面必须展示 `unavailable`/`missingEvidence`，不能回退到脚本 fixture、上次成功的其他 Run 或模型编造的“正常”。已有有效证据但报告不完整时只能是 `partial`。恢复连通后经熔断半开探测继续使用同一静态 Tool schema，不需要重启宿主或变更父 Toolkit。

用户可见的指标结论必须从已验证的 `SourceSubagentResult`/证据投影生成；无 committed 指标证据时不能展示模型自由文本作为“健康”“已定位根因”的权威结论。此限制应在应用/公开投影边界使用结构化状态实现，不靠提示词或中文关键词拦截。原始 Prometheus 响应只保存在 EvidenceStore；Public SSE、Web DTO、Audit、LangSmith 和模型上下文只接触有界摘要、状态和证据引用。

Web 查询应能从父 Run 查看子 Run 身份，从子 Run 查看其公开消息、阶段、终态及证据摘要；父级 ToolResult 保留相同 evidenceId 引用。刷新和进程重启后两级关系仍可查询。浏览器不增加原文证据下载接口，也不提供模拟器写控制。

## 7. 兼容性和迁移

- 不新增或改变 Event/Message V2、ToolResponse、SourceSubagentResult 和 HTTP 公开字段的既有语义；新增配置与内部运行时端口为可选。
- 不修改 Harness 迭代顺序、Hook/Guard/HITL 职责或写动作策略。受信任初始 system 消息属于上下文构建，不是外部命令或新事件类型。
- 默认无需持久化 Schema 迁移；若共享子 Run 查询需要索引，只添加事务迁移和回归测试，不修改旧迁移。
- 现有固定返回值 Web E2E 保留，用于 HITL/前端状态测试；新增真实 Prometheus 的可选 E2E 不替换它。
- 既有 `bindSettlementEvidenceTool()` 调用继续兼容；内部拆分异步远端检查和同步证据装饰时保留该入口。

## 8. 实施依赖顺序与验收

1. **组装前置端口**：测试驱动地拆分 MCP 静态 manifest/延迟连接与证据装饰，补运行时窄端口。断连、恢复、错误 schema、Abort、超时和共享网络账本必须有确定性测试。
2. **共享 child 数据平面**：用脚本模型验证父子独立 Toolkit、同库 checkpoint、V2 消息/SSE、稳定 ID 和恢复不重取证，再接入 Web 宿主。所有 child 生命周期资源由宿主拥有并关闭。
3. **实验 Profile 与受信任窗口**：Web 只在显式模式暴露 `simulation`，通过宿主上下文给出固定时间窗；错误的模型 ToolCall 被拒绝。缺配置或错配不得把模拟数据归于 `group-buy-market`。
4. **浏览器闭环**：可选测试实际启动模拟器、Prometheus、MCP、Web 宿主和前端；跑 normal、settlement_failure、low_sample，断言 UI、父子 Run、证据引用、SQLite 重启后查询和无原文泄漏。额外跑来源断开/恢复、确认过期、两个 Run 隔离与显式 resume。
5. **人工烟测**：在本地配置真实模型服务，只记录模型能否完成 Tool 编排与公开结果是否有证据；不把模型自然语言当数值真值或 CI 硬门槛。

提交前运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build`、`pnpm e2e`。真实 Prometheus 集成测试继续为显式 opt-in；报告中分别写明默认测试、真实 Prometheus 和真实模型各自是否运行。任何场景只要来源不可用仍显示“健康”、父子事件不在同一 Web 查询链路，或证据引用无法回查，就不得宣称本增量完成。
