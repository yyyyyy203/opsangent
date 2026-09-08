# Event / Message V2 一期验收状态

本文件区分已写实现、已验证行为与尚未验收的要求。提交完成不等同于一期验收完成；最终结论以本文件的命令输出和剩余缺口为准。

## 当前证据

- 分支：`codex/event-message-v2`。本轮包含一期验收用例、模型层重复工具事件修复和 AsyncGenerator 恢复收口。
- V2 MessageBlock、Event PayloadMap/Schema、内存/SQLite Store、ReplayBuffer、MessageAssembler、Publisher、ProjectionRunner、Public/V1/Audit/LangSmith 投影均已有实现。
- 默认 runtime 已组装 V2 存储、投影、消息组装和 HTTP/SSE 入口；Harness、模型装饰器、工具执行管线、HITL、Subagent 和数据源韧性链路会产生实际 V2 生命周期事件。
- 工具调用已遵循“准入成功后发布 `TOOL_CALL_CREATED`”语义；模型层不会提前重复发布工具调用事件。四闸门记录保留在有序 `AdmissionGateRecord[]` 中。
- `RetryingChatModel` 使用 AsyncGenerator 适配模型重试：首个流事件前才允许重试，部分输出后失败不重放已输出内容，并支持 Abort、延迟注入和 fallback；fallback 会产生 `MODEL_FALLBACK_ACTIVATED`。
- SQLite 启用 WAL、迁移、条件序列追加、消息版本控制、投影 checkpoint/failure 持久化；`MessageAssemblerV2` 会持久化未完成 assembly 的内部状态，并可在重启后继续 Delta，终态消息不保留该内部元数据。
- V2 runtime 的 V1 `EventBus` 已收敛为 `EventPublisherV2 → V1CompatibilityProjector → EventBus`；V2 模式下 Harness、Tool Pipeline 和外部结果服务不再独立双写 V1 事实。
- `sessionId/replyId/streamId` 会从 Run 传递到模型、工具、Subagent、V2 事件和 LangSmith span；暂停恢复沿用 Run/Reply，创建新的 Stream。
- SQLite runtime 暴露 `ready` 启动恢复 Promise。启动回放默认只补本地 audit、message assembler 和 V1 兼容投影；LangSmith 历史补报必须显式选择，不会因启动恢复自动外发。
- 投影在线处理仍严格阻止乱序跨越缺失序列；只有显式 replay 才允许跳过非持久化 transient 序列空洞，并在回放完成后推进 checkpoint 水位。
- `EventStreamService` 和 Node HTTP 适配器支持初始回放、`Last-Event-ID`、live handoff 去重、Abort，以及 transient Delta 淘汰后的完整消息快照恢复。
- 新增端到端验收覆盖 V1 fixture 读取与 V2→V1 投影、并行工具 ToolCall/ToolResult 配对、公共事件/消息快照脱敏、模型身份链路、SQLite 重启和 transient 序列空洞恢复。
- 最终质量命令已重新执行并全部通过：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`；全量测试为 41 个文件通过、1 个真实 Prometheus 文件按默认配置跳过，211 项通过、1 项跳过。跳过项不计为真实后端验收。

## 当前仍需补齐的缺口

- V2 runtime 的核心生产点已切到单向 V2→V1 兼容投影；仍需继续补齐未纳入 V1 的新事件在旧消费者中的有意忽略/映射说明，以及所有历史 V1 payload 的逐字段兼容测试。
- `ready` 已自动扫描 Store 能发现的 Run 并补本地投影；运行中 pending 队列和投影失败记录仍按现有有界重试策略处理，跨多页超大 Run 的后台回放调度仍需独立运维能力。
- 未完成 assembly 已支持重启续流，但当前使用受控的内部消息元数据保存中间状态；公共 SSE 快照会剥离消息和块 metadata，完整用户消息视图仍需随前端契约继续演进。
- Public/V1 投影已按事件类型提供安全视图，但 V1 payload 语义、reasoning block 的产品展示策略、所有事件的逐字段 allowlist 仍需继续扩展。
- MCP 连接、上下文压缩 L0/L1/L2、MemoryFacade 的生命周期事件契约已定义，当前尚未全部由真实运行时操作触发；Memory 仍是内存实现。
- 当前 HTTP 层是可验证的 Node/SSE 服务入口，Simulator Web 和 Agent Web 前端仍未交付；真实 Prometheus 验收按默认配置跳过，真实模型和生产凭据也未接入。

## 结论

Event/Message V2 的协议地基、主要运行时生产点、持久化/回放、公共与审计投影、AsyncGenerator 模型重试、身份链路和本地启动恢复已经落地并通过定向回归。它可以作为后续巡检 Agent 的稳定事件/消息基础。

但按完整一期计划，以上缺口仍然存在，因此当前结论是“核心已验收，完整生产一期未宣称完成”。
