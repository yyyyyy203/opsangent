# Event 与 Message V2 协议

## 1. 决策与范围

Event 和 Message 是一期最先完成的公共协议层。它们不是前端专用 DTO，而是 Agent Harness、模型、工具、四道闸门、HITL、Subagent、MCP、上下文压缩、记忆、SSE、审计和 LangSmith 共同依赖的稳定事实契约。

一期必须完成：

- Event V2 强类型契约和全部事件族。
- Message V2 与全部 MessageBlock。
- ID 生命周期、事件顺序、关联、因果关系、可见性和脱敏规则。
- AsyncGenerator 流式输出、SSE 断线续传、事件存储和回放。
- Public SSE、Audit、LangSmith 三类投影。
- V2 到 V1 的兼容投影。
- 当前已有执行链路的真实事件发射；尚未实现的业务模块先完成生命周期包装器，模块实际运行时再发射事件，禁止伪造生产事件。
- Schema、序列化、顺序、回放、兼容、脱敏和暂停恢复测试。

Event/Message V2 是新增版本，不删除、不改名、不改变 V1 已发布字段语义。运行时只产生一套权威 V2 事实，V1 由兼容投影器生成，禁止双写两套相互独立的事实。

## 2. 设计原则

1. **一条事实只发布一次**：前端、审计和 LangSmith 从同一权威事件投影，不由业务模块分别上报。
2. **事件通知，接口执行**：事件不能作为执行工具、恢复 Run 或批准动作的命令总线；这些操作使用显式应用接口。
3. **强类型**：事件类型与 payload 通过 `AgentEventPayloadMap` 一一对应，不允许公共事件回退为 `Record<string, unknown>`。
4. **流式优先**：消息和长工具结果采用 Start/Delta/Completed；最终结构化结果仍是上下文和审计的完整事实。
5. **可恢复**：暂停结束当前 AsyncGenerator；恢复创建新的 Stream，但沿用原 Run 和逻辑 Reply。
6. **可回放**：事件有稳定 ID 和 Run 内序号；重复消费不得重复执行动作。
7. **安全可见**：内部参数修复、原始工具参数和供应商错误不能未经脱敏进入公共 SSE。
8. **不暴露思维链**：只允许保存和展示可审计的 `reasoning_summary`，不保存模型原始 Chain-of-Thought。

## 3. 标识与生命周期

| 标识 | 生命周期与语义 |
|---|---|
| `sessionId` | 长期前端会话，可包含多次巡检 Run。 |
| `runId` | 一次完整巡检任务；暂停、恢复和 SSE 重连后保持不变。 |
| `replyId` | 一次逻辑 Agent 回复；暂停恢复后保持不变。 |
| `streamId` | 一次 AsyncGenerator/SSE 连接；每次恢复或重连生成新的值。 |
| `stepId` | 一次 ReAct 迭代。 |
| `attemptId` | 一次模型、工具、数据源或 Subagent 尝试；重试时变化。 |
| `toolCallId` | 一次逻辑工具调用；工具重试时保持不变，由 `attemptId` 区分尝试。 |
| `eventId` | 全局唯一事件标识，用于幂等消费。 |
| `sequence` | 同一 `runId` 内严格递增，由 EventStore 分配。 |
| `correlationId` | 贯穿主 Agent、Subagent、模型、工具和外部查询的相关链。 |
| `causationId` | 直接导致当前事件的上一个事件 ID。 |
| `parentRunId` | Subagent Run 指向主 Agent Run；主 Run 不设置。 |

业务 Trace 使用 `businessTraceIds`，Agent 自身可观测使用 `correlationId` 及 LangSmith trace/span 标识，两者不能因字段同名而混为父子链路。

## 4. Event V2 公共信封

目标类型形态：

