# Agent Runtime Governance 与上下文压缩设计

> 状态：总体技术路线已确认；增量 1、2、3、4 已完成实现与验收，增量 5、6 待后续独立计划实施。本文定义 Guard、Hooks、Loop Detection 与 Context Compression 的共同架构边界；除下方实施状态明确列出的内容外，代码和验收完成前，不得宣称这些能力已经达到生产可用。

## 1. 决策与范围

本增量采用“演进现有 V2 架构”的方案：保留当前 Agent Harness、AsyncGenerator、Event/Message V2、耐久 Checkpoint、执行日志和 EvidenceStore，在这些稳定基础上增加可插拔的运行治理能力，不建立第二套 Agent 循环、确认状态机或持久化通道。

本设计吸收并修订以下四份输入设计：

- `guard-system-design.md`
- `hooks-system-design.md`
- `loop-detection-design.md`
- `context-compressor-design.md`

修订重点是：白名单不能绕过 HITL；Checkpoint 不能由 Hook 独立写入；审计和记忆信号不能依赖会被短路的普通 Hook；循环状态必须可恢复；大证据必须复用 BlobStore 设计；所有耐久事件只能在对应状态提交后对外可见。

本增量包括：

- 版本化 Profile 快照与动态影响面快照。
- 多 Guardian、确定性风险合并及 allow/confirm/deny 策略。
- 控制型 Hook 与观察型 Hook 的职责拆分。
- 可跨重启恢复的三级循环检测。
- L0/L1/L2 上下文治理、完整性校验和失败回滚。
- 与 Checkpoint、ToolExecutionJournal、Event V2 和 V1 兼容通道的一致性集成。
- 为耐久治理事实增加事务 Outbox，收敛“状态已提交但事件尚未发布”的崩溃窗口。

本增量不包括：

- 新建前端页面。
- 自动执行真实写动作；现阶段真实动作继续维持 HITL，默认运行模式继续为 Dry Run。
- 多 Worker 分布式租约或跨数据库分布式事务。
- 引入独立策略服务、规则 DSL 或通用工作流引擎。
- 在本文中重新设计 ELK SDK、MCP 分页或 Blob 生命周期。本文只定义 L0 与大证据数据面的集成契约；这些能力的内部实现、验收和独立实施计划继续以已确认的 [ELK 大体量证据流式摄取与 BlobStore 设计](./2026-09-10-elk-large-evidence-blob-storage-design.md) 为准。

## 2. 当前实现基线

本文以 `codex/event-message-v2` 分支提交 `7f50421` 为增量 1 验收基线。当前事实如下：

- 兼容路径仍保留 `GuardEngine` 和 `BashGuardian`；治理路径新增带 Profile/Impact 上下文的 `GuardianCoordinator`、四类 Guardian 和纯 `RiskPolicy`。
- `GuardInput` 的新增字段保持可选以兼容旧调用；治理执行使用字段完整的 `GovernanceGuardInput`，Guardian 结果按注册顺序收敛。
- Tool Admission 已在 Guard 前完成工具存在性、JSON、Schema 和语义校验。
- 治理运行时按配置注入 `ProfileResolver`、`ImpactSurfaceProvider` 和 `GovernanceEvaluator`；默认未启用时不改变旧 GuardEngine 行为。
- 默认控制通道按 `EvidenceBudgetHook -> PolicyDenyHook -> RiskActionHook` 固定顺序短路；兼容扩展仍由 `HookExecutor` 执行，生命周期观察者通过独立执行器隔离调用。
- HITL 和外部执行恢复由 `pendingToolBatch`、Checkpoint revision、执行日志和应用服务共同处理。
- ToolResult、Checkpoint、执行日志和耐久 Outbox 已通过窄用途 transition UoW 保证原子提交；V2 状态耦合事实在提交后由有界 Dispatcher 发布。
- 增量 1 的验收基线只检测重复 toolCallId 和模型纠错预算耗尽；增量 4 已补齐按工具、参数和脱敏终态结果签名的循环检测。
- `RuleBasedContextCompressor` 已提供确定性 L1 候选、异步完整性校验和可选 compact model 的 L2 摘要；未配置 `compactModel` 时默认只执行 L1。
- `pruneToolResult()` 已存在但没有接入生产工具执行路径。
- Event V2 已有 `LOOP_DETECTED` 事实契约，并由增量 4 接入运行时生产路径和公共安全投影。
- SQLite EvidenceStore 只适合有界内联证据；几十 MiB 日志必须进入 Manifest + BlobStore 数据面。

本文不得被解释为这些缺失能力已经实现。

### 2.1 增量 1 实施状态

增量 1 已交付以下内容，并由合同测试、恢复测试、V1 兼容测试和全量质量门禁验证：

- 治理状态、兼容 Codec 迁移、`LOOP_DETECTED` V2 事件契约，以及 durable transition / Outbox 公共端口。
- 内存与 SQLite 的原子 Checkpoint、执行日志和 Outbox 提交；Outbox 使用稳定 `eventId`、CAS revision 和有界查询。
- Durable Outbox Dispatcher、普通事件 Outboxed wrapper、启动 drain 和公共导出；并发 drain 与发布成功但标记失败的即时重试不会在进程内重复投影。
- Harness 的生命周期/终态/工具结果/不确定执行事实，以及 HITL 确认和外部结果的状态耦合提交；提交成功后才发布 V2，具备 V1 映射的事件再向 V1 Generator 推送兼容事件。
- 仍保留 AsyncGenerator V1 事件和 EventBus 兼容通道；V1 启动恢复不使用无持久游标的重复 replay。

