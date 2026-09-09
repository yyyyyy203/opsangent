# 实现进度与验证记录

本页按时间倒序记录实现增量；带日期的旧条目是历史快照，不覆盖顶部最新状态。

## 最新增量：Event / Message V2 核心验收与 AsyncGenerator 收口

2026-09-09：完成 Event/Message V2 核心验收收口。V2 MessageBlock 契约、Event PayloadMap/Schema、EventStore/MessageStore、内存与 SQLite 持久化、ReplayBuffer、MessageAssembler、EventPublisher、ProjectionRunner、Public/V1/Audit/LangSmith 投影、模型/工具/HITL/Subagent 运行时事件和 Node HTTP/SSE 入口均已落地。

本轮补充 V1 fixture、V2→V1 单向投影、并行工具 ToolCall/ToolResult 配对、公共事件/消息快照脱敏、模型身份链路、SQLite 重启和 transient 序列空洞恢复验收，并修复模型层提前发布 `TOOL_CALL_CREATED` 导致的重复事件。`replyStream()` 现在直接 yield V1 事件；`ToolRunner`、`ToolExecutionPipeline` 和 `ToolBatchExecutor` 形成流式工具链，安全 payload 与 V2→V1 投影共用映射。消费者调用 `return()`/`throw()` 时会清理子生成器、标记取消、保存 Checkpoint 并 flush observability。`RetryingChatModel` 保持 AsyncGenerator 语义：首个流事件前才重试，部分输出后不重放，支持 Abort、fallback 和模型尝试事件。消息 assembly 中间状态可恢复；V2 runtime 暴露 `ready` 执行本地投影启动回放，LangSmith 历史补报保持显式选择。

最终验证记录：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过；全量测试为 44 个测试文件通过、1 个真实 Prometheus 测试文件按默认配置跳过，222 项测试通过、1 项跳过。核心协议已验收，但完整生产一期仍保留若干明确缺口，详见 [Event / Message V2 一期验收状态](./event-message-v2-acceptance-status.md)。

## 设计决策：Event / Message V2 作为一期协议地基

2026-09-07：确认一期完整实现 Event/Message V2，而非只补少量事件名。范围包括强类型 PayloadMap、完整 MessageBlock、ID 与暂停恢复语义、模型/工具/四闸门/HITL/Subagent/MCP/熔断/压缩/记忆事件、EventStore 与重放、Public SSE/Audit/LangSmith 三类投影及 V1 兼容投影。完整设计见 [Event 与 Message V2 协议](./architecture/15-event-message-v2.md)。

本条为 2026-09-07 的目标确认记录。当前源码已经有 V2 契约、基础存储、发布与回放实现，但运行时生产点和三类投影尚未全部完成，仍以最新增量和验收状态文档为准。

## 最新增量：可运行 Metrics Lab 组装

2026-09-06：新增独立模拟器管理 API 和统一 Metrics Lab 生命周期。管理端仅监听 127.0.0.1，严格允许 GET /scenarios 与 PUT /scenario；抓取端仍不包含场景控制，Agent MCP 也无法访问管理能力。startMetricsLab 同时组装模拟器指标端、管理端、Prometheus 查询源和只读 MCP 服务，并在启动失败或关闭时回收已启动资源。提供 lab:backend:up、lab:backend:stop、lab:start 命令。

真实后端验收扩展后为 16 个文件、87 项测试通过，覆盖真实 Prometheus → MCP HTTP → Harness → EvidenceStore 三场景链路。Simulator Web 和 Agent Web 页面仍未实现；当前交付的是其服务端运行入口和管理 API，不应称为前端已完成。

## 上一增量：MCP → Harness → EvidenceStore

2026-09-06：新增本机只读 MCP 服务、严格结算查询协议和本地证据 Tool 组装。通过已有统一执行管线完成指标取证、确定性摘要计算、原文保存和引用回查；无数据不虚构证据，保存失败显式失败，来源重试只由已有执行器控制。修复 Error 自定义错误码在 Checkpoint 克隆中丢失的问题，公共字段不变。

四项质量检查通过：lint、typecheck、test、build。启用真实 Prometheus 时 14 个文件共 84 项测试通过，包含三个场景经真实 MCP HTTP、Harness 与证据回查的验收。模型仍是 ScriptedModel，存储仍在内存中；不能宣称已完成真实模型诊断或磁盘恢复。详见 [MCP 与证据闭环](./architecture/14-settlement-mcp-evidence.md)。

## 上一增量：真实 Prometheus 抓取与查询

2026-09-06：新增只读模拟器 HTTP 服务、Prometheus Compose 配置、固定实验 Profile 查询适配器及数据有效性校验。真实 Prometheus 已验证 100/15 异常、100/0 正常和 10/8 低样本三个场景。完整 Agent/MCP/EvidenceStore 链路仍未串接。

四项检查通过：lint、typecheck、test、build；启用真实后端验收时 12 个文件、76 项测试全部通过。新增 21 项测试，其中一项为显式启用的真实 Prometheus 验收；默认测试跳过该项。复验命令、安全边界与当前缺项见 [指标实验说明](./architecture/13-metrics-lab-implementation.md)。

## 上一增量：指标模拟快照与确定性判定

2026-09-06 中断重试后，补齐 SettlementSimulator 和独立 settlement Profile 计算。支持正常（100/0）、失败率升高（100/15）、低样本（10/8）三个固定窗口快照，输出 Prometheus 文本格式的 gauge；不使用 increase 推算固定样本数。重复抓取不刷新窗口时间，重新选择场景才创建新窗口。

