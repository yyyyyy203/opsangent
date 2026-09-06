# AGENTS.md

本文件定义本仓库中所有 Agent、开发者和自动化工具修改代码时必须遵守的约束。若子目录存在更具体的 `AGENTS.md`，子目录规则可补充本文件，但不得放宽安全、契约兼容和依赖方向约束。

## 1. 项目身份

- 项目：生产级智能巡检诊断 Agent。
- 技术栈：TypeScript、Node.js 20、pnpm。
- 第一目标系统：`D:\xfg\group-buy-market`。
- 第一真实数据源：Prometheus。
- 后续数据源：ELK、Trace、配置和发布变更。
- 最终能力：真实数据取证、根因诊断、受控降级/熔断、HITL、执行后验证、审计与经验沉淀。

本仓库是独立的新实现。旧巡检项目和其他已有 Agent 项目的实现均视为废弃，不得复制其架构或代码进入本仓库。Newton Agent Core 仅作为机制和行为参考；除非用户明确确认代码授权，否则必须采用 clean-room 方式独立实现。

## 2. 开发前要求

修改代码前必须：

1. 阅读根目录 `AGENTS.md`、项目设计文档和当前模块的公开接口。
2. 使用 `rg` 或 `rg --files` 定位相关实现和测试。
3. 检查 `git status --short`，保留用户已有改动，不覆盖无关文件。
4. 明确本次修改属于契约、核心机制、适配器还是基础设施。
5. 涉及公共契约、持久化 Schema、HITL、安全动作或依赖方向时，先说明兼容性和迁移影响。

## 3. 架构原则

项目遵循以下原则：

- 高内聚、低耦合。
- 核心机制只依赖稳定接口，不依赖具体基础设施。
- 命令和查询使用显式接口；生命周期通知、SSE、审计使用事件。
- 流式优先：模型推理和工具执行过程必须能够产生流式事件。
- 确定性优先：数值计算、阈值比较、影响面和风险等级不得交给 LLM。
- 可审计：所有结论和动作必须可追溯到证据、规则和确认记录。
- 写权限最小化：仅允许白名单保护性动作；真实写操作必须经过统一执行管线。
- 可恢复：HITL、暂停、进程重启和长任务不得导致动作重复执行或状态丢失。
- 契约兼容：已发布事件、消息块、ToolResponse 和持久化 Schema 不得破坏性修改。

## 4. 分层与依赖方向

目标目录边界：

```text
src/
├── api/                  # HTTP、SSE、HITL 边界
├── application/          # 用例编排
├── agent/                # ReAct Harness 与状态机
├── contracts/            # 稳定公共契约
├── tool/                 # Toolkit 与工具执行管线
├── hooks/                # 执行前后扩展点
├── guard/                # 确定性风险规则
├── event/                # 事件类型与发布
├── context/              # 结构化上下文与模型渲染
├── context-compressor/   # L0/L1/L2 压缩
├── memory/               # 工作、案例、语义、经验记忆
├── storage/              # 存储抽象
├── checkpoint/           # 中断恢复与幂等
├── model/                # 模型抽象与格式适配
├── mcp/                  # MCP 接入
├── profiles/             # 目标系统巡检 Profile
├── infrastructure/       # SQLite、Prometheus、ELK、动作适配器
└── bootstrap/            # 配置和依赖组装
```

允许的依赖方向：

```text
api -> application -> agent/core -> contracts
infrastructure/adapters -> contracts
bootstrap -> all modules
```

禁止：

- `contracts/` 依赖任何实现模块。
- `agent/` 直接依赖 SQLite、文件系统、MCP SDK、Prometheus、Elasticsearch、HTTP 框架或具体模型 SDK。
- 基础设施实现被核心模块直接实例化。
- 通过全局单例或隐藏的模块状态绕过依赖注入。
- 为绕过循环依赖而使用动态 `require`；应缩小接口、移动共享类型或使用 type-only import。

所有具体实现必须在 `bootstrap/` 组装并通过构造器注入。

## 5. Agent Harness

系统只能有一个权威主循环。每轮顺序固定为：

```text
Abort check
-> 加载状态和预算
-> Pre-reasoning 上下文治理
-> Reasoning
-> 模型输出校验
-> Acting batch
-> Loop detection
-> Awaiting/HITL
-> Checkpoint
-> Exit decision
```

不得把主循环控制逻辑分散到 Tool、Hook、MCP Adapter 或 API Controller 中。

诊断阶段至少包括：

```text
triage
evidence_collection
hypothesis
risk_gate
action
verification
postmortem
```

