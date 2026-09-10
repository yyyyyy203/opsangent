# Durable Run State & Evidence V1 设计

> 状态：2026-09-10 已由项目负责人确认，尚未实施。本文定义下一增量的持久化边界；完成代码和验收前，不得宣称 Agent 已具备磁盘级 Run 恢复或持久化 EvidenceStore。

## 1. 目标与范围

本增量为单机、单进程的个人开发验证提供完整的执行状态与证据持久化，使 Agent 在进程重启后能够继续 Run、回查原始证据，并且不会盲目重放已完成或结果不确定的工具动作。

一期使用一个 SQLite 文件和 WAL。模块仍通过小接口访问存储，未来可分别替换 PostgreSQL、对象存储或远程状态服务。共享一个 SQLite 文件是部署选择，不代表 Harness、Tool、Evidence 或 Event 模块直接依赖 `better-sqlite3`。

本增量包括：

- 持久化完整 `AgentContext`、待执行工具批次、批次内已完成结果和暂停状态。
- 持久化指标原始证据、结构化摘要、哈希及回查索引。
- 为 Checkpoint 写入增加乐观并发控制，防止恢复执行与 HITL 决策互相覆盖。
- 为所有工具调用持久化执行日志；查询工具按明确恢复策略处理，动作工具支持不确定状态。
- 将 Checkpoint、Evidence、Event/Message SQLite 实现通过 bootstrap 组装。
- 使用 Metrics Lab 验证 MCP、Evidence、Checkpoint 和进程重启闭环。

本增量不包括：Agent Web、Simulator Web、ELK/Trace 数据源、大型证据 BlobStore、自动清理策略、多 Worker 分布式租约以及真实写动作上线。真实动作仍维持现有 Dry Run 安全边界；本轮只用受控假工具验证动作恢复语义。

## 2. 当前实现事实

- `src/contracts/storage.ts` 中的 `CheckpointStore` 同时承担 Run 快照与动作幂等记录，接口没有存储 revision，也不能原子提交 ToolResult 与 Checkpoint。
- `InMemoryCheckpointStore` 和 `InMemoryEvidenceStore` 是当前默认实现，进程退出后数据丢失。
- `createAgentRuntime({ sqlitePath })` 当前只把 Event/Message 和投影状态放入 SQLite，Checkpoint 仍默认在内存中。
- `bindSettlementEvidenceTool` 会先保存 Evidence，再返回摘要与 `evidence_ref`；这个顺序正确，但 Evidence ID 与工具调用缺少稳定关联。
- Harness 会在暂停、每轮结束和 `finally` 保存 Checkpoint，但尚未在工具批次执行前保存完整批次计划，也没有在每个并行分支完成后保存批次进度。
- Event/Message V2 是审计和 UI 回放事实；它不包含重建完整 `AgentContext` 所需的全部私有状态，不能作为本轮执行恢复的唯一来源。

## 3. 方案比较与决策

### 方案 A：SQLite 快照、证据表和执行日志

AgentContext 使用版本化 JSON 快照；Evidence 和工具执行记录使用独立关系表。状态读取简单，现有 Harness 改造可控，适合单机第一版。

### 方案 B：完全 Event Sourcing

所有 AgentContext 都从 V2 Event 重建。审计模型统一，但当前事件没有完整预算、纠错账本、待执行批次和私有上下文，强行采用会扩大公共事件并提高恢复复杂度。

### 方案 C：Checkpoint、Evidence 分库或外部 BlobStore

隔离性和大对象能力更强，但需要处理多资源提交、生命周期和备份，超出个人开发验证范围。

采用方案 A。限定大小的指标原文先保存在 SQLite；EvidenceStore 接口不暴露存储形态，后续日志和 Trace 大对象可迁移到 BlobStore，而不改变 Tool 和 Harness。

## 4. 权威状态与一致性原则

三类状态各自只有一个权威来源：

- `VersionedCheckpointStore`：决定 Run 从哪个阶段、哪个工具批次继续执行。
- `EvidenceStore`：决定某个 `evidenceId` 是否真实、完整且可回查。
- Event/Message V2 Store：保存审计事实、公共 SSE 回放和消息投影，不驱动工具重放。