```ts
type EventVisibility = 'public' | 'audit' | 'internal';
type EventDurability = 'durable' | 'transient';

interface AgentEventEnvelope<T extends AgentEventTypeV2> {
  schemaVersion: 2;
  eventId: string;
  sequence: number;
  type: T;
  payload: AgentEventPayloadMap[T];

  runId: string;
  sessionId?: string;
  replyId?: string;
  streamId?: string;
  stepId?: string;
  attemptId?: string;
  toolCallId?: string;
  parentRunId?: string;

  correlationId: string;
  causationId?: string;
  timestamp: string;
  visibility: EventVisibility;
  durability: EventDurability;
}
```

约束：

- durable 事件必须先成功追加到 EventStore，再交给订阅者；transient 事件可用于高频进度，但不得承载恢复必需事实。
- `RUN_*`、确认结果、外部执行结果、最终 ToolResult、诊断结论、动作事实和 Checkpoint 关联事件必须 durable。
- Delta 可以 transient，但 MessageAssembler 必须周期性或在 Completed 时保存完整块，SSE 只承诺在配置的短期重放窗口内恢复 Delta。
- `sequence` 通过 `append(runId, expectedSequence, events)` 条件追加产生，防止双执行器并发写乱序。
- EventSink 订阅者失败不得回滚已经完成的工具或动作；投影失败进入独立重试/死信状态。

`visibility` 采用分层语义：`public` 事件可进入公共界面，同时可进入脱敏后的审计和 LangSmith 投影；`audit` 不进入公共界面；`internal` 只供本地机制与诊断使用。下表中的 `public/audit` 表示该事实对公共界面可见且也会被审计投影消费，信封内仍只写单值 `public`。

## 5. 一期事件目录

### 5.1 Run、步骤和阶段

| 事件 | 可见性 | 关键 payload |
|---|---|---|
| `RUN_STARTED` | public/audit | profile、trigger、deadline、版本快照 |
| `RUN_RESUMED` | public/audit | checkpointVersion、resumeReason、newStreamId |
| `RUN_PAUSED` | public/audit | interruptId、reason、expiresAt、checkpointVersion |
| `RUN_FINISHED` | public/audit | outcome、reportId、usage、durationMs |
| `RUN_FAILED` | public/audit | 结构化错误、阶段、可恢复性 |
| `RUN_CANCELLED` | public/audit | actor、reason、stage |
| `RUN_TIMED_OUT` | public/audit | deadline、stage、partialResultId |
| `RUN_BUDGET_WARNING` | public/audit | budgetType、used、limit、remaining |
| `RUN_BUDGET_EXHAUSTED` | public/audit | budgetType、used、limit、exitPolicy |
| `STEP_STARTED` | public/audit | iteration、stage、budgetSnapshot |
| `STEP_COMPLETED` | audit | iteration、exitDecision、durationMs |
| `STEP_FAILED` | audit | iteration、错误和可重试性 |
| `STAGE_CHANGED` | public/audit | from、to、reason |
| `REASONING_STARTED` | public/audit | 诊断 stage、目标说明 |

`budgetType` 统一为 `iterations | tokens | time | evidence | cost | tool_calls`。超过最大迭代数使用 `RUN_BUDGET_EXHAUSTED`，不再建立语义重复的异常出口。

### 5.2 模型调用

| 事件 | 可见性 | 关键 payload |
|---|---|---|
| `MODEL_CALL_STARTED` | audit/internal | provider、model、purpose、attempt、输入摘要 |
| `MODEL_RETRY_SCHEDULED` | public/audit | attempt、reasonCode、delayMs、correctionChainId |
| `MODEL_FALLBACK_ACTIVATED` | public/audit | fromProvider/model、toProvider/model、reasonCode |
| `MODEL_CALL_COMPLETED` | audit | usage、缓存命中、TTFT、durationMs、finishReason |
| `MODEL_CALL_FAILED` | audit | 错误、attempt、retryable、durationMs |

`REASONING_STARTED` 描述 Agent 诊断阶段，`MODEL_CALL_STARTED` 描述一次供应商调用，两者不能互相替代。模型 payload 不保存完整系统提示词、密钥或未经脱敏的原始证据。

