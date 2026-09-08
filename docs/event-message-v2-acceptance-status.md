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

## 接线前必须解决的缺口

- Public projector 默认递归黑名单不满足设计中的逐字段白名单；结构化消息中的工具参数和任意 JSON 仍需专门公共视图。逐 Delta 正则也不能证明分片凭据不会泄露。
- V1 projector 直接复用部分 V2 payload，尚未证明旧消费者字段语义兼容；CONTENT_BLOCK_DELTA 未区分 text 与 reasoning_summary。
- ProjectionRunner 在较早事件失败后允许后续 checkpoint 前进，可能跳过旧事件补报；需要失败恢复测试与持久化消费记录。
- MessageAssembler 内部状态尚未从磁盘恢复；完整消息落库不等同于组装器重启恢复。
- 已补内存/SQLite 共用测试：同批重复 ID 拒绝且不占序号，无效预留数量不修改状态；SQLite 事件、序号预留与消息写入均使用 BEGIN IMMEDIATE。仍需扩大跨连接并发及损坏记录测试。
- 当前已知质量门槛：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 均已通过。不能把四项命令通过解释为一期完成，因为运行时生产点和 Audit/LangSmith 等范围尚未实现完。
- EventStreamService 仍是框架无关 SSE frame 生成器，尚未接入实际 HTTP Controller、前端消费端或 runtime bootstrap 默认组装。
- LangSmith 投影目前已具备事件到 span 的核心映射，但仍需接入真实 runtime 生产点，并补齐重试/降级事件、幂等消费和有界 flush 的集成验收。

## 剩余实施范围

1. Task 8 剩余：SSE 服务已具备核心回放能力，但仍需全量测试运行、build 验证、与 bootstrap/runtime 的真实装配，以及更严格的公共投影安全测试联动。
2. Task 9：本地审计与 LangSmith 投影，显式父子 span、重试、脱敏、持久化补报和故障隔离。
3. Task 10–11：真实模型、工具准入、执行、重试和熔断的 V2 事件生产点。
4. Task 12：HITL 条件状态转换、确认幂等/过期、外部执行不确定性、暂停后新 streamId 恢复。
5. Task 13：权威 Harness、Subagent、MCP、上下文和记忆接线。
6. Task 14：bootstrap、V1 fixture、端到端验收、知识库及四项质量命令。

一期目标保持完整。上述未验证项全部解决并验收之前，不标记一期完成。