恢复优先级为：安全执行状态高于 UI 事件完整性。`RUN_PAUSED` 发出前必须先保存可恢复 Checkpoint；若 Checkpoint 成功而事件发布失败，启动恢复器依据持久状态补发带恢复原因的生命周期事件，不得丢弃 Checkpoint 或自行继续执行。

## 5. 契约设计

### 5.1 Checkpoint 快照

`AgentContext.contextVersion` 保留为上下文语义版本。存储并发版本使用独立的 `revision`，二者不得混用。

```ts
export interface StoredRunCheckpoint {
  context: AgentContext;
  revision: number;
  savedAt: string;
  checksum: string;
}

export interface VersionedCheckpointStore {
  load(runId: string): Promise<StoredRunCheckpoint | null>;
  save(
    context: AgentContext,
    expectedRevision: number | null,
  ): Promise<StoredRunCheckpoint>;
}
```

`save` 使用 compare-and-set：

- 新 Run 只能以 `expectedRevision = null` 创建。
- 已有 Run 只能用最近一次读取到的 revision 更新。
- 完全相同的重复保存是幂等操作，返回原 revision。
- revision 过期或相同 revision 对应不同内容时抛出内部 `CheckpointConflictError`，不得自动覆盖或合并。进入 Agent/Event 边界时映射为现有 `STORAGE_ERROR`，并以安全的 `details.category = 'checkpoint_conflict'` 保留细分类，避免扩展已发布错误码枚举。

现有 `CheckpointStore` 字段和方法不删除。新增接口采用独立名称，并提供兼容适配器；生产 SQLite 组装必须使用版本化接口，不能退回无并发保护的 legacy 实现。

### 5.2 待执行批次

向 `AgentContext` 添加可选的版本化批次状态，避免破坏旧 Checkpoint：

```ts
export interface PendingToolBatch {
  batchId: string;
  stepId: string;
  calls: ToolCall[];
  completedResults: ToolExecutionResult[];
  state: 'admitted' | 'executing' | 'awaiting_confirmation' | 'awaiting_external';
  createdAt: string;
}

export interface AgentContext {
  pendingToolBatch?: PendingToolBatch;
}
```

Harness 在执行批次前保存 `admitted` 状态。每个并行分支产生最终 ToolResult 后，先将结果写入执行日志并更新 `completedResults`，再继续收敛其他分支。重启时只处理尚未完成的调用；完成整批并写入消息后才清除 `pendingToolBatch`。

原有 `pendingToolCalls` 和 `pendingInterrupt` 在兼容期保留。读取旧 Checkpoint 时，由 Codec 将其映射为批次状态；写入新 Checkpoint 时同时维持旧字段，直到单独的 Schema 迁移决策允许删除。

### 5.3 工具恢复策略与执行日志

`isConcurrencySafe` 只表示同批并发安全，不能代表崩溃后可重放。Tool 增加可选恢复声明：

```ts
export interface Tool {
  readonly recoveryPolicy?: 'replay_safe' | 'verify_before_retry' | 'never_replay';
}

export interface ToolCallOptions {
  readonly toolCallId?: string;
}
```

内部 Pipeline 必须始终传入 `toolCallId`；字段保持可选是为了兼容已有外部 Tool 实现。默认策略为：`evidence` 工具 `verify_before_retry`，`action` 工具 `never_replay`，`utility` 工具 `verify_before_retry`。只有工具注册表明确声明 `replay_safe` 时，恢复器才可自动重新执行。

```ts
export interface ToolExecutionRecord {
  toolCallId: string;
  runId: string;
  stepId: string;
  toolName: string;
  toolKind: ToolKind;
  inputDigest: string;
  state: 'prepared' | 'succeeded' | 'failed' | 'uncertain';
  result?: ToolExecutionResult;
  preparedAt: string;
  finishedAt?: string;
}

export interface ToolExecutionJournal {
  prepare(record: ToolExecutionRecord): Promise<ToolExecutionRecord>;
  get(toolCallId: string): Promise<ToolExecutionRecord | null>;
}
```