### 2.2 增量 2 实施状态

增量 2 已交付以下内容：

- `ProfileResolver` 与版本化、深冻结、带算法版本前缀的 Profile 快照；新 Run 在第一次模型调用前解析，恢复 Run 复用 Checkpoint 快照。
- `ImpactSurfaceProvider` 与明确的 available/unavailable/stale 结果；一个可执行 Tool 批次只采集一次影响面，并把快照绑定到 `toolCallId + inputDigest`。
- `GuardianCoordinator` 使用有界并行、注册顺序收敛 Finding，并将 Guardian 异常/超时转换为不泄漏异常文本的 `guard.unavailable` Finding。
- Bash、MCP、Profile、ImpactSurface 四类确定性 Guardian，以及 `deny > confirm > allow` 的纯 `RiskPolicy`。
- 治理快照在 ToolRunner 前强制执行；deny 生成稳定 `POLICY_DENIED` ToolResult，confirm 继续复用现有 HITL，旧 GuardEngine 路径保持兼容。
- Tool source 元数据和公共 `RUN_STARTED.versionSnapshot` 白名单投影；V1 事件契约和 AsyncGenerator 行为不变。

本增量的验证结果：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `git diff --check` 均通过；全量测试为 348 passed、1 skipped，跳过项为未配置真实 Prometheus 端点的环境测试。审查发现的风险策略例外、输入摘要一致性、Profile 运行时校验、影响面超时取消、Finding 深拷贝、Guardian 子信号取消、父级 Abort 传播和过期 deadline 早退问题均已修复并补充回归测试。

以下能力仍明确属于后续增量，当前尚未实现其行为：

- 增量 5：L0 大证据边界、Manifest/BlobStore 数据面和 ToolResult 流式外置接入，已在前序实现中完成并由本地/注入式验收覆盖。
- 增量 6：L1/L2 结构裁剪、compact summarizer、Validator、回滚、生命周期事件和重启恢复链路，已在 2026-09-14 完成首版实现与聚焦验收；真实在线 compact model、生产 ELK/对象存储和分布式租约仍不属于本 Spec 的已验证范围。

### 2.5 增量 5/6 上下文压缩实施状态

已交付：

- L1 纯函数候选构造：保留最近消息、保护 pending/interrupt/未配对调用、按 ToolCall/ToolResult 成组裁剪，并把历史替换为确定性 `context_summary`。
- L2 独立 `HistorySummarizer`：工具列表固定为空，历史使用不可信数据边界，严格 Zod JSON、来源/ToolCall/evidence/确认/Risk ID 白名单、一次重试、Abort/deadline 传播。
- `DefaultCompressionValidator`：检查可见配对、历史摘要覆盖、证据 Manifest/Record 可见性和 Run 归属、durable state 不变、大小上限；只允许恢复压缩前精确 ToolResult，不生成伪造成功结果。
- `RuleBasedContextCompressor`：L1 先行，字节阈值且存在 compact model 时再尝试 L2；L2 失败降级到已验证 L1，L1 失败返回原 Context。
- Harness 通过现有 CAS/Outbox transition 提交压缩事实；V2 新事件不扩张 V1 EventType；Checkpoint Codec 接受新增 ContextSummary 字段。
- SQLite 重启测试验证 CompressionState、summary version、来源消息范围和压缩事件不重复；公共投影、审计和 LangSmith 测试验证压缩事件不带原始历史或完整 ToolResult。

已知边界：默认阈值使用 40 条消息与 256 KiB 序列化字节回退；未接入 tokenizer 感知的 70% 窗口计算。compact model 的在线供应商可用性、真实 ELK/对象存储、跨 Worker 租约和 64 MiB 生产压测需在各自数据源/部署计划中继续验收。

### 2.3 增量 3 实施状态

增量 3 已交付以下内容：

- 控制型 Hook 与观察型生命周期 Observer 分离；控制通道固定按 `EvidenceBudgetHook -> PolicyDenyHook -> RiskActionHook` 顺序执行，并在首个 interrupt/abort 后短路。
- `PolicyDenyHook` 将确定性 deny 转换为稳定 `POLICY_DENIED` ToolResult；控制 Hook 或兼容 Hook 返回 modifiedInput 后，Pipeline 重新执行 Schema/语义校验并校验 inputDigest，变更后 fail-closed。
- Pipeline 为未知工具、输入校验失败、控制中断、外部执行等待、成功、失败、abort、timeout 和跳过构造不含原始输入/响应正文的生命周期事实。
- `AuditHook`、`CheckpointHook`、`DiagnosisMemoryHook` 只生成脱敏 `GovernanceEffect`；Observer 以隔离方式执行，单个失败不改变真实 ToolResult，effects 在 Harness 的 DurableTransition UoW 边界内传递。
- `HookRegistry` 只保留静态 Hook ID 和 interrupt 类型/有效期校验；确认、外部执行和恢复在未知 Hook、ToolCall 不一致、输入摘要不一致或过期时 fail-closed，不重放外部动作。
- 保留旧 `ToolHook`/`HookExecutor` 构造兼容和既有 V1/V2 事件契约；未引入新的公共 EventType、Loop Detection、Context Compression 或真实写动作。

