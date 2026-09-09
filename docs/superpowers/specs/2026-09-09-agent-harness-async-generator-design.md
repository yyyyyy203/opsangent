# AgentHarness AsyncGenerator 主循环改造设计

## 1. 目标与背景

改造前的 `AgentHarness` 公开 `replyStream()` 虽然返回 `AsyncGenerator`，但内部仍是：

```text
run() Promise
  → EventBus
  → AsyncEventQueue
  → replyStream() yield
```

本设计按照用户提供的 AgentHarness AsyncGenerator 文档，将执行主循环改为直接由 Generator 产生事件：

```text
replyStream()
  → async *run()
  → async *mainLoop()
  → 直接 yield V1 AgentEvent
```

目标不是改变已经发布的 V2 事件契约，而是移除 Harness 内部的事件队列桥接，使 Generator 的生命周期与暂停/恢复语义一致：

- `yield` 表示向调用方推送一个事件；
- 暂停、完成或失败时 Generator `return`；
- `finally` 统一保存最新 Checkpoint；
- 恢复创建新的 Generator，沿用原 `runId` 和 `replyId`，生成新的 `streamId`。

本设计已在 `codex/event-message-v2` 分支落地；具体实现状态、验证命令和剩余缺口以 [实现进度](../../implementation-status.md) 与 [V2 验收状态](../../event-message-v2-acceptance-status.md) 为准。

## 2. 与项目约束的兼容决策

附件文档是 Newton 行为参考，不覆盖本项目 `AGENTS.md` 的安全和契约约束。以下差异是有意保留的：

1. V2 事件仍是权威事实源。`publishV2()` 继续将事件按序写入 V2 Publisher/Store，并等待发布完成；它不向 V1 Generator 直接 yield V2 Envelope，也不允许无序 fire-and-forget。
2. `publishStream()` 产生 V1 `AgentEvent` 并 yield 给 `replyStream()` 消费者。无 V2 注入时，它同时发布到旧 EventBus；有 V2 注入时，EventBus 的兼容事件仍由 V2→V1 Projector 产生，避免同一事实被旧总线写入两次。
3. 不引入 `replyStream({ event })` 作为恢复命令。HITL 和外部执行结果继续由显式应用服务处理，再调用兼容的 `resumeStream(runId)`；这符合项目“事件用于通知、命令使用显式接口”的约束。
4. 不持久化 `resumeHandler` 闭包，也不把 Checkpoint 缩减为三个字段。完整 `AgentContext`、预算、消息、证据、待执行动作和可序列化中断状态继续持久化，以支持进程重启和幂等恢复。

## 3. 公共接口与执行结构

### 3.1 公共接口保持兼容

不改变以下公开签名的返回类型：

```typescript
reply(options: ReplyOptions): Promise<DiagnosisRunResult>
replyStream(options: ReplyOptions): AsyncGenerator<AgentEvent, DiagnosisRunResult>
resumeStream(runId: string, signal?: AbortSignal): AsyncGenerator<AgentEvent, DiagnosisRunResult>
```

`reply()` 继续通过 `.next()` drain `replyStream()` 并返回 Generator 的最终值。HTTP 层的 `consume()` 继续 drain Generator，并将事件交给独立的 V2 SSE 回放服务。

### 3.2 内部方法

`AgentHarness` 内部调整为以下结构：

```typescript
private async *run(
  frame: RunExecutionFrame,
  signal: AbortSignal,
  resumed: boolean,
): AsyncGenerator<AgentEvent, DiagnosisRunResult>

private async *mainLoop(
  frame: RunExecutionFrame,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, DiagnosisRunResult>

private async *reasonStream(
  context: AgentContext,
  stepId: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, ModelResponse>

private async *resumePendingToolCallStream(
  frame: RunExecutionFrame,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, boolean>
```

`RunExecutionFrame` 是单次 Generator 生命周期内的可变容器，至少保存当前 `context` 和最终文本：

```typescript
interface RunExecutionFrame {
  context: AgentContext;
  finalText: string;
}
```