同一个 `toolCallId`、工具名和输入摘要的重复 `prepare` 返回原记录；同 ID 但身份或输入不同必须报冲突。

### 5.4 原子状态提交

SQLite 实现提供窄用途事务端口，使 ToolResult、执行日志终态和更新后的 Checkpoint 在一个数据库事务中提交：

```ts
export interface AgentStateUnitOfWork {
  commitToolResult(input: {
    expectedRevision: number;
    context: AgentContext;
    execution: ToolExecutionRecord;
    result: ToolExecutionResult;
  }): Promise<StoredRunCheckpoint>;
  markToolUncertain(input: {
    expectedRevision: number;
    context: AgentContext;
    execution: ToolExecutionRecord;
    reasonCode: string;
  }): Promise<StoredRunCheckpoint>;
}
```

该接口只表达一个跨表一致性用例，不承担 Evidence、Event、Memory 或查询职责。内存和 SQLite 都必须实现相同语义。

对于真实外部动作，执行顺序固定为：

```text
prepared 持久化
→ 调用外部动作
→ succeeded + Checkpoint 原子提交
```

若进程在外部动作返回后、原子提交前退出，执行记录仍为 `prepared`。恢复时动作进入 `uncertain`，发布已有 `EXTERNAL_EXECUTION_UNCERTAIN`，要求状态查询或人工核验；禁止无条件重放。

### 5.5 Evidence 接口

保留现有 `EvidenceStore.save/get`。为运行历史查询新增独立接口，不把分页职责塞回核心写接口：

```ts
export interface EvidencePage {
  items: EvidenceRecord[];
  nextCursor?: string;
}

export interface EvidenceQueryStore {
  listByRun(runId: string, options?: {
    cursor?: string;
    limit?: number;
  }): Promise<EvidencePage>;
}
```

`EvidenceRecord` 只增加可选兼容字段：`toolCallId`、`captureKey`、`schemaVersion` 和 `rawSha256`。内部 Pipeline 把 `toolCallId` 传给 Evidence Tool；`captureKey` 对同一 Run、ToolCall、来源和记录序号稳定，用于崩溃恢复去重。

保存规则：

- 先验证 JSON 可序列化、大小上限、时间格式和来源枚举。
- 计算原始内容 SHA-256，再开启 SQLite 事务。
- 相同 evidenceId/captureKey 且哈希相同视为幂等成功。
- 相同 ID 或 captureKey 但哈希不同视为冲突。
- 事务提交成功后才能返回 `evidence_ref`。
- 原始内容不得进入 Agent Message、公共 Event、SSE 或 LangSmith。

Metrics V1 默认单条原始证据上限为 1 MiB，可从 bootstrap 注入更小值。未来日志和 Trace 超过阈值时由 BlobStore 实现接管，本轮不把大对象切片逻辑放进 SQLite Adapter。

### 5.6 Evidence 记录服务

Evidence Tool 不直接依赖 EventPublisher，也不自行拼装 `EVIDENCE_COLLECTED`。应用层提供唯一记录端口：

```ts
export interface EvidenceCaptureRequest {
  record: EvidenceRecord;
  stepId: string;
  toolCallId: string;
  coverage: number;
  publicSummary: string;
}

export interface EvidenceRecorder {
  capture(request: EvidenceCaptureRequest): Promise<EvidenceRecord>;
}
```

`DefaultEvidenceRecorder` 依次验证请求、调用 EvidenceStore、回读并校验已提交记录，然后发布 `EVIDENCE_COLLECTED`。只有事件发布完成后才向 Tool 返回记录；eventId 由 evidenceId 通过注入的稳定 ID 映射器生成，重复 capture 复用相同 evidenceId 和 eventId，依靠 Store 与 EventStore 的幂等语义安全重试。工具只接收 `EvidenceRecorder`，因此替换 SQLite、BlobStore 或事件实现不需要修改数据源 Tool。

## 6. SQLite Schema

在现有 `user_version = 1` 后追加迁移 v2，不修改历史迁移：