### 5.3 消息与内容块流

| 事件 | 可见性 | 关键 payload |
|---|---|---|
| `MESSAGE_STARTED` | public/audit | messageId、role、status |
| `CONTENT_BLOCK_STARTED` | public/audit | messageId、blockId、blockType、index |
| `CONTENT_BLOCK_DELTA` | public/audit | messageId、blockId、delta、index |
| `CONTENT_BLOCK_COMPLETED` | public/audit | messageId、blockId、blockSummary；非文本块携带完整结构化 block，文本块由 Delta 收敛 |
| `MESSAGE_COMPLETED` | public/audit | messageId、usage、completedAt |
| `MESSAGE_FAILED` | public/audit | messageId、结构化错误 |

现有 `TEXT_DELTA` 由兼容投影器从 `CONTENT_BLOCK_DELTA(blockType=text)` 生成。参数尚未完成时不发公共 `TOOL_CALL_DELTA`；工具参数构造过程只允许以脱敏 internal 事件记录。

### 5.4 工具、四道闸门与结果流

| 事件 | 可见性 | 关键 payload |
|---|---|---|
| `TOOL_CALL_ADMISSION_UPDATED` | audit/internal | gate、outcome、attempt、errorCode |
| `TOOL_CALL_REPAIR_STARTED` | audit | repairStrategy、correctionChainId |
| `TOOL_CALL_REPAIR_COMPLETED` | audit | strategy、changedPaths、attempt |
| `TOOL_CALL_REPAIR_FAILED` | audit | strategy、错误、nextAction |
| `TOOL_CALL_REJECTED` | public/audit | toolName、gate、稳定错误码 |
| `TOOL_CALL_CREATED` | public/audit | 已通过闸门的规范化 ToolCall、显示信息 |
| `TOOL_STARTED` | public/audit | toolName、source、attempt、deadline |
| `TOOL_PROGRESS` | public | progress、displaySummary |
| `TOOL_OUTPUT_DELTA` | public/audit | blockId、textDelta 或 artifact progress |
| `TOOL_RETRY_SCHEDULED` | public/audit | attempt、reasonCode、delayMs |
| `TOOL_RESULT` | public/audit | 完整 ToolExecutionResult、durationMs、evidenceIds |
| `TOOL_FAILED` | public/audit | 结构化错误、attempt、retryable |
| `TOOL_CANCELLED` | public/audit | actor、reason、partialArtifactIds |

四道闸门固定为：

```text
tool_existence → json_parse → schema_validation → semantic_validation
```

`TOOL_CALL_CREATED` 只在四道闸门通过后产生。本地 JSON 修复失败时可把空对象交给下一道 Schema 校验以生成确定性错误，但禁止用空对象绕过校验执行工具。需要 LLM 纠错时产生 `MODEL_RETRY_SCHEDULED`，并沿用 `correctionChainId`；纠错预算耗尽后产生 `TOOL_CALL_REJECTED` 和配对的失败 ToolResult。

### 5.5 Guard、HITL 与外部执行

| 事件 | 可见性 | 关键 payload |
|---|---|---|
| `RISK_EVALUATED` | public/audit | findings、mergedRisk、policyVersion |
| `CONFIRMATION_REQUESTED` | public/audit | confirmationId、toolCallIds、风险摘要、expiresAt |
| `CONFIRMATION_RESOLVED` | public/audit | decision、actor、toolCallIds、decidedAt |
| `CONFIRMATION_EXPIRED` | public/audit | confirmationId、toolCallIds、expiredAt |
| `EXTERNAL_EXECUTION_REQUESTED` | public/audit | requestId、toolCallId、interactionPayload、expiresAt |
| `EXTERNAL_EXECUTION_RESOLVED` | public/audit | requestId、结果块、externalExecutionType |
| `EXTERNAL_EXECUTION_UNCERTAIN` | public/audit | requestId、原因、requiredVerification |