增量 3 的验证覆盖控制短路、输入变更拒绝、Observer 必达/失败隔离、Durable effects 传递、恢复 fail-closed、确认过期和外部执行恢复；该增量验收时门禁结果为 66 个测试文件通过、1 个环境测试跳过，357 passed、1 skipped，且 `pnpm lint`、`pnpm typecheck`、`pnpm build` 和 `git diff --check` 均通过。

### 2.4 增量 4 实施状态

增量 4 已交付以下内容：

- `src/agent/loop-detection/` 提供确定性调用/结果签名、终态计数、非连续重置、可界定历史和不可变 LoopState 转换；时间戳、随机 ID、游标、原始日志和正文不会进入签名。
- 只统计 `success`、`failed`、`timeout` 和 `already_executed` 跳过结果；Admission 拒绝、中断、外部等待、Abort 和重新规划跳过均不计数。
- 连续 3/5/7 次分别产生 WARN/HARD/FORCE_BREAK；HARD 将规范化调用签名加入 `blockedSignatures`，Admission 在 ToolRunner 前确定性拒绝；FORCE_BREAK 保留部分上下文和 `missingEvidence`，以不可重试 `LOOP_DETECTED` 失败结束 Run。
- WARN 只向下一次模型调用追加动态尾部提示，不写入稳定消息；HARD 在模型契约支持时透传 `toolChoice: 'none'`，本地 Admission 阻断仍是安全边界。
- 并行工具可继续并发执行，但 LoopState、ToolResult、生命周期 effects 和 `LOOP_DETECTED` 事件按原始 ToolCall 顺序处理；混合查询/动作批次只对实际执行的查询调用建立顺序栅栏，避免等待被重新规划的动作。
- Durable 模式把 LoopState、ToolResult、执行日志、治理 effects 和循环事件放入同一 transition/outbox；恢复时只对执行日志中尚未写入当前 pending batch 的终态结果继续计数，避免重复计数。
- `LOOP_DETECTED` 的公共投影只暴露等级、次数、工具名、动作和阶段，不暴露内部签名摘要；V1 兼容事件契约和 AsyncGenerator 顺序保持不变。

增量 4 的验证结果：定向循环/模型/投影测试 37 passed；全量测试为 67 个测试文件通过、1 个真实 Prometheus 环境测试跳过，370 passed、1 skipped；`pnpm lint`、`pnpm typecheck`、`pnpm build` 和 `git diff --check` 均通过。覆盖签名稳定性、状态过滤、3/5/7 阈值、Admission 阻断、模型提示透传、公共投影、并行顺序、混合批次、Durable 同事务和跨 Checkpoint 恢复计数。

## 3. 不可破坏的架构约束

1. Agent Harness 是唯一权威主循环。
2. V2 Event 是唯一权威事件事实；V1 只做兼容投影和 AsyncGenerator 兼容输出。
3. Guard 只产生确定性 Finding；是否允许、确认或拒绝由风险策略和控制型 Hook 决定。
4. Hook 不直接调用 Tool、不恢复 Run，也不自行修改持久化版本。
5. Checkpoint、执行日志、循环状态和待确认状态以 CAS/UoW 提交。
6. durable 事件必须在对应状态提交后发布；崩溃恢复时可由 Outbox 补发。
7. 原始日志、完整 Tool 输入、凭证和内部地址不进入 Message、公共 Event、SSE 或 LangSmith。
8. 数值阈值、风险等级、循环计数、覆盖率和完整性校验均由确定性代码完成。
9. 所有新增实现通过构造器注入；Harness 不依赖 Prometheus、ELK、SQLite、文件系统或模型 SDK。
10. 旧 Checkpoint、第三方 Guardian、第三方 Tool 和 V1 消费者保持兼容。

## 4. 总体数据流

```text
模型输出
  -> Tool Admission 四道闸门
  -> ProfileSnapshot + ImpactSurfaceAssessment
  -> GuardianCoordinator -> Finding[]
  -> RiskPolicy -> RiskDecision
  -> ControlHookExecutor
  -> HITL / Execution Journal
  -> ToolRunner
  -> EvidenceIngestor / L0
  -> LifecycleObservers
  -> DurableTransitionUnitOfWork
       - AgentContext / PendingToolBatch
       - ToolExecution
       - LoopState / CompressionState
       - Durable Event Outbox
  -> EventPublisherV2
       - Public SSE
       - Audit Projection
       - LangSmith Projection
       - V1 EventBus Projection
  -> AsyncGenerator V1 兼容 yield
```

风险评估发生在 ToolRunner 前；循环更新发生在终态结果形成后；任何对外宣称完成的事件都发生在耐久提交后。

## 5. 共享契约

### 5.1 运行治理状态

向 `AgentContext` 增加一个可选聚合字段，避免继续平铺可变状态：