失败率、阈值与最小样本判定由代码执行。零样本返回 null 失败率和 insufficient_data，低样本不判健康，非法计数和 Profile 参数显式拒绝。阈值采用严格大于语义。仅提供指标异常判定，不推断 MySQL 根因。

验证：pnpm lint、pnpm typecheck、pnpm test、pnpm build 均通过，9 个文件共 55 项测试（本增量新增 15 项）。Docker 后端已确认可用（29.1.2），但尚未启动 Prometheus 实验服务，不能把此结果视为真实后端联调通过。

本增量只交付快照生成及数值判定基础模块；HTTP 暴露/管理端隔离、Prometheus 查询校验、实验 MCP 服务、EvidenceStore 串接与完整链路验收仍按 metrics-lab 计划待实现。未改动公共契约、Harness 和 group-buy-market。

## 上一批次：MCP 只读接入与可靠性

2026-09-06 继续实施后，新增专用 createInspectionRuntime、官方 SDK HTTP 连接、本地 Manifest/Schema 对照注册、来源熔断器及有界执行器。支持网络超时、最多两次追加重试、jitter、Retry-After、取消、父 Run 截止和共享网络尝试账本；重试以 Tool 流式事件返回。详见 [MCP 实现说明](./architecture/12-mcp-implementation.md)。

最新验证：pnpm lint、pnpm typecheck、pnpm test、pnpm build 均通过，8 个文件共 40 个测试。相较上一批新增 17 个测试，包含 4 个官方 MCP 服务端真实 HTTP 集成测试。没有连接真实遥测后端或实际 LLM，完整 V1 尚未验证。

项目此时已存在 Git（读取到既有提交 745ce46），保留原有未提交改动；本轮未创建提交。下文“无 Git”的说明是上一批次的历史记录。

下一步：接入真实遥测实验环境与来源工具，再完成来源 Subagent、持久化和交互界面。自动重连/健康面板、完整 LangSmith 嵌套链路和真实业务验收仍需实施。

## 2026-09-06：工具准入与纠错基础链路

本轮实施 [工具准入计划](./superpowers/plans/2026-09-06-tool-admission.md)，在现有框架中落地以下能力：

- RawToolCall 与 ModelResponse.rawToolCalls：保留未解析参数，不把失败转换为空对象。
- ToolAdmission：工具存在性、JSON 解析/一次安全修复、严格 Zod Schema、注入式语义校验。
- JSON 限制：64 KiB、32 层，拒绝重复键（含 Unicode 转义同名键）、危险键、非对象和溢出数值；围栏/BOM/尾逗号修复不改字符串内容。
- Harness 回填 raw_tool_call 和配对失败结果；下一次模型推理获得结构化错误、目标 Schema 和剩余纠错额度。
- 每 Run 按工具保守限制一次纠错机会；累计两次参数失败后阻止该工具的新调用，状态随 Checkpoint 保存。该策略比未来按调查任务划分纠错链更严格，不能宣称已经实现完整语义级纠错链识别。
- 所有模型提出的调用计入总预算；拒绝也消耗额度。恢复已准入调用不重复扣费。
- 重复或缺失调用 ID 在整批执行前拒绝，单批最多 32 个候选。
- BatchExecutor 对只读安全调用采用 allSettled，保持结果顺序，隔离单工具/Guard 异常；动作强制进入串行桶。
- Pipeline 对成功、失败、中断和取消统一发布 TOOL_RESULT；Guard 和 Hook 使用规范化参数。成功 JSON 修复通过 TOOL_PROGRESS 记录规则。

## 兼容性

ToolCall.input、ToolResponse 外壳未替换。新增 RawToolCall、raw_tool_call 消息块、可选 rawToolCalls、可选 Tool.validateSemantics、新错误码及可选 Checkpoint 账本字段。

直接构造 AgentHarness 的宿主需要注入 ToolAdmission；createAgentRuntime 已完成组装。未来真实模型 Formatter 必须支持 raw_tool_call 的协议编码，不能把非法参数编码成正常空对象。

## 验证

Node v20.20.0，pnpm 11.19.0。执行结果：pnpm lint、pnpm typecheck、pnpm test、pnpm build 均通过。5 个测试文件，23 个测试通过，其中新增 19 个测试。测试使用 ScriptedModel 与实际 Harness/Pipeline；没有调用实际 LLM 或外部遥测服务。

本轮包括测试先失败再实现的验证过程：原始参数被忽略、纠错缺失、重复 ID、并行异常丢失结果、失败审计缺失以及 Infinity 输入问题均得到回归覆盖。

## 尚未交付

完整 V1 仍在实现中。真实模型/Formatter、Registry Manifest/快照、MCP 网络客户端、来源 Subagent 自治组装、网络重试与熔断、父子共享预算、SQLite、L0/L1/L2 完整性改造、记忆检索、LangSmith 完整追踪、模拟器和双 Web 均需继续实施。

当前存储仍为内存实现；恢复测试验证序列化状态经过新 Harness 后仍生效，不代表已经支持真实进程重启后的磁盘恢复。语义校验提供接口和拒绝能力，具体 Profile 规则及可审计安全收缩尚未接入。修复审计当前记录规则，原始/结果哈希和持久化事件后端需在审计里程碑补齐。

当前通用 createAgentRuntime 仍保留早期外部 Bash 选项和默认行为。最新批次已新增专用 createInspectionRuntime 排除 Bash、动作和外部执行；实际巡检宿主应使用该只读入口。

项目无 Git 元数据，未创建 commit。没有修改 group-buy-market。