Guard 只负责 `RISK_EVALUATED`。确认统一由 HITL 状态机负责，不为 Guard 再建第二套确认状态机。`CONFIRMATION_RESOLVED` 先由应用接口持久化，新的执行租约获得后产生 `RUN_RESUMED`。确认只对列出的具体 `toolCallId` 生效。

V1 `REQUIRE_CONFIRM`、`EXTERNAL_TOOL_REQUESTED` 和相关结果由兼容投影产生。

### 5.6 证据、诊断和动作验证

| 事件 | 可见性 | 关键 payload |
|---|---|---|
| `EVIDENCE_COLLECTION_STARTED` | public/audit | source、queryWindow、planItemId |
| `EVIDENCE_COLLECTED` | public/audit | evidenceIds、coverage、source、summary |
| `EVIDENCE_COLLECTION_FAILED` | public/audit | source、错误、missingEvidence |
| `HYPOTHESIS_UPDATED` | public/audit | candidates、evidenceIds、missingEvidence |
| `DIAGNOSIS_COMPLETED` | public/audit | outcome、reportId、evidenceIds、limitations |
| `ACTION_PROPOSED` | public/audit | actionId、toolCallId、risk、expectedEffect |
| `ACTION_EXECUTED` | public/audit | actionId、result、idempotencyKey、uncertainty |
| `ACTION_VERIFICATION_STARTED` | public/audit | actionId、verificationPlan |
| `ACTION_VERIFICATION_COMPLETED` | public/audit | actionId、observedEffect、evidenceIds |
| `ACTION_VERIFICATION_FAILED` | public/audit | actionId、错误、requiredFollowup |

事实、推断和建议必须分开；诊断、假设和验证结果引用 `evidenceIds`，不得只保存自然语言结论。

### 5.7 Subagent、MCP、数据源重试与熔断

| 事件 | 可见性 | 关键 payload |
|---|---|---|
| `SUBAGENT_STARTED` | public/audit | subagentType、childRunId、parentRunId、预算 |
| `SUBAGENT_PROGRESS` | public | childRunId、stage、displaySummary |
| `SUBAGENT_RETRY_SCHEDULED` | public/audit | childRunId、attempt、reasonCode |
| `SUBAGENT_FALLBACK_ACTIVATED` | public/audit | childRunId、fallbackMode、reasonCode |
| `SUBAGENT_COMPLETED` | public/audit | childRunId、status、evidenceIds、coverage |
| `SUBAGENT_FAILED` | public/audit | childRunId、错误、partialEvidenceIds |
| `MCP_CONNECTION_STARTED` | audit | serverId、transport、attempt |
| `MCP_CONNECTION_COMPLETED` | audit | serverId、capabilitySnapshotVersion、durationMs |
| `MCP_CONNECTION_FAILED` | public/audit | serverId、错误、retryable |
| `MCP_CONNECTION_DEGRADED` | public/audit | serverId、unavailableCapabilities、fallback |
| `DATASOURCE_RETRY_SCHEDULED` | public/audit | sourceId、attempt、reasonCode、delayMs |
| `DATASOURCE_CIRCUIT_OPENED` | public/audit | sourceId、failureWindow、openUntil |
| `DATASOURCE_CIRCUIT_HALF_OPENED` | audit | sourceId、probePolicy |
| `DATASOURCE_CIRCUIT_CLOSED` | public/audit | sourceId、recoveryEvidence |
| `DATASOURCE_FALLBACK_ACTIVATED` | public/audit | sourceId、fallbackSource/mode、limitations |

每类数据源 Subagent 对外仍是 Tool，因此外层同时存在 Tool 事件和 Subagent 事件：Tool 事件描述主 Agent 的调用边界，Subagent 事件描述子 Harness 的内部生命周期。二者通过 `toolCallId`、`childRunId` 和 `parentRunId` 关联，而不是互相替代。

### 5.8 上下文、压缩和记忆

