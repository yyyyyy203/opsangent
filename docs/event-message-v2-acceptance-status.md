# Event / Message V2 一期验收状态

本文件区分已写实现、已验证行为与尚未验收的要求。此前按 Task 标记 complete 仅表示该批代码提交，不等同于一期验收完成。

## 当前证据

- 分支：codex/event-message-v2；SQLite 基础实现提交：6720495。
- 契约、内存存储、消息组装、发布、投影及 SQLite 已有实现。
- 6720495 时测试 165 passed / 1 skipped，typecheck 与 build 通过；真实 Prometheus 测试跳过。
- 已补事件流服务：`EventStreamService.open` 支持初始回放、`Last-Event-ID`、先订阅后 catch-up、live handoff 去重、Abort 清理、未知 cursor 拒绝，以及 transient Delta 过期时用 `message_snapshot` 恢复用户可见消息。
- 已补 `ReplayBufferV2.findById`，cursor 先按 eventId 解析，不把客户端 cursor 退化成猜测 sequence。
- 已修复 V2 基础 lint 债务：内存/SQLite 存储保持 Promise API 且不再使用无 await 的 async 方法；SQLite 写入继续使用 `BEGIN IMMEDIATE`；V2 common/lifecycle/message assembler 的类型问题已清理。
- 最新验证：`pnpm lint` 通过；`pnpm typecheck` 通过；`pnpm build` 通过；`pnpm test` 为 31 files / 182 tests passed，1 个真实 Prometheus 测试按默认配置 skipped。
- 已补 `AuditProjectorV2` 与 `LangSmithEventProjectorV2`：审计记录只保留脱敏结构化摘要；模型、工具、Subagent 使用显式 `spanKey/parentSpanKey` 建立父子关系；模型完成事件记录 usage、cacheHit、TTFT 和耗时；远端观测 start/end/flush 失败不会影响 Agent 主流程。新增投影测试 3 项通过。
- 默认 runtime 已组装 V2 EventStore、ReplayBuffer、Publisher、Public/Audit/LangSmith 投影，并由 Harness/模型装饰器/工具管线实际产生生命周期、内容流、准入、风险、执行和结果事件；HITL 确认、外部执行和恢复也会产生对应事件，恢复事件使用新的 `streamId`。
- 四闸门准入结果现在暴露有序 `AdmissionGateRecord[]`；MCP ResilientExecutor 保留原有重试/熔断预算，并增加数据源 retry 与 circuit 状态回调。
- Subagent 已作为 Tool 适配器接入生命周期事件：子运行拥有独立 `runId`，通过 `parentRunId` 与父运行关联，并发布 `SUBAGENT_STARTED/COMPLETED/FAILED`；新增生命周期单测已通过。
- `ProjectionRunnerV2` 已按 runId 串行处理并缓存乱序事件；前序失败或缺失时不会让后续事件越过 checkpoint，前序恢复后会继续排队事件。
- `createAgentRuntime` 支持注入 `EventStore & MessageStore`，或通过 `sqlitePath` 启用 WAL SQLite；默认内存实现仍用于测试，返回的 `close()` 负责关闭 SQLite。
- 最新增量验证：全量 `pnpm test` 为 36 files / 190 tests passed，1 个真实 Prometheus 测试 skipped；`pnpm typecheck`、`pnpm lint`、`pnpm build` 均通过。

## 接线前必须解决的缺口

- Public projector 默认递归黑名单不满足设计中的逐字段白名单；结构化消息中的工具参数和任意 JSON 仍需专门公共视图。逐 Delta 正则也不能证明分片凭据不会泄露。
- V1 projector 直接复用部分 V2 payload，尚未证明旧消费者字段语义兼容；CONTENT_BLOCK_DELTA 未区分 text 与 reasoning_summary。
- ProjectionRunner 已解决内存运行时的前序失败/乱序越过 checkpoint 问题；仍需把 pending/失败消费状态持久化，覆盖进程重启后的投影补报。
- MessageAssembler 内部状态尚未从磁盘恢复；完整消息落库不等同于组装器重启恢复。
- 已补内存/SQLite 共用测试：同批重复 ID 拒绝且不占序号，无效预留数量不修改状态；SQLite 事件、序号预留与消息写入均使用 BEGIN IMMEDIATE。仍需扩大跨连接并发及损坏记录测试。
- 当前已知质量门槛：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 均已通过。不能把四项命令通过解释为一期完成，因为消息重启恢复、持久化投影消费、真实模型重试/降级、HTTP/SSE bootstrap 和完整数据源 Subagent 接线仍未全部验收。
- EventStreamService 仍是框架无关 SSE frame 生成器，尚未接入实际 HTTP Controller、前端消费端或 runtime bootstrap 默认组装。
- LangSmith 投影目前已接入默认 runtime 的核心生产点，但仍需补齐模型/工具/数据源重试与降级事件的端到端验收、投影幂等消费和有界 flush。

## 剩余实施范围

1. Task 8 剩余：SSE 服务已具备核心回放能力，但仍需全量测试运行、build 验证、与 bootstrap/runtime 的真实装配，以及更严格的公共投影安全测试联动。
2. Task 9：本地审计与 LangSmith 投影，显式父子 span、重试、脱敏、持久化补报和故障隔离。
3. Task 10–11：真实模型、工具准入、执行、重试和熔断的 V2 事件生产点。
4. Task 12：HITL 条件状态转换、确认幂等/过期、外部执行不确定性、暂停后新 streamId 恢复。
5. Task 13：权威 Harness、Subagent、MCP、上下文和记忆接线。
6. Task 14：bootstrap、V1 fixture、端到端验收、知识库及四项质量命令。

一期目标保持完整。上述未验证项全部解决并验收之前，不标记一期完成。