```ts
export interface RunGovernanceState {
  schemaVersion: 1;
  profile: ResolvedProfileSnapshot;
  loop: LoopState;
  compression: CompressionState;
}

export interface AgentContext {
  governance?: RunGovernanceState;
}
```

新 Run 必须初始化该字段。旧 Checkpoint 缺失时由 Codec 使用安全默认值迁移；不能在业务代码中到处使用不一致的临时默认值。

### 5.2 Profile 快照

```ts
export interface ResolvedProfileSnapshot {
  profileId: string;
  revision: string;
  digest: string;
  serviceName: string;
  serviceLevel: 'S0' | 'S1' | 'S2' | 'S3';
  timezone: string;
  allowedActions: string[];
  forbiddenActions: string[];
  changeFreezePeriods: ChangeFreezePeriod[];
  impactPolicy: ImpactPolicy;
  policyVersion: string;
  capturedAt: string;
}
```

ProfileResolver 在 Run 创建时解析一次并产生不可变快照。快照不含 Token、内部连接地址或 SDK 对象。暂停恢复继续使用 Checkpoint 中的快照，不能因在线 Profile 更新而改变同一 ToolCall 的授权条件。

`allowedActions` 仅表示“允许 Agent 提出该动作”，不表示“免确认执行”。`forbiddenActions` 永远不能通过人工确认覆盖。

### 5.3 影响面结果

影响面不能用 `undefined` 同时表达“没有影响”和“采集失败”：

```ts
export type ImpactSurfaceAssessment =
  | {
      status: 'available';
      capturedAt: string;
      expiresAt: string;
      affectedUsers: number;
      errorRate: number;
      baselineErrorRate: number;
      currentQps: number;
      peakQps: number;
      downstreamHealthy: boolean;
      quality: 'complete' | 'partial';
      evidenceIds: string[];
    }
  | {
      status: 'unavailable' | 'stale';
      reasonCode: string;
      capturedAt?: string;
      evidenceIds: string[];
    };

export interface ImpactSurfaceProvider {
  capture(input: {
    profile: ResolvedProfileSnapshot;
    calls: readonly ToolCall[];
    signal: AbortSignal;
    deadline: number;
  }): Promise<ImpactSurfaceAssessment>;
}
```

Provider 每个已准入 batch 最多采集一次，并受共享时间和网络尝试预算约束。Prometheus 只是基础设施实现，Pipeline 只依赖接口。

### 5.4 Guard 与风险决策

```ts
export interface Guardian {
  readonly id: string;
  matches?(input: GuardInput): boolean;
  inspect(input: GuardInput): Promise<readonly Finding[]>;
}

export interface GuardInput {
  runId: string;
  stepId: string;
  tool: Tool;
  toolCall: ToolCall;
  profile: ResolvedProfileSnapshot;
  impact: ImpactSurfaceAssessment;
}

export interface RiskDecision {
  disposition: 'allow' | 'confirm' | 'deny';
  severity: RiskSeverity;
  requireConfirmation: boolean;
  findings: Finding[];
  policyVersion: string;
}
```

`matches` 保持可选，缺失时视为匹配，以兼容已有 Guardian。Tool 增加可选 `source: 'builtin' | 'mcp' | 'skill' | 'subagent' | 'external'`；现有 Tool 没有该字段时允许使用受控的 legacy 推断，但所有新 Adapter 必须显式填写。

`Finding.metadata` 只在内部使用。进入 V2 Event 前必须投影成当前严格 Schema 允许的安全字段，不得把敏感参数或动态原始指标放入事件。

`Tool.source` 只补充执行来源元数据，不改变 Tool 的 input schema、模型可见 JSON Schema 或 `ToolResponse` 契约。

### 5.5 Batch 治理快照

暂停和恢复必须使用首次风险评估的事实：

```ts
export interface ToolBatchGovernanceSnapshot {
  profileRevision: string;
  profileDigest: string;
  impact: ImpactSurfaceAssessment;
  decisions: Array<{
    toolCallId: string;
    inputDigest: string;
    decision: RiskDecision;
  }>;
  evaluatedAt: string;
}

export interface PendingToolBatch {
  governance?: ToolBatchGovernanceSnapshot;
}
```

HITL 授权绑定 `toolCallId + inputDigest + profileDigest + expiresAt`。恢复时任一身份不一致都必须重新评估，不能继承旧授权。

### 5.6 兼容与迁移

- `AgentContext.governance`、`PendingToolBatch.governance`、`Tool.source` 和 `ContextSummary` 新字段均为加法兼容；读取旧数据时由集中 Codec 填充默认值，写入时使用新的 checkpoint schema version。
- 历史 Run 缺少 ProfileSnapshot 时只能按旧语义完成只读恢复；不得用当前在线 Profile 为已经暂停的 action 补造授权依据。无法安全恢复的 action 进入人工核验终态。
- `ContextSummary` 的新增数组字段在旧消息中缺失时按空数组读取；Message V2 Schema、序列化器和兼容性测试必须同时更新，不修改既有字段语义。
- `LOOP_DETECTED` 只作为新增 V2 事件注册；不改名、不复用现有事件，也不扩张 V1 EventType。
- SQLite Outbox 使用独立的向前迁移创建表和索引；迁移不得重写历史 EventStore 或 Checkpoint。内存实现与 SQLite 实现遵守同一接口和合同测试。
- 所有新 digest 使用带版本前缀的规范化算法；算法升级只能新增版本，不能令暂停中的 ToolCall 在恢复时悄然改变身份。