| 事件 | 可见性 | 关键 payload |
|---|---|---|
| `CONTEXT_COMPRESSION_STARTED` | audit | level、reason、beforeSize |
| `CONTEXT_COMPRESSED` | public/audit | level、before/after、offloadedEvidenceIds、savedTokens |
| `CONTEXT_COMPRESSION_FAILED` | audit | level、错误、fallbackPolicy |
| `CONTEXT_INTEGRITY_REPAIRED` | audit | repairType、affectedIds、validationResult |
| `MEMORY_RETRIEVAL_STARTED` | audit | scopes、filters、limit |
| `MEMORY_RETRIEVAL_COMPLETED` | audit | hitCount、memoryIds、durationMs |
| `MEMORY_RETRIEVAL_FAILED` | audit | 错误、fallbackPolicy |
| `MEMORY_UPDATE_SCHEDULED` | audit | candidateType、sourceRunId |
| `MEMORY_UPDATE_COMPLETED` | audit | memoryId、status、eligibility |
| `MEMORY_UPDATE_FAILED` | audit | 错误、candidateId |
| `EXPERIENCE_CANDIDATE_CREATED` | audit | candidateId、evidenceIds、qualityStatus |
| `EXPERIENCE_REVIEWED` | audit | candidateId、decision、reviewer |

记忆事件只记录引用、筛选条件和统计，不把完整长期记忆复制到公共事件。模拟案例必须保留不可晋级标记。

## 6. Message V2

```ts
interface AgentMessageV2 {
  schemaVersion: 2;
  id: string;
  runId: string;
  sessionId?: string;
  replyId?: string;
  stepId?: string;
  parentMessageId?: string;

  role: 'system' | 'user' | 'assistant' | 'tool';
  status: 'streaming' | 'completed' | 'failed' | 'interrupted';
  visibility: 'model' | 'user' | 'audit';
  blocks: MessageBlockV2[];

  createdAt: string;
  completedAt?: string;
  metadata?: Record<string, JsonValue>;
}
```

Message 是可持久化的逻辑消息，Event 是消息和运行状态发生变化的事实流。Delta 事件不能成为最终 Message 的唯一存储；`MESSAGE_COMPLETED` 前必须得到可校验的完整消息快照。

### 6.1 MessageBlock V2

一期支持：

- `text`：用户可见文本。
- `reasoning_summary`：经过安全处理的推理说明，不是原始思维链。
- `tool_call`：已经规范化并通过闸门的调用。
- `raw_tool_call`：模型原始调用边界，仅限 audit/internal。
- `tool_result`：与 `toolCallId` 配对的完整结果。
- `evidence_ref`：证据引用、摘要、来源和可回查状态。
- `artifact_ref`：日志文件、报告、大型输出等产物引用。
- `image_ref`：图片产物引用，不内联大体积二进制。
- `context_summary`：结构化压缩摘要。
- `confirmation_request`：待确认动作和风险摘要。
- `confirmation_result`：批准、拒绝、过期或取消结果。
- `diagnosis`：结构化诊断结论、候选根因、证据和缺口。
- `action_proposal`：建议动作、风险、预期效果和验证计划。
- `action_result`：执行结果、幂等信息和验证引用。
- `error`：稳定错误码、分类、可重试性和安全文案。

每个块必须有稳定 `blockId`，并按类型定义独立 interface。不得使用一个带大量可选字段的万能块。`metadata` 只能包含可序列化 JSON，禁止 SDK 对象、Error 实例、函数和闭包。

### 6.2 Message 完整性

- 每个 `tool_call` 最终必须对应一个 `tool_result`，包括拒绝、取消、超时和跳过。
- `raw_tool_call` 不直接发送给用户或未经处理地重新注入模型。
- `tool_result` 必须包含 `toolCallId`、状态、稳定错误码、attempt 摘要和证据引用。
- `diagnosis` 必须包含 outcome、候选根因、`evidenceIds`、`missingEvidence` 和 limitations。
- Artifact/Image 只保存引用、媒体类型、大小、哈希和访问策略；大块二进制不进入 EventStore 或模型上下文。
- 压缩不得删除 HITL 决策、动作事实、未解决风险及 ToolCall/ToolResult 配对。