阶段变化必须显式记录并产生事件。

## 6. 工具执行管线

Agent 不得直接调用 Tool。所有工具统一经过：

```text
输入校验
-> Guard 扫描
-> 风险合并
-> Pre-Hooks
-> HITL
-> 幂等检查
-> Dry Run（动作工具）
-> ToolRunner
-> Post-Hooks
-> 结果和 Checkpoint 持久化
```

执行职责必须分层：

- `ToolBatchExecutor`：分组和调度。
- `ToolExecutionPipeline`：Guard、Hook、HITL、幂等和事务边界。
- `ToolRunner`：只执行具体工具，不感知暂停和恢复。

`isConcurrencySafe=true` 的只读工具可用 `Promise.allSettled` 并行；写工具必须串行。同一批次同时出现查询和动作时，必须先完成查询并重新进入推理，禁止基于旧证据直接执行动作。

## 7. Hooks、Guard 与 HITL

Guard 和 Hook 职责不得混淆：

- Guard 读取工具、参数、Profile 和实时影响面，返回确定性的 `Finding[]`。
- Hook 根据 Finding、预算和运行状态决定 `continue`、`interrupt` 或 `abort`。
- HITL 负责外部授权、暂停、确认、拒绝和恢复。

首批 Hook：

- `EvidenceBudgetHook`
- `RiskActionHook`
- `AuditHook`
- `CheckpointHook`
- `DiagnosisMemoryHook`

Hook 中断状态必须可序列化。禁止尝试持久化函数闭包或 `resumeHandler`；应持久化 `hookId`、`interruptType`、`toolCallId`、payload 和有效期，恢复时由注册表重建行为。

第一阶段所有真实写操作均必须人工确认。确认只对白名单中的具体 `toolCallId` 生效，不得按工具名或会话全局放行。拒绝必须生成模型可见的标准 ToolResult。

## 8. 事件与公共契约

跨模块公共契约集中在 `contracts/`。第一版公开事件应保持精简，包括：

```text
RUN_STARTED
STEP_STARTED
REASONING_STARTED
TEXT_DELTA
TOOL_CALL_CREATED
TOOL_STARTED
TOOL_RESULT
EVIDENCE_COLLECTED
REQUIRE_CONFIRM
CONTEXT_COMPRESSED
RUN_PAUSED
RUN_FINISHED
RUN_FAILED
```

规则：

- 已发布字段不得删除、改名或改变语义。
- 新字段优先使用可选字段并提供默认行为。
- 破坏性变更必须新增 schema version 和迁移。
- 事件必须携带 `runId`、时间戳；步骤事件必须携带 `stepId`。
- SSE、审计和测试必须复用同一事件契约。

## 9. 上下文工程与压缩

系统内部必须使用结构化 `AgentContext`，不得依赖不断拼接的巨大字符串作为真实状态。模型文本只在 Renderer 边界生成。

上下文至少保留：

- 触发信息和当前阶段。
- EvidencePlan 和结构化 EvidenceSummary。
- 已确认事实、根因候选和缺失证据。
- 风险状态、预算、待确认动作和已执行动作。
- 相关 MemoryHints。

压缩分三层独立实现：

- L0：完整原始证据外置，消息只保留摘要和 `evidenceId`。
- L1：旧 ToolResult 结构化裁剪。
- L2：达到 token 阈值后生成结构化历史摘要。

压缩不得删除或模糊：

- `runId`、`stepId`、`toolCallId`、`evidenceId`。
- 已执行动作和动作结果。
- 人工确认、拒绝和 Risk Gate 结论。
- 待确认动作、缺失证据和未解决风险。

压缩后必须校验消息完整性：每个 ToolCall 都应有对应 ToolResult，每个 evidenceId 都必须可回查原文。

## 10. 记忆系统

记忆通过稳定门面和小接口提供，不得创建包含所有职责的巨大实现类。至少区分：

- Working Memory：当前 Run 状态。
- Episodic Memory：历史巡检案例。
- Semantic Memory：系统拓扑、指标定义和 Runbook。
- Procedural Memory：审核通过的诊断经验模板。

LLM 只能提出经验候选。候选默认进入 `observation`，只有人工审核为 `approved` 后才能进入 Triage 快路径。证据不足、动作无效或质量检查未通过的结论不得晋级正式经验。

记忆召回应先按 Profile、服务、故障类型和时间过滤，再进行文本相关性排序；禁止把全部长期记忆注入模型上下文。

## 11. Storage、Checkpoint 与幂等