## 6. Guard 与 RiskPolicy

### 6.1 GuardianCoordinator

首批 Guardian：

- `BashGuardian`：破坏性命令、工作区边界、敏感路径、提权、嵌套命令和网络外发。
- `McpGuardian`：MCP 来源权限、敏感字段名和动作能力声明；不重复执行 Schema 校验。
- `ProfileGuardian`：动作白名单、禁止列表、服务等级、冻结期和已知约束。
- `ImpactSurfaceGuardian`：影响用户数、错误率、流量和下游健康度。

Coordinator 使用 `Promise.allSettled` 并按 Guardian 注册顺序、Guardian 内规则顺序收敛 Finding，确保结果确定。每个 Guardian 有独立 deadline，但不能自行重试数据源。

失败策略：

- ProfileGuardian 不可用：所有 action 为 deny；证据/utility 返回 HIGH Finding。
- BashGuardian 不可用：Bash 为 deny。
- ImpactSurface 不可用或过期：S0/S1 action 为 deny，S2/S3 action 为 confirm；只读取证仍可执行并记录局限。
- 其他 Guardian 异常：action 至少 confirm；只读 Tool 产生 `guard.unavailable` Finding，不静默变成 SAFE。

### 6.2 RiskPolicy

RiskPolicy 是纯函数，不访问网络或存储：

```text
命中 forbiddenActions                       -> deny
必要 Guardian 不可用                        -> deny 或按 Profile 明确降级
任何真实 action（第一阶段）                  -> confirm
HIGH / CRITICAL                             -> confirm
tool.requireUserConfirm                     -> confirm
只读 evidence / utility 且最高风险 <= MEDIUM -> allow
```

风险取最严格结果：`deny > confirm > allow`。白名单不得降低 Finding 的 severity，也不得覆盖敏感路径、冻结期、S0/S1 或 CRITICAL 规则。

PolicyDenyHook 把 deny 映射为稳定 `POLICY_DENIED` ToolResult，并发布已有 `TOOL_CALL_REJECTED`。RiskActionHook 只处理 confirm，产生可序列化 interrupt。

## 7. Hooks 系统

“Hook”分为控制型和观察型两种接口，避免短路导致审计丢失。

### 7.1 控制型 Hook

控制型 Hook 可以改变执行流：

- `EvidenceBudgetHook`
- `PolicyDenyHook`
- `RiskActionHook`

执行顺序固定为：

```text
EvidenceBudgetHook -> PolicyDenyHook -> RiskActionHook
```

第一个 abort/interrupt 终止后续控制型 Hook。modifiedInput 必须重新通过语义校验并重新计算 inputDigest；不能在风险评估后静默改变参数。

### 7.2 生命周期观察者

观察者不能返回 continue/interrupt/abort，也不能执行外部写入：

```ts
export interface ToolLifecycleObserver {
  readonly id: string;
  observe(fact: ToolLifecycleFact): Promise<readonly GovernanceEffect[]>;
}

export type GovernanceEffect =
  | { type: 'audit'; fact: AuditFact }
  | { type: 'checkpoint'; intent: CheckpointIntent }
  | { type: 'memory_signal'; signal: DiagnosisSignal };
```

逻辑能力映射如下：

- `AuditHook`：生成脱敏 AuditFact；权威审计由 V2 AuditProjector 持久化。
- `CheckpointHook`：只生成 CheckpointIntent；不调用 Store、不修改 revision。
- `DiagnosisMemoryHook`：生成结构化 DiagnosisSignal；不保存原始文本、不自动晋级经验。

Pipeline 收集 effects，并交给 Harness/UoW 与当前状态一起提交。即使控制 Hook 中断或 ToolRunner 失败，观察者仍会接收到最终 lifecycle fact。

观察者失败不能把已成功的外部动作伪装成未执行。动作结果已返回但状态提交失败时沿用现有 uncertain 语义，禁止自动重放。

### 7.3 恢复边界

HookRegistry 只用于按 ID 验证 interrupt 来源和重建静态策略，不调用任意 `handleResume()`。确认、拒绝、过期与外部结果继续由 HitlService、ExternalToolResultService 和 Harness 恢复状态机处理，且必须携带期望 checkpoint revision。

未知 hookId、过期 interrupt 或输入摘要不一致均 fail-closed，并产生模型可见的终态 ToolResult。

## 8. Loop Detection

### 8.1 状态和签名

```ts
export interface LoopSample {
  signature: string;
  toolName: string;
  stage: DiagnosisStage;
  status: 'success' | 'failed' | 'timeout' | 'skipped';
  stepId: string;
  recordedAt: string;
}

export interface LoopState {
  history: LoopSample[];
  lastSignature?: string;
  consecutiveCount: number;
  level: 'none' | 'warn' | 'hard' | 'force_break';
  blockedSignatures: string[];
}
```