## 7. 权威事件流与三类投影

```text
业务模块 / Harness / Pipeline
          ↓
   EventPublisher（Schema 校验、ID/时间注入）
          ↓
   EventStore 条件追加 / ReplayBuffer（本地事实与短期流缓存）
          ↓
   EventDispatcher（订阅者隔离）
      ├── PublicSseProjector：过滤 internal/audit，生成用户安全事件
      ├── AuditProjector：保存结构化审计、修复链和决策记录
      ├── LangSmithProjector：映射 trace/span、usage、延迟、重试
      └── V1CompatibilityProjector：为旧消费者生成 V1 事件
```

durable 事件进入 EventStore，transient Delta 进入有界 ReplayBuffer 并在 Message 快照中收敛。投影器必须是确定性、可重放、可单测的纯转换或幂等消费者。投影状态带最后消费 `sequence`；durable 事实重启后从 EventStore 补放，transient Delta 超出窗口后用 Message 快照恢复。LangSmith 不可用时不影响 Run；失败记录本地并有界重试。

SSE 使用 `eventId` 作为 `id`，客户端通过 `Last-Event-ID` 请求补放。若请求早于 Delta 保留窗口，服务端返回最新完整 Message 快照和后续 durable 事件，而不是假装所有字符 Delta 仍可恢复。

## 8. 关键顺序

### 8.1 正常模型回复

```text
STEP_STARTED
→ REASONING_STARTED
→ MODEL_CALL_STARTED
→ MESSAGE_STARTED
→ CONTENT_BLOCK_STARTED
→ CONTENT_BLOCK_DELTA × N
→ CONTENT_BLOCK_COMPLETED
→ MESSAGE_COMPLETED
→ MODEL_CALL_COMPLETED
→ STEP_COMPLETED
```

供应商 usage 只有流结束后可得时，`MODEL_CALL_COMPLETED` 可晚于 `MESSAGE_COMPLETED`，但二者通过 `attemptId` 关联。

### 8.2 工具调用

```text
TOOL_CALL_ADMISSION_UPDATED × N
→ [TOOL_CALL_REPAIR_* / MODEL_RETRY_SCHEDULED]
→ TOOL_CALL_CREATED
→ RISK_EVALUATED
→ TOOL_STARTED
→ TOOL_OUTPUT_DELTA × N
→ TOOL_RESULT | TOOL_FAILED | TOOL_CANCELLED
```

### 8.3 确认暂停与恢复

```text
RISK_EVALUATED
→ CONFIRMATION_REQUESTED
→ RUN_PAUSED
→ 当前 AsyncGenerator 正常结束

用户决定写入：CONFIRMATION_RESOLVED | CONFIRMATION_EXPIRED
→ 获取新执行租约
→ 新 AsyncGenerator / 新 streamId
→ RUN_RESUMED
→ 从 Checkpoint 的未完成步骤继续
```

### 8.4 Subagent

```text
TOOL_CALL_CREATED(metrics_subagent)
→ TOOL_STARTED
→ SUBAGENT_STARTED(childRunId)
→ 子 Run 的模型/工具/证据事件
→ SUBAGENT_COMPLETED | SUBAGENT_FAILED
→ TOOL_RESULT
```

## 9. V1 兼容和迁移

- 保留现有 `AgentEvent`、`AgentEventType`、`AgentMessage` 和 `MessageBlock` 导出，明确标注 V1。
- 新增带 V2 后缀或新命名空间的契约，不能原地把 `schemaVersion: 1` 改为 2。
- 提供 V1/V2 读取联合及明确的 type guard。
- V1 事件读取后可迁移为 V2 最小事实；无法推导的字段使用迁移生成值并标注 `migrationSource`，不得伪造原始关联。
- V2 到 V1 投影只覆盖旧消费者理解的语义：例如 text delta、工具开始/结果、确认请求、外部执行、压缩、Run 生命周期。
- 新代码禁止直接构造 V1 事件；只调用 V2 EventPublisher。
- 持久化迁移必须可重复执行，并用旧 fixture 验证无损读取。