第一阶段默认使用 SQLite，并启用 WAL 和事务迁移。所有存储通过接口访问，未来可替换 PostgreSQL、Redis 或其他后端。

Checkpoint 至少保存：

- Run 状态、阶段和迭代次数。
- 消息与结构化上下文版本。
- 待执行 ToolCall 和可序列化中断。
- 已确认、已拒绝和已执行的动作。
- 证据预算、时间预算和压缩状态。

动作执行必须使用稳定幂等键。设计时必须处理“外部动作成功但本地落库失败”的不确定状态：不得无条件重放，应进入人工核验或通过外部状态查询确认。

## 12. 模型和提示词约束

- 模型通过 `ChatModel` 接口接入，第一阶段实现一个 OpenAI-compatible Adapter。
- Formatter 负责消息协议转换，Agent 不感知供应商字段。
- 系统提示词、工具定义和历史前缀尽量稳定，动态上下文追加在尾部。
- 数值、阈值、趋势、影响面、动作幂等和风险等级由确定性代码计算。
- 模型输出必须进行 Schema 校验；解析失败不得静默降级成高置信结论。
- 证据不足时只能输出部分诊断，并明确 `missingEvidence`。

## 13. group-buy-market 边界

`D:\xfg\group-buy-market` 是第一被监测系统，不是本仓库的代码来源。默认只读访问，未经用户明确要求不得修改其业务代码、配置或运行状态。

第一诊断场景：结算失败率升高。第一数据源：Prometheus `/actuator/prometheus`。ELK 当前配置存在但应用上报默认关闭，应在后续独立任务中验证。Trace 当前只有日志 MDC trace-id，不得宣称已有完整链路追踪。

Profile 应保存目标系统的服务关键等级、指标定义、阈值、取证路径、Runbook 和允许动作，禁止把这些规则硬编码进 Agent Harness。

## 14. 安全动作约束

- 只允许 Profile 和 Tool Registry 白名单中的动作。
- 第一阶段动作仅允许 Dry Run。
- 接入真实动作后，所有写操作默认 HITL。
- 动作必须支持输入校验、风险评估、幂等、审计和执行后验证。
- 禁止由 LLM 直接构造任意 HTTP 请求、Shell 命令或数据库写语句执行降级/熔断。
- 恢复动作和回滚动作同样经过 Risk Gate，不得默认视为安全。
- 密钥、Token、Cookie、客户数据和内部地址不得写入源码、事件或模型上下文。

## 15. 测试要求

新增或修改核心机制时必须测试：

- 正常路径。
- 超时、失败和 Abort。
- safe/unsafe 工具调度顺序。
- 单个并行工具失败的错误隔离。
- Hook continue/interrupt/abort。
- HIGH/CRITICAL 动作必定触发确认。
- 确认、拒绝、确认过期和恢复。
- checkpoint 重启恢复和动作幂等。
- L0/L1/L2 压缩后的消息完整性。
- 证据引用可回查。
- 公共事件和 Schema 的兼容性。

不得只用模型自然语言结果断言测试通过。核心决策必须使用确定性断言。

提交实现前至少运行：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

如果命令尚未建立，应在项目初始化阶段补齐；如果因环境原因无法运行，必须明确报告未验证项。

## 16. 修改规范

- 小步修改，避免无关重构。
- 公共接口使用明确命名和严格类型，避免 `any`。
- 领域状态使用判别联合或枚举，避免任意字符串。
- 错误使用稳定错误码和结构化对象，不依赖错误文案判断流程。
- 时间、ID、随机数和外部调用应可注入，保证测试确定性。
- 不在模块顶层保存 Run 级可变状态；每个 Run 的状态必须隔离。
- 不使用 `process.cwd()` 隐式决定业务路径；路径通过配置注入并进行校验。
- 不吞异常；降级、重试和部分成功必须产生明确事件与审计记录。
- 新增模块时同步增加公开入口、测试和必要设计文档。

## 17. 设计决策门槛

以下变更不得在普通实现中顺手完成，必须先记录设计决策：

- 修改公共事件、消息块或 ToolResponse。
- 修改 Agent Harness 每轮顺序。
- 改变 Hook、Guard、HITL 的职责边界。
- 新增自动执行写操作。
- 修改 checkpoint 或记忆晋级语义。
- 更换持久化后端或引入新的运行时框架。
- 让核心模块依赖具体基础设施。

遇到文档与实现冲突时，安全约束、公共契约和可恢复性优先；仍无法判断时应停止扩大修改并向用户说明冲突。