签名输入固定为：

```text
diagnosis stage
+ toolName
+ canonical normalized input digest
+ terminal status
+ sanitized structured result digest
```

结果摘要先移除时间戳、随机 ID、分页游标和原始样本，只保留确定性指标、错误码、coverage、truncated 与 evidenceId 集合。不得用“结果前 200 字符”作为签名，也不得把原文或完整签名输入写入事件。

只统计 success、failed、timeout 等终态结果。`skipped` 仅在原因是稳定且确定性的 `already_executed` 时计数；其他 skipped、interrupted、awaiting_external、用户取消和 Admission 拒绝不进入连续计数。不同签名立即把 `consecutiveCount` 重置为 1；非连续历史只用于审计和模式分析，不触发三级干预。

### 8.2 三级干预

- 第 3 次相同签名：WARN。将治理提示作为尾部动态 Model Context 注入，不追加到稳定系统前缀，也不伪造历史消息。
- 第 5 次：HARD。把当前签名加入 blockedSignatures；Admission 确定性拒绝相同调用。模型 Adapter 支持时，下一轮附加 `toolChoice: 'none'`，但本地拦截才是安全保证。
- 第 7 次：FORCE_BREAK。保存 partial diagnosis 和 missingEvidence，以 `LOOP_DETECTED` 非可重试错误结束 Run。

并行批次按原始 ToolCall 顺序更新 LoopState，不能按 Promise 完成顺序更新。LoopState 与终态 ToolResult 在同一个 durable transition 中提交，提交后才能发布循环事件。

### 8.3 事件

Event V2 Subsystem 事件族新增：

```ts
export interface LoopDetectedPayload {
  level: 'warn' | 'hard' | 'force_break';
  repeatCount: number;
  toolName: string;
  signatureDigest: string;
  action: 'hint_injected' | 'signature_blocked' | 'run_terminated';
  stage: DiagnosisStage;
}
```

事件名为 `LOOP_DETECTED`。它是新增 V2 事实，不修改 V1 EventType；旧 AsyncGenerator 消费者仍通过现有 ToolResult、RUN_FAILED 和 final result 观察行为。公共投影只展示工具人话标签、级别和动作，不展示输入摘要或内部规则细节。

## 9. Context Compression

压缩只改变模型上下文投影视图，不删除 EventStore、MessageStore、EvidenceStore 或审计事实。

### 9.1 L0：证据外置和 ToolResult 有界化

L0 位于证据摄取边界：

```text
Tool/DataSource 原始流
  -> EvidenceRecorder 或 StreamingEvidenceRecorder
  -> 原文提交并回读校验
  -> 确定性聚合与脱敏摘要
  -> 有界 ToolResult + evidence_ref
```

规则：

- 指标等小证据继续使用不超过 1 MiB 的 SQLite inline record。
- 日志和 Trace 使用 Manifest + BlobStore；不允许提高 SQLite 或 MCP 上限容纳几十 MiB 原文。
- 模型可见单个 ToolResult 默认不超过 16 KiB。
- Evidence Tool 若返回超限结果且没有已提交 evidenceId，Pipeline 以 `BUDGET_EXCEEDED/details.category=tool_result_too_large` 失败，不能直接截断并假装成功。
- 原文提交失败时不生成 evidence_ref；partial 证据必须显式携带 coverage、truncated 和 missingEvidence。

通用 `ToolResultCompactor` 只负责验证和构造模型视图。它不能把任意 ToolResult 擅自包装成 EvidenceRecord；证据身份必须由 EvidenceRecorder 创建。

### 9.2 L1：确定性结构裁剪

默认在消息数量达到 40 时评估 L1，保留最近 16 条模型消息，同时保护：

- pendingToolBatch 和 pendingInterrupt 对应调用。
- confirmation_request / confirmation_result。
- action_proposal / action_result。
- 未解决风险、missingEvidence 和已确认事实。
- 仍被诊断、报告或摘要引用的 evidenceId。
- 尚未完成配对的当前 ToolCall。

历史 ToolCall/ToolResult 可以被一个结构化 context_summary 引用替代，但不能只删除其中一侧。L1 使用纯函数产生候选 Context，不原地修改当前 frame。

### 9.3 L2：结构化模型摘要

L2 在预计 token 占模型窗口 70% 时触发；无法获得 tokenizer 时使用 256 KiB 序列化字节作为保守回退阈值。

```ts
export interface HistorySummarizer {
  summarize(input: HistorySummaryInput, options: {
    signal: AbortSignal;
    deadline: number;
  }): Promise<StructuredHistorySummary>;
}
```

摘要模型使用独立 compact model、禁用 Tool、共享剩余 deadline，并输出经 Zod 严格校验的结构。来源日志和 Tool 文本被标记为不可信数据，不能覆盖摘要指令。最多允许一次模型级重试；失败后保留压缩前状态并退回 L1。

`ContextSummary` 使用可选字段扩展以保持兼容：sourceMessageIds、keyToolCalls、evidenceIds、confirmationIds、riskRuleIds 和 summaryVersion。L2 不得创造新的事实、evidenceId 或 ToolResult。

### 9.4 CompressionState