## 10. 不采用的 Newton 行为

- 不公开上报完整 system prompt。
- 不用 `REPORT_USER_MESSAGE`/`REPORT_ASSISTANT_MESSAGE` 复制 Message 事实。
- 不把应用日志包装为 Agent 领域事件；日志走日志基础设施。
- 当前没有充值业务，不引入 `CREDIT_RECHARGE_*`；额度统一为预算事件。
- 不公开未完成的工具参数 Delta。
- 不把图片或二进制逐块写入公共 EventStore；优先 Artifact 引用。
- 不保存或展示模型原始思维链。
- 不以事件数量作为完整性指标，以事件是否有生产者、Schema、持久化、投影和测试为准。

## 11. 模块边界

- `contracts/`：V1/V2 类型、PayloadMap、MessageBlock、JSON Schema/type guard；不依赖实现。
- `event/`：Publisher、Dispatcher、Projector 接口和顺序规则。
- `storage/`：EventStore、MessageStore 抽象。
- `infrastructure/`：SQLite Store、SSE、LangSmith、审计实现。
- `agent/`：只在权威状态迁移点发布生命周期/阶段事件。
- `model/`：模型调用包装器发布调用和 usage 事件。
- `tool/`：Admission 与 Pipeline 发布工具、修复、重试、结果事件。
- `application/`：Run 启动、确认、恢复、取消等命令边界。
- `bootstrap/`：组装所有实现，不使用全局 EventBus 单例。

## 12. 一期实施与验收门槛

一期完成不以“联合类型中存在事件名”为标准。每个适用事件必须具备类型、payload Schema、真实产生位置、持久化策略、投影、脱敏和测试。

至少验证：

1. PayloadMap 编译期类型安全和运行时 Schema 拒绝非法 payload。
2. 同一 Run 的 sequence 严格递增，重复 eventId 幂等。
3. 并发工具事件允许交错，但每个 toolCallId 内部顺序合法。
4. 模型/工具重试 attemptId 变化，逻辑 toolCallId 和 correctionChainId 保持正确。
5. Pause 后旧生成器结束；Resume 使用新 streamId 且 runId/replyId 不变。
6. SSE 重连从 Last-Event-ID 补放，超出 Delta 窗口时返回完整消息快照。
7. Public 投影不泄露 raw_tool_call、系统提示词、密钥、内部地址和原始思维链。
8. LangSmith 故障不使 Run 失败，恢复后可幂等补报。
9. V1 fixture 可读取，V2 可稳定投影成旧事件。
10. ToolCall/ToolResult、Evidence 引用、确认和动作记录在压缩、回放后仍完整。
11. Subagent 父子 Run、MCP 失败、数据源熔断和降级事件关联正确。
12. `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。

## 13. 当前实现状态

截至 2026-09-08，Event/Message V2 的协议、Schema、内存/SQLite 存储、ReplayBuffer、MessageAssembler、EventPublisher、V1/Public 初版投影和框架无关 SSE 回放服务已经开始落地。SSE 当前以 `SseFrame` 形式输出，由 HTTP 层负责写入具体响应；`Last-Event-ID` 通过 eventId 解析，transient Delta 超出窗口时用用户可见 Message 快照恢复。

一期仍未完成：Audit/LangSmith 投影、模型调用事件、工具四闸门/重试/熔断事件、HITL 暂停恢复事件、Subagent/MCP/上下文压缩/记忆生命周期、bootstrap 组装、V1 fixture 和端到端验收仍需继续实现。本文是目标设计与当前状态说明；具体完成度以 `docs/event-message-v2-acceptance-status.md` 的验证记录为准。