这样 `mainLoop()` 即使因 L0/L1/L2 压缩替换了 `AgentContext`，外层 `finally` 仍能保存最新对象，而不依赖全局状态。

## 4. 事件输出规则

### 4.1 V1 Generator 主通道

`publishStream()` 改为 AsyncGenerator：

```typescript
private async *publishStream(...): AsyncGenerator<AgentEvent, void> {
  const event = this.dependencies.eventFactory.create(...);
  if (this.dependencies.v2Events === undefined) {
    await this.dependencies.events.publish(event);
  }
  yield event;
}
```

所有 V1 事件调用点使用 `yield* this.publishStream(...)`。调用顺序必须保持现有顺序，包括：

```text
RUN_STARTED
STEP_STARTED
REASONING_STARTED
TEXT_DELTA*
TOOL_CALL_CREATED*
TOOL_STARTED / TOOL_PROGRESS / TOOL_RESULT
REQUIRE_CONFIRM 或 EXTERNAL_TOOL_REQUESTED
RUN_PAUSED / RUN_FINISHED / RUN_FAILED
```

### 4.2 V2 侧路

`publishV2()` 保持 Promise 方法，并在每个调用点 `await`：

```text
V2 factory.create()
  → EventPublisherV2.publish()
  → EventStore
  → Public/Audit/LangSmith/V1 Projector
```

它不 yield V2 Envelope，原因是 `DiagnosisAgent` 的公共 Generator 契约仍返回 V1 `AgentEvent`，并且 V2 Publisher 必须按序完成持久化。V2 SSE 继续通过 `EventStreamService` 从 Store/ReplayBuffer 获取事件。

### 4.3 工具事件直通 Generator

删除 Harness 内部 `AsyncEventQueue` 后，工具执行链不能继续只向 EventBus/V2 侧路发布，否则 V2 运行时的 `replyStream()` 会丢失 `TOOL_STARTED`、`TOOL_PROGRESS` 和 `TOOL_RESULT`。本轮同时改造工具执行链：

1. `ToolRunner` 增加 `stream()` AsyncGenerator，逐个产出 `ToolResponseChunk`；原有 `execute()` 保留为 drain `stream()` 的兼容包装。
2. `ToolExecutionPipeline` 增加 `executeStream()`，执行前后和 chunk 事件都产出 V1 `AgentEvent`；原有 `execute()` 保留为 drain `executeStream()` 的兼容包装。
3. `ToolBatchExecutor` 增加 `executeStream()`。safe 工具的 Generator 通过一个基于 `Promise.race` 的流合并器并行转发，unsafe 工具仍串行执行；最终结果按输入 ToolCall 顺序返回，事件顺序按实际流到达顺序转发。
4. `AgentHarness` 手动 drain `ToolBatchExecutor.executeStream()` 并 `yield` 每个事件，保留批次结果和中断结果的确定性处理。

V1 Generator 与 V2→V1 Projector 的公共事件使用同一组安全 payload 规则：工具创建事件只暴露 `id/name`，工具开始事件暴露 `toolCallId/toolName/source/attempt/deadline`，工具进度统一映射为 V1 `TOOL_PROGRESS`，外部执行和确认事件使用 V2 的安全交互 payload。比较事件一致性时忽略独立生成的 V1/V2 时间戳，但 `type/runId/stepId/payload` 必须一致；时间戳仍单独验证为合法且单调。

为保留既有 V1 `RUN_FINISHED.finalText`，V2 `RUN_FINISHED` 增加可选 `finalText` 字段。这是 schema v2 的向后兼容字段扩展，旧事件缺失该字段时按无文本处理。

## 5. 暂停、恢复与 Checkpoint

### 5.1 新对话

`replyStream()` 创建 `RunExecutionFrame` 后直接委托给 `run()`。`run()` 负责创建 root span、发布 `RUN_STARTED`，然后委托给 `mainLoop()`。

### 5.2 暂停

在确认或外部执行中断点：

1. `mainLoop()` yield 对应 V1/V2 事件；
2. 更新 `frame.context.status`、`pendingInterrupt`、`pendingToolCalls`；
3. 返回 `DiagnosisRunResult`，结束当前 Generator；
4. `run()` 的 `finally` 保存完整 `frame.context` 并 flush observability。