```sql
CREATE TABLE agent_checkpoints (
  run_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  context_version INTEGER NOT NULL CHECK (context_version > 0),
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  checkpoint_schema_version INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX agent_checkpoints_status_updated
  ON agent_checkpoints(status, updated_at);

CREATE TABLE evidence_records (
  evidence_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_call_id TEXT,
  capture_key TEXT,
  source TEXT NOT NULL CHECK (source IN ('metric', 'log', 'trace', 'change')),
  captured_at TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  UNIQUE (capture_key)
);

CREATE INDEX evidence_records_run_captured
  ON evidence_records(run_id, captured_at, evidence_id);
CREATE INDEX evidence_records_source_captured
  ON evidence_records(source, captured_at, evidence_id);

CREATE TABLE tool_executions (
  tool_call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_kind TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'succeeded', 'failed', 'uncertain')),
  result_json TEXT,
  reason_code TEXT,
  prepared_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX tool_executions_run_state
  ON tool_executions(run_id, state, tool_call_id);
```

SQLite 继续启用 WAL、foreign keys 和 5 秒 busy timeout。所有多表状态变更使用 `better-sqlite3` immediate transaction。数据库 `user_version` 与 Checkpoint JSON 的 `checkpoint_schema_version` 是两个独立版本。

## 7. Codec 与安全边界

新增纯函数 Codec，对写入前和读取后的完整 Checkpoint、Evidence 与 ToolExecutionRecord 做 Zod 校验。解析失败统一抛 `StoredDataCorruptionError`，错误仅包含记录类型和 ID，不包含 JSON 正文。

Checkpoint checksum 基于规范化 JSON 计算。它用于发现磁盘损坏或非预期写入，不作为加密或防篡改机制。第一阶段不把密钥、Cookie、Authorization、客户数据和内部地址写入这些表；Evidence Tool 在入库前仍执行来源白名单与脱敏策略。

所有时间、ID、哈希器和大小限制均由构造器注入或通过纯函数提供，测试不得依赖真实等待和随机 ID。

## 8. Runtime 组装与资源所有权

新增 bootstrap 级组合对象：

```ts
export interface SqlitePersistenceBundle {
  checkpoints: VersionedCheckpointStore;
  executions: ToolExecutionJournal;
  stateUnitOfWork: AgentStateUnitOfWork;
  evidence: EvidenceStore & EvidenceQueryStore;
  eventMessages: EventStore & MessageStore;
  projectionCheckpoints: ProjectionCheckpointStoreV2;
  projectionFailures: ProjectionFailureSinkV2;
  close(): void;
}
```

`createSqlitePersistence({ path })` 是唯一打开数据库并实例化具体 Store 的位置。外层 bootstrap 先创建 bundle，再用 Evidence Store 与 V2 Publisher 组装 `DefaultEvidenceRecorder` 并注入数据源 Tool，把 Checkpoint/执行事务和 Event Store 注入 Runtime。Harness、Tool、Hook、HITL 和 API 不导入 SQLite 类。

保留 `createAgentRuntime({ sqlitePath })` 作为兼容入口，但它必须改为创建完整 bundle，而不是只持久化 Event/Message。调用方显式传入 bundle 时由调用方关闭；Runtime 自己创建时由 `runtime.close()` 关闭，禁止双重 close。

## 9. 恢复状态机

启动或显式 `resumeStream(runId)` 时按以下确定性顺序执行：

1. 读取并校验 Checkpoint 和存储 revision。
2. 若 Run 已 completed/failed/cancelled，返回终态，不再次调用模型或工具。
3. 若存在 pending interrupt，保持 awaiting_confirmation/awaiting_external，等待外部输入。
4. 若存在 pending batch，查询每个 ToolCall 的执行日志。
5. `succeeded/failed` 使用已保存结果补全批次，不重复调用。
6. `prepared + replay_safe` 可以重新执行；`prepared + verify_before_retry` 转入验证；`prepared + never_replay` 标记 uncertain。
7. 全批结果齐全后写入 ToolCall/ToolResult 消息、清除 pending batch，并进入下一轮 Reasoning。
8. 每次保存使用加载时取得的 revision；冲突时停止本次恢复，对外返回 `STORAGE_ERROR/category=checkpoint_conflict`。

