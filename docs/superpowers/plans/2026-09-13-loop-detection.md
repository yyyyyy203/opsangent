# Loop Detection 实施计划

> **执行约束：** 按任务逐项实施；每项先补确定性测试，再写实现；不在本增量引入 L0/L1/L2 Context Compression、真实写动作或数据源内部实现。
>
> **状态：** 已实施并通过全量质量门禁。

## 目标

按照 `docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md` 的增量 4，实现可恢复、可审计、与 AsyncGenerator 兼容的 Loop Detection：确定性签名、连续终态计数、WARN/HARD/FORCE_BREAK 三级干预、Admission 本地阻断，以及并行批次按原始调用顺序提交。

## 任务 1：契约与适配边界（已完成）

- 扩展模型调用选项，支持可选 `toolChoice: 'none'`；OpenAI-compatible formatter/client 只在调用方明确要求时发送 `tool_choice`。
- 将 Loop Detection 作为现有 `LOOP_DETECTED` V2 Subsystem 事件的生产路径，并将其安全字段投影到 public SSE；不改变既有事件字段语义。
- 为 Admission 增加明确的 loop-detection 拒绝语义；原有四道 JSON/Schema/语义闸门保持不变。

## 任务 2：纯函数签名与策略（已完成）

- 新增 `src/agent/loop-detection/`，分离输入归一化/摘要、确定性签名和策略状态转换。
- 签名只保留 stage、tool、稳定输入摘要、终态、脱敏结构化结果摘要；移除时间戳、随机 ID、游标和原始正文。
- 只统计 `success`、`failed`、`timeout`，以及原因严格为 `already_executed` 的 `skipped`；排除 admission reject、interrupted、awaiting external、abort 和其他 skipped。
- 在 3/5/7 次连续相同签名时分别产生 WARN/HARD/FORCE_BREAK；状态变更不可变、历史有上限，且可通过现有 checkpoint codec 无损恢复。
- `blockedSignatures` 存储可在 Admission 阶段计算的调用签名；完整结果签名只用于计数和审计事件。由于 Admission reject 不计数，FORCE_BREAK 的 7 次路径也覆盖同一批次中已先行 Admission 的并行/在途结果，避免用被拦截尝试伪造执行计数。

## 任务 3：Admission 与 Harness 接入（已完成）

- 在 Harness 的主循环和恢复执行路径接入 loop block predicate；HARD 后相同调用在真正 ToolRunner 之前确定性拒绝。
- WARN 只注入尾部动态模型提示，不写入稳定历史；HARD 在 Adapter 支持时附加 `toolChoice: 'none'`，本地阻断仍是安全保证。
- FORCE_BREAK 保存当前已产生的部分诊断、`missingEvidence` 和终态错误，发布 `LOOP_DETECTED` 后以不可重试 `LOOP_DETECTED` 结束 Run。

## 任务 4：并行顺序与耐久事务（已完成）

- 调整 Harness completion callback 协调器：并行工具仍可同时执行，但 LoopState、工具终态和治理 effects 按原始 ToolCall 顺序处理。
- Durable 模式下把 LoopState 更新、ToolResult、治理 effects 和对应 `LOOP_DETECTED` 事件放入同一个 transition/outbox 提交；提交成功后才让事件可见。
- 非 Durable 模式保持 AsyncGenerator V1 事件顺序与当前行为一致，并通过独立 V2 publisher 发布循环事件。
- 处理流消费者提前关闭、Abort、暂停和恢复：这些状态不进入连续计数，恢复后继续使用 checkpoint 中的 LoopState。

## 任务 5：测试、文档与门禁（已完成）

- 先写 RED 测试，再实现 GREEN：签名稳定性、过滤规则、3/5/7 阈值、Admission 阻断、toolChoice 透传、public projection、并行原始顺序、durable 同事务和恢复计数。
- 更新 Spec 的增量 4 状态和验证记录。
- 执行 `pnpm lint`、`pnpm typecheck`、`pnpm exec vitest run --reporter=dot`、`pnpm build`、`git diff --check`。
- 单独审查是否泄漏原始工具输入、日志、内部地址、密钥或完整结果正文。

## 非目标

- 不实现 L0/L1/L2 上下文压缩、ELK/Trace Blob 摄取、MemoryFacade 持久化或真实写动作。
- 不把循环检测放入具体 Tool、MCP Adapter 或 API Controller。
- 不删除/改名既有 V1/V2 事件、MessageBlock、ToolResponse 或 checkpoint 字段；新增字段必须向后兼容。