不保存函数闭包。中断只保存 `hookId`、`interruptType`、`toolCallId`、payload 和有效期；实际恢复由显式 HITL/外部执行服务完成。

### 5.3 恢复

`resumeStream(runId)` 保持现有签名：

1. 加载完整 Checkpoint；
2. 补齐旧 Checkpoint 缺失的 `sessionId/replyId`；
3. 生成新的 `streamId`；
4. 发布 `RUN_RESUMED` V2 事件；
5. 执行已确认的 pending ToolCall，若再次进入外部执行暂停则直接返回；
6. 委托给同一个 `mainLoop()` 继续推理。

`HitlService` 和 `ExternalToolResultService` 仍是恢复前的显式状态变更入口，不把外部事件对象直接当作 Harness 命令路由。

### 5.4 统一 finally

`run()` 使用统一 `try/catch/finally`：

- `try`：启动或恢复并委托 `mainLoop()`；
- `catch`：转换错误、更新失败状态、发布 `STEP_FAILED/RUN_FAILED`，返回失败结果；
- `finally`：保存 `frame.context`，然后 flush observability。

显式分支中的 Checkpoint 保存只保留必要的中途一致性保存；最终 Generator 结束必须经过外层 finally。Abort、正常结束、暂停、模型失败和消费者关闭都必须有对应测试。

### 5.5 消费者提前关闭

当调用方在 Generator 自然结束前调用 `return()` 或 `throw()`：

1. `run()` 的 `finally` 将仍处于活动生命周期的 Context 标记为 `cancelled`，写入 `ABORTED` 失败信息，并发布 V2 `RUN_CANCELLED(actor: 'stream_consumer', reason: 'stream_consumer_closed')`；不尝试向已关闭的 Generator yield 事件。
2. `finally` 保存完整 Checkpoint 并 flush observability；如果此前已经自然完成、失败或取消，则不重复改写终态。
3. `AbortSignal` 取消继续走统一错误路径，保留 `ABORTED` 错误码和已有错误事件行为。

## 6. 不变的 V2 与安全行为

- 保留所有现有 `publishV2()` 调用、payload 和身份字段。
- 保留工具四闸门、Hook、HITL、幂等和动作白名单。
- 保留 `runId/sessionId/replyId/streamId/stepId/attemptId/toolCallId/evidenceId` 传播。
- 不改变 V2 EventStore、ReplayBuffer、Projector 和公共 SSE 契约。
- 不接入真实写动作，不改变 ELK/Trace/前端范围。
- 不将内部参数修复、原始工具参数或模型思维链通过公共 Generator 暴露。

## 7. 测试与验收

新增或调整测试覆盖：

1. `replyStream()` 直接 yield V1 事件，`reply()` drain 后仍返回相同最终结果。
2. V2 runtime 中 Generator V1 输出与 V2 EventStore/V1 compatibility EventBus 各自只产生一条逻辑事件，不发生 V2 持久化重复。
3. 模型 `TEXT_DELTA` 通过 `reasonStream()` Generator 按顺序输出。
4. 正常完成、模型失败、Abort、预算耗尽和消费者提前关闭均执行最终 Checkpoint 保存。
5. HITL 确认、拒绝、过期和外部执行暂停/恢复仍保持事件顺序和动作幂等。
6. 重启后加载 Checkpoint，恢复 Generator，继续 `mainLoop()`，不重复执行已成功动作。
7. HTTP `consume()` 行为不变，SSE 仍从 V2 事件回放服务读取。

提交前运行：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

真实 Prometheus 测试仍需显式启用；默认跳过不视为线上后端验收。

## 8. 明确不在本轮范围

- 不增加 `replyStream({ resumeEvent })` 公共命令接口。
- 不实现 Newton 的 `resumeHandler` 闭包序列化/重建方案。
- 不把完整 Checkpoint 缩减为三个字段。
- 不让 V2 Envelope 混入 V1 `AgentEvent` Generator 类型。
- 不在本轮实现 Agent Web、ELK、Trace 或真实模型接入。