HITL 决策同样必须使用 revision。确认只对 Checkpoint 中列出的具体 toolCallId 生效；过期、重复或并发决策不得覆盖先到达的有效结果。

## 10. 事件与可观测性

本增量不新增 EventType。复用已有事件：

- Evidence 成功提交后产生 `EVIDENCE_COLLECTED`。
- 恢复成功产生 `RUN_RESUMED`，其中 checkpointVersion 使用持久化 revision 的字符串形式。
- 待确认或待外部执行保持 `RUN_PAUSED`。
- 动作状态不确定产生 `EXTERNAL_EXECUTION_UNCERTAIN`。
- 存储损坏、冲突或不可用通过已有结构化错误和 `RUN_FAILED`/`STEP_FAILED` 表达。

事件 payload 只包含安全摘要、ID、revision 和错误码。Checkpoint JSON、原始 Evidence、完整 Tool 输入以及数据库路径不得进入 Public SSE 或 LangSmith。

## 11. 错误与降级

- Evidence 保存失败：Tool 返回 `STORAGE_ERROR`，不返回 evidenceId。
- Checkpoint 保存失败：Run 不能继续下一次模型调用或执行新工具。
- Checkpoint revision 冲突：停止当前写入方，不自动 last-write-wins；内部异常在公共边界映射为 `STORAGE_ERROR/category=checkpoint_conflict`。
- Evidence 记录损坏：该引用不可用于诊断结论，并记录缺失证据。
- SQLite busy：仅在 Store 边界进行短暂有界重试；不得在 Harness、Tool 与 Store 三层重复重试。
- SQLite 不可用：本轮不自动降级到内存，因为无提示降级会制造“看似可恢复”的假象。只有显式测试配置可以选择内存实现。
- 动作结果不确定：禁止自动重放，必须进入验证或人工处理。

## 12. 验收标准

### Store 合同测试

- 内存与 SQLite 实现通过相同的 Checkpoint、Evidence、执行日志合同测试。
- 数据库迁移可重复执行，关闭重开后数据和 WAL 状态正确。
- Checkpoint create/update/幂等重复/stale revision/损坏 JSON 均有确定性断言。
- Evidence save/get/list/pagination/精确重复/冲突/超限/损坏记录均有确定性断言。
- Tool execution prepare/结果提交/冲突/uncertain 均有确定性断言。

### Harness 恢复测试

- 正常完成、模型失败、消费者提前关闭和迭代结束后的 Checkpoint 可重开读取。
- HITL 暂停后关闭 Runtime，重开、确认并恢复，工具只执行一次。
- 并行批次完成一个分支后模拟进程退出，恢复时复用完成结果，只执行未完成的 replay-safe 分支。
- 已完成动作重启后不重复执行。
- `prepared` 动作重启后进入 uncertain，并产生 `EXTERNAL_EXECUTION_UNCERTAIN`。
- 两个基于同一 revision 的并发写入只有一个成功。

### Metrics Lab 端到端测试

- normal、failure-spike、low-sample 三种场景经过真实 Prometheus、MCP HTTP、Tool、EvidenceStore 和 Harness。
- 每个 Run 关闭并重开 SQLite 后，Checkpoint、ToolResult 与原始 Evidence 仍可通过 ID 回查。
- Agent Message、公共 Event/SSE 和 LangSmith 投影中不存在原始指标响应标记。
- 默认测试继续显式跳过需要 Docker 的真实 Prometheus 用例；启用 `AGENTOPS_REAL_PROMETHEUS=1` 时执行完整持久化验收。

最终必须重新运行：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 13. 后续顺序

本增量验收后，下一顺序为：Metrics Subagent Tool 化并使用真实模型完成模拟诊断闭环；提供 Run/Evidence 只读查询 API；实现 Agent Web；最后接入真实业务 Prometheus。ELK、Trace、大对象 BlobStore、Memory 持久化和真实保护动作分别立项，不能混入本增量。