```ts
export interface CompressionState {
  summaryVersion: number;
  lastLevel: 'none' | 'L0' | 'L1' | 'L2';
  sourceMessageIds: string[];
  protectedMessageIds: string[];
  offloadedEvidenceIds: string[];
  lastCompressedAt?: string;
}
```

该状态随 Checkpoint 保存，用于恢复后避免重复摘要同一历史范围。

## 10. 压缩完整性校验

CompressionValidator 是异步接口，因为 evidenceId 需要回查：

```ts
export interface CompressionValidator {
  validate(input: {
    before: AgentContext;
    candidate: AgentContext;
  }): Promise<CompressionValidationResult>;
}
```

校验规则：

1. 当前可见 ToolCall 必须有 ToolResult，或明确存在于 pendingToolBatch。
2. 已被摘要替换的历史调用必须出现在 context_summary.keyToolCalls 中。
3. 每个 evidenceId 必须可回查 committed/partial Evidence；pending/failed Evidence 不可注入模型。
4. confirmed/rejected ToolCall、动作结果、风险结论、missingEvidence 和 pending interrupt 必须仍可从结构化状态或摘要恢复。
5. 摘要中的 ID 必须来自压缩前 Context 或 Store，不允许模型生成新 ID。
6. 压缩后序列化数据、消息数量和预计 token 必须低于对应阈值，否则视为未达到目标。

Validator 失败时不替换 frame.context。系统发布 `CONTEXT_COMPRESSION_FAILED(fallbackPolicy=retain_previous)`；若能通过确定性修复恢复引用，则额外发布 `CONTEXT_INTEGRITY_REPAIRED`。不能通过伪造成功 ToolResult 修复配对。

## 11. 耐久提交与事件 Outbox

当前 UoW 继续保留。新增通用但窄用途的治理 transition：

```ts
export interface DurableTransitionUnitOfWork {
  commit(input: {
    expectedRevision: number;
    context: AgentContext;
    execution?: ToolExecutionRecord;
    result?: ToolExecutionResult;
    outboxEvents: readonly UnsequencedAgentEventV2[];
  }): Promise<StoredRunCheckpoint>;
}
```

SQLite 在同一事务中更新 Checkpoint、必要的 ToolExecution、结果和 Outbox。内存实现通过同一合同测试。现有 `commitToolResult`、`markToolUncertain` 保留为兼容适配器，不做破坏性删除。

Outbox 规则：

- 每个事实事件在提交前获得稳定 eventId；重试沿用同一 ID。
- Dispatcher 只在事务提交后调用 EventPublisherV2。
- EventStore 对相同 eventId 的精确重复幂等，对同 ID 不同内容报冲突。
- Runtime 启动时有界扫描并补发 pending Outbox；`resumeStream` 在继续当前 Run 的模型/工具前补发该 Run 的 pending Outbox。扫描游标和批量上限由 Store 配置提供，不能无界加载全部历史事件。
- durable Outbox 未排空时，Run 不得继续执行新的 action。
- transient Delta 不进入 Outbox。

V1 EventBus 继续由 V2 Projector 产生。AsyncGenerator 的 V1 兼容事件在对应 V2 durable 事件成功追加后 yield，并由合同测试保证 payload 和顺序与 EventBus 投影一致。

## 12. 错误、降级和安全语义

| 场景 | 行为 |
|---|---|
| Profile 不存在或损坏 | Run 在模型调用前失败，`INVALID_INPUT` 或 `STORAGE_ERROR` |
| Profile revision 无法恢复 | fail-closed，不使用当前在线配置替代旧快照 |
| 影响面不可用 | 按服务等级 deny/confirm，只读取证可部分继续 |
| 必要 Guardian 失败 | action deny；只读工具记录 HIGH Finding |
| Audit 投影失败 | 已提交事实不回滚，进入投影重试/死信 |
| Post observer 失败 | 保留真实 ToolResult；不自动重复外部动作 |
| Loop HARD 后模型仍调用相同签名 | Admission 确定性拒绝并返回配对失败 ToolResult |
| L2 模型失败或 JSON 无效 | 保留旧 Context，降级 L1 |
| Evidence 外置失败 | 不返回 evidenceId，不发布可用证据事件 |
| Compression Validator 失败 | 候选状态废弃，保留旧 Checkpoint |
| Outbox 暂时不可发布 | 保存 pending，暂停后续 action，恢复时补发 |

所有错误只包含稳定错误码和安全 details.category，不包含 Profile 正文、Tool 原始输入、日志正文或内部路径。

## 13. 模块边界与建议目录

```text
src/contracts/
  governance.ts
  loop-detection.ts
  context-compression.ts

src/profiles/
  profile-resolver.ts
  profile-types.ts

src/guard/
  guardian-coordinator.ts
  risk-policy.ts
  bash-guardian.ts
  mcp-guardian.ts
  profile-guardian.ts
  impact-surface-guardian.ts

src/hooks/
  control-hook-executor.ts
  lifecycle-observer-executor.ts
  policy-deny-hook.ts
  audit-hook.ts
  checkpoint-hook.ts
  diagnosis-memory-hook.ts

src/agent/loop-detection/
  signature.ts
  detector.ts
  policy.ts

src/context-compressor/
  orchestrator.ts
  l0-tool-result-compactor.ts
  l1-structural-compressor.ts
  l2-history-summarizer.ts
  compression-validator.ts

src/storage/
  durable-transition.ts
  durable-event-outbox.ts

src/infrastructure/
  prometheus/impact-surface-provider.ts
  sqlite/durable-transition-store.ts
  sqlite/event-outbox-store.ts

src/bootstrap/
  runtime-governance.ts
```

