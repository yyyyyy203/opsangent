# Event / Message V2 一期验收状态

本文件区分已写实现、已验证行为与尚未验收的要求。提交完成不等同于一期验收完成；最终结论以本文件的命令输出和剩余缺口为准。

## 当前证据

- 分支：`codex/event-message-v2`。当前工作树包含一期验收用例和模型层重复工具事件修复。
- V2 MessageBlock、Event PayloadMap/Schema、内存/SQLite Store、ReplayBuffer、MessageAssembler、Publisher、ProjectionRunner、Public/V1/Audit/LangSmith 投影均已有实现。
- 默认 runtime 已组装 V2 存储、投影、消息组装和 HTTP/SSE 入口；Harness、模型装饰器、工具执行管线、HITL、Subagent 和数据源韧性链路会产生实际 V2 生命周期事件。
- 工具调用已遵循“准入成功后发布 `TOOL_CALL_CREATED`”语义；模型层不会提前重复发布工具调用事件。四闸门记录保留在有序 `AdmissionGateRecord[]` 中。
- `RetryingChatModel` 使用 AsyncGenerator 适配模型重试：首个流事件前才允许重试，部分输出后失败不重放已输出内容，并支持 Abort、延迟注入和 fallback；fallback 会产生 `MODEL_FALLBACK_ACTIVATED`。
- SQLite 启用 WAL、迁移、条件序列追加、消息版本控制、投影 checkpoint/failure 持久化；`MessageAssemblerV2` 可在重启后恢复已落库的终态消息。
- `EventStreamService` 和 Node HTTP 适配器支持初始回放、`Last-Event-ID`、live handoff 去重、Abort，以及 transient Delta 淘汰后的完整消息快照恢复。
- 新增端到端验收覆盖 V1 fixture 读取与 V2→V1 投影、并行工具 ToolCall/ToolResult 配对和公共投影脱敏；定向验收 3/3 通过。
- 最终质量命令应记录为：`pnpm lint`、`pnpm typecheck`、`pnpm test`（40 个文件通过、1 个真实 Prometheus 文件按默认配置跳过；203 项通过、1 项跳过）和 `pnpm build` 均通过。

## 当前仍需补齐的缺口

- Legacy `EventBus` 目前仍被 Harness/Tool Pipeline 的兼容路径直接发布，同时 V2 投影也可生成 V1 事件；下一轮应收敛为“V2 EventPublisher → V1CompatibilityProjector → EventBus”，避免双写和语义漂移。
- `ProjectionRunnerV2` 的运行中 pending 队列仍在内存；SQLite 已持久化 checkpoint 和失败记录，但进程重启后的补报需要显式调用 `replayRun`，尚未做自动扫描恢复。
- `MessageAssemblerV2` 已恢复终态快照；未完成流式消息的细粒度 assembly 状态仍未持久化，进程在 Delta 和 Completed 之间退出时不能承诺字符级续流。
- Public/V1 投影已有按事件类型的安全视图和脱敏测试，但 V1 payload 语义映射、reasoning block、所有事件的逐字段 allowlist 仍需继续扩展。
- MCP 连接、上下文压缩 L0/L1/L2、MemoryFacade 的生命周期事件契约已定义，当前尚未全部由真实运行时操作触发；Memory 仍是内存实现。
- 当前 HTTP 层是可验证的 Node/SSE 服务入口，Simulator Web 和 Agent Web 前端仍未交付；真实 Prometheus 验收按默认配置跳过，真实模型和生产凭据也未接入。

## 结论

Event/Message V2 的协议地基、主要运行时生产点、持久化/回放、公共与审计投影、AsyncGenerator 模型重试及当前端到端验收已经落地并通过回归。它可以作为后续巡检 Agent 的稳定事件/消息基础。

但按完整一期计划，以上缺口仍然存在，因此当前结论是“核心已验收，完整生产一期未宣称完成”。