这些文件只是职责边界，不要求创建大型通用类。每个实现面向小接口，具体 Provider、Store 和摘要模型均由 bootstrap 组装。

## 14. 测试策略

### 14.1 合同和单元测试

- ProfileSnapshot 规范化、digest、时区冻结期和旧 Checkpoint 迁移。
- Guardian matches 兼容、多 Guardian 顺序、超时和失败策略。
- allowedActions 不免除 action HITL；forbiddenActions 无法被确认覆盖。
- sensitive key 递归检测和事件脱敏，不用字符串包含误判。
- Control Hook 短路与 Lifecycle Observer 必达。
- Loop 签名稳定、非连续重复不误报、3/5/7 阈值和 history 上限。
- L1 保护规则、L2 Schema 校验、来源 ID 防伪和失败回滚。
- 内存/SQLite DurableTransition 与 Outbox 通过相同合同测试。

### 14.2 集成测试

- `Guard -> PolicyDeny/RiskAction -> HITL -> ToolRunner` 完整顺序。
- S0/S1 action 在影响面缺失时不能执行。
- 暂停重启后沿用原 ProfileSnapshot、inputDigest 和 RiskDecision。
- 并行 Tool 按原调用顺序更新 LoopState。
- Loop 计数跨进程恢复；HARD 本地拦截不依赖模型供应商。
- ToolResult、LoopState、Checkpoint 和事件 Outbox 的 CAS 冲突隔离。
- L0 证据先提交后引用；L1/L2 压缩后 pending batch 和确认状态仍完整。
- V2 Event、V1 EventBus 与 AsyncGenerator 兼容事件顺序一致。

### 14.3 端到端与资源测试

- 重复模型调用依次触发 WARN、HARD、FORCE_BREAK，并保留部分诊断。
- HITL、外部执行和压缩状态可跨 Runtime 重启恢复且不重复动作。
- 至少 64 MiB 生成日志验证 Blob 摄取内存不随总量线性增长。
- Abort、慢 Blob、PIT 过期、partial evidence 和熔断都有确定性结果。
- Message、公共 Event、SSE 和 LangSmith 不含原始日志、凭证或内部路径。
- Outbox 在“状态提交后、事件发布前”模拟崩溃，重启后只补发一次。

## 15. 实施增量

该架构按六个可独立验收的增量实施，每个增量单独计划和提交：

1. **共享契约与耐久事件**：governance 状态、Codec 迁移、`LOOP_DETECTED`、DurableTransition 和 Outbox。
2. **Profile、Impact 与 Guard**：ProfileResolver、ImpactSurfaceProvider、四个 Guardian 和 RiskPolicy。
3. **Hooks 重构**：控制 Hook、生命周期观察者、PolicyDeny、审计、CheckpointIntent 和记忆信号。
4. **Loop Detection（已完成）**：签名、持久化计数、三级策略、Model 可选 toolChoice 与 Admission 强制拦截。
5. **L0 与大证据边界**：实现 ToolResultCompactor，并把本方案接到 `StreamingEvidenceRecorder`/`BlobStore` 公共接口。若该数据面尚未实现，先按既有 ELK 设计形成并执行独立实施计划；本增量不在上下文压缩计划中重复设计其内部实现。
6. **L1/L2 与完整性**：结构裁剪、compact summarizer、Validator、回滚和全链路恢复测试。

前一增量必须通过合同测试和全量质量门禁，后一增量才能开始。单个实施计划不得同时跨越两个增量，避免一次修改 Harness、Store、Event、Guard 和 Compressor 的全部关键路径。

## 16. 验收标准

本设计完成的最低标准：

- 每个 action 只有 allow eligibility，没有隐式预授权；真实写动作始终 HITL。
- 禁止动作、敏感路径和必要 Guardian 故障均 fail-closed。
- 所有确认绑定具体 ToolCall、参数摘要、Profile 快照和有效期。
- ToolResult、LoopState、Checkpoint 和对应 durable 事件不会出现“事件先于状态”。
- 进程在任意耐久提交边界退出后，不重复执行动作，不丢失待确认状态。
- 审计覆盖成功、失败、拒绝、中断、恢复和 observer 失败。
- 循环检测完全确定性，跨重启保持计数，且不会把非连续正常复查误判成循环。
- 压缩不删除或伪造 ToolResult、确认、风险、动作、missingEvidence 和 evidence 引用。
- ELK/Trace 原文不进入 SQLite inline JSON、模型上下文或公共事件。
- 内存与 SQLite 实现通过相同契约测试。
- 最终重新运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`。

增量 4 已通过合同测试和全量质量门禁；下一步应单独编写并审阅“增量 5：L0 与大证据边界”的逐文件、逐测试实施计划，完成后再进入 L1/L2 上下文压缩实现。
