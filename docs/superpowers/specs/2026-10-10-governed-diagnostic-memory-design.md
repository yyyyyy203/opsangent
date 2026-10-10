# 受控诊断记忆一期设计 Spec

日期：2026-10-10。修订：R2（沉淀/召回分离、手动保存、向量实验边界）。状态：待实施；本文不代表代码已具备这些能力。R2 取代本文件初稿中“全部功能默认关闭”和“向量能力完全排除”的范围约定，不改变已经发布的代码契约。

## 1. 目标、依据和当前事实

目标：在现有只读巡检链路上形成“前端沉淀/策略保存 → observation 案例 → 人工审核 → 独立开启同范围召回 → 下次调查参考”的闭环。四类记忆保留各自职责，不用案例记忆冒充完整记忆系统；基础提取不增加记忆专用模型调用。向量存储和检索通过独立实验验证，不作为基础闭环的隐藏依赖。

参考用户提供的 `2026-01-12-memory-system-design-v2.md` 中的四类记忆、分层接口、质量管理和混合检索思想；采用 clean-room 实现，不复制其他项目代码。其向量模型资源、耗时、准确率和工期估计不作为本项目承诺。

本次代码核验结果：

| 位置 | 已有事实 | 本期衔接方式 |
|---|---|---|
| `src/contracts/memory.ts` | `MemoryFacade` 已发布，查询缺少强制环境/来源隔离 | 原接口保留，新增严格的小接口；不让旧宽松查询访问正式案例库 |
| `src/memory/in-memory-memory.ts` | 内存原型，未接入 runtime；不是完整生产记忆 | 保留兼容，新增独立实现和契约测试 |
| `src/hooks/diagnosis-memory-hook.ts` | 已产生有界 `memory_signal` | 仅在允许收集候选的父 Run 内事务落库；召回关闭不阻止保存，不在 Hook 中查询或修改长期记忆 |
| SQLite `DurableTransitionUnitOfWork.commit` | 接口接收 `governanceEffects`，具体实现未保存记忆信号 | 补信号持久化；不顺手重构其他 Hook effect |
| `src/contracts/event-v2/subsystem.ts` | 已有记忆检索、更新、候选和审核事件 | 保留类型及字段，补发布点与安全投影测试 |
| `src/contracts/context.ts` / `src/storage/durable-codec.ts` | 无结构化记忆状态；Checkpoint codec 为严格校验 | 分别增加宿主解析的控制快照和召回状态，明确 Schema 3 和旧数据读取策略 |
| SQLite migrations | 当前版本 4，无记忆表，也没有 `runs` 表 | 追加迁移，不给不存在的 `runs(id)` 建外键 |
| Harness / Web bootstrap | 已有权威主循环、模型视图、显式查询与本地前端入口 | 构造器注入；不另建主循环、不把事件当命令 |

本机已用当前分支的 Node 和 `better-sqlite3` 在内存库验证 FTS5 建表及中文 token 查询可用。这只证明本机能力，不等于其他部署环境通过预检。

## 2. 本期范围和非目标

| 记忆 | 职责和接口边界 | 本版交付 | 明确尚未覆盖 |
|---|---|---|---|
| Working | 当前 Run 事实，走 AgentContext 与 CheckpointStore，不走长期案例索引 | 复用既有运行状态，增加独立控制快照、召回快照及恢复测试 | 不宣称已有完整事实/假设/待办记忆编辑器，不建第二份工作状态库 |
| Episodic | 一次调查的报告、质量、限制和证据引用，走本 Spec 的案例查询/捕获/审核小接口 | 保存、失败调查归档、审核、撤销、有界召回、前端与重启闭环 | 不自动判断根因正确或业务恢复 |
| Semantic | 拓扑、指标定义、阈值、Runbook，受控 Profile/知识输入是来源，不是历史结论 | 继续使用既有 Profile；明确独立知识管理与检索边界 | 可编辑、版本化、可检索的完整语义知识库尚未实现，不能以 Profile 配置宣称完成 |
| Procedural | 经过审核、具备适用条件的调查步骤模板，不是一个被批准的案例 | 保留既有经验候选兼容接口与人工晋级约束 | 模板生成、版本、条件匹配与模板召回尚未实现；不启用自动动作或跳过必需取证 |

基础阶段 A 优先完成 Episodic 产品闭环和 Working 恢复接线。四类是职责划分，向量是检索方式：Working 不需要向量化，未来 Semantic/Episodic 可以使用向量，Procedural 仍必须先校验适用条件与审核。不得新增没有实现和验收的占位接口来宣称“四类完成”。

基础召回采用 FTS5/BM25 与中文 bigram，向量阶段 B 使用独立 [向量记忆可用性实验 Spec](./2026-10-10-memory-vector-feasibility-design.md) 和 [实验实施计划](../plans/2026-10-10-memory-vector-feasibility.md)。实验包含真实向量落库、排名、重启、隔离和降级；不强制采用 sqlite-vss，不修改基础默认召回，不承诺语义效果已经提升。

### 2.1 控制层次和默认行为

| 控制 | 所属层 | 默认与含义 |
|---|---|---|
| 服务可用 `enabled` | 部署配置 | 未安装/未配置时为 false，保持旧运行行为；配置有效后一次性启用，不要求用户每次找开发人员改开关 |
| 保存策略 `captureDefault` | Profile 策略与每次 Run 偏好 | 服务启用后默认 manual；前端可点击“沉淀本次巡检”，允许的 Profile 可选 automatic；skip 表示本轮不自动沉淀 |
| 召回策略 `recallDefault` | Profile 策略与每次 Run 偏好 | 服务启用后默认 false；可只积累案例而不注入模型，不影响保存、列表、审核 |
| 审核晋级 | 显式人工命令 | 无“自动批准”开关；保存一律 observation，质量门与人工审核不能绕过 |
| 向量实验 | 独立测试配置 | 默认关闭，不影响保存和 BM25；阶段 B 验收不代表生产召回已经切换 |

合法启用配置的字段缺省由配置解析器补齐：captureDefault=manual、recallDefault=false、allowAutomaticCapture=false、allowRecall=true；禁止的 automatic/recall 不能被用户覆盖。解析后的 DiagnosticMemoryConfig 不保留未解析的缺省项。

前端只传白名单偏好，不传可信 scope/审核者或存储配置；管理员可以禁止 automatic/recall，用户只能在允许范围内选择。automatic 只保存已完成父 Run 的候选，不自动批准。manual/skip 均不自动入队；用户事后明确点击保存是新的沉淀请求，不修改该 Run 的原始策略。不沉淀不等于删除已经保存的运行审计/Checkpoint。

现有真实模型烟测和评测入口显式禁用捕获与召回；记忆验收使用独立 SQLite、模拟数据和 ScriptedModel。日常模拟案例可以积累到 observation，人工 approved 后仅同一模拟范围可用、不可晋级真实经验；评测不得读取同批测试产生的记忆。基础验收不访问 DeepSeek、LangSmith 或真实业务系统。

## 3. 依赖与组装

```text
bootstrap/diagnostic-memory
  ├─ SQLite / InMemory 存储实现
  ├─ MemoryCaptureWorker / MemoryReviewService
  └─ BoundedMemoryRecall / MemoryHintRenderer
       └─ 注入 AgentHarness 的 Pre-reasoning 和模型视图边界

完成的父 Run + automatic ─终态事务─> Capture Job ─显式 Worker─> observation
用户“沉淀本次巡检” ─独立命令事务──────────┘                        ↓ 人工审核
下一次同范围 Run + recall=true <─有界模型视图─ Recall <────────── approved
```

核心仅依赖 `contracts/diagnostic-memory.ts`。存储负责事务和索引，召回负责过滤与预算，Worker 负责案例生成，审核服务负责状态机，Renderer 只生成模型视图。具体组装置于 `bootstrap/`，不得在 Harness、Hook 或 API 中实例化 SQLite。

原 `MemoryFacade` 不改名、不删方法、不改变历史含义。新库不实现“省略范围的 recall”；原内存原型和新实现的兼容关系由独立测试说明，不以宽松接口绕过隔离。

## 4. 严格范围与候选数据

以下类型新增至 `src/contracts/diagnostic-memory.ts`，另建 `diagnostic-memory-schema.ts` 做严格解析。时间均为带时区 ISO 时间，ID 非空且有界；`digest` 为 SHA-256 十六进制。本文未列出的可执行 SDK、SQL 类型不能进入 contracts。

```ts
import type { AgentContext } from './context.js';
import type { AgentMessage } from './message.js';
import type { PendingAgentEventV2 } from './event-store.js';

export interface MemoryScopeBase {
  profileId: string;
  profileRevision: string;
  serviceId: string;
  faultType: string;
  targetFingerprint: string;
}
export type MemoryScope = MemoryScopeBase & (
  | { environment: 'simulation' | 'development' | 'staging';
      dataClass: 'simulated'; datasetId: string }
  | { environment: 'development' | 'staging' | 'production'; dataClass: 'live' }
);
export type MemoryQuality = 'sufficient' | 'insufficient' | 'failed';
export type MemoryStatus = 'observation' | 'approved' | 'rejected';
export type MemoryCaptureMode = 'manual' | 'automatic' | 'skip';
export interface MemoryPreferences {
  capture?: 'profile' | MemoryCaptureMode;
  recall?: 'profile' | 'enabled' | 'disabled';
}
export interface RunMemoryControl {
  schemaVersion: 1;
  scope: MemoryScope;
  profilePolicyRevision: string;
  capture: MemoryCaptureMode;
  recall: boolean;
}
export type DiagnosticMemoryConfig =
  | { enabled: false }
  | { enabled: true; profiles: readonly {
      scope: MemoryScope; profilePolicyRevision: string;
      captureDefault: MemoryCaptureMode; recallDefault: boolean;
      allowAutomaticCapture: boolean; allowRecall: boolean;
    }[]; requiredSources: readonly HistoricalEvidenceRef['source'][];
    modelWindowTokens: number; reservedOutputTokens: number };
export interface MemoryCapabilities {
  enabled: boolean;
  kind: 'episodic';
  reviewMode: 'local_operator';
  manualCapture: boolean;
  automaticCapture: boolean;
  recall: boolean;
  defaults: { capture: MemoryCaptureMode; recall: boolean };
  vectorExperiment: 'separate';
}
export interface MemoryPolicyPort {
  allows(control: RunMemoryControl, capability: 'capture' | 'recall'): boolean;
}

export interface HistoricalEvidenceRef {
  evidenceId: string;
  ownerRunId: string;
  source: 'metric' | 'log' | 'trace' | 'change';
  capturedAt: string;
  rawSha256: string;
}
export interface DiagnosticMemoryCase {
  schemaVersion: 1;
  id: string;
  revision: number;
  extractorVersion: 'episodic-v1';
  scope: MemoryScope;
  sourceRunId: string;
  sourceRunStatus: 'completed' | 'failed' | 'cancelled';
  capturedAt: string;
  validUntil: string;
  status: MemoryStatus;
  quality: MemoryQuality;
  summary: string;
  symptomCodes: readonly string[];
  limitations: readonly string[];
  evidenceRefs: readonly HistoricalEvidenceRef[];
  diagnosisOnly: true;
  eligibleForPromotion: boolean;
  digest: string;
}
export interface MemoryHint {
  memoryId: string;
  revision: number;
  digest: string;
  sourceRunId: string;
  capturedAt: string;
  validUntil: string;
  summary: string;
  limitations: readonly string[];
  evidenceRefs: readonly HistoricalEvidenceRef[];
  diagnosisOnly: true;
}
export interface MemorySelection {
  memoryId: string;
  revision: number;
  digest: string;
}
export interface RunMemoryState {
  schemaVersion: 1;
  scope: MemoryScope;
  selectionState: 'unselected' | 'selected';
  availability: 'ready' | 'empty' | 'unavailable';
  selections: readonly MemorySelection[];
  hints: readonly MemoryHint[];
  selectedAt?: string;
  validatedAt?: string;
  reasonCode?: MemoryErrorCode;
}
export type MemoryErrorCode =
  | 'MEMORY_SCOPE_INVALID' | 'MEMORY_DATA_INVALID'
  | 'MEMORY_REVISION_CONFLICT' | 'MEMORY_REQUEST_CONFLICT'
  | 'MEMORY_APPROVAL_DENIED' | 'MEMORY_EVIDENCE_UNAVAILABLE'
  | 'MEMORY_SOURCE_CONFLICT' | 'MEMORY_RUN_NOT_TERMINAL' | 'MEMORY_POLICY_DENIED'
  | 'MEMORY_CAPACITY_EXCEEDED' | 'MEMORY_LOOKUP_FAILED'
  | 'MEMORY_CAPTURE_FAILED' | 'MEMORY_DISABLED';
export interface MemoryOperation {
  now: string;
  signal?: AbortSignal;
  deadlineMs: number;
  availableMemoryTokens?: number;
}
export interface MemorySearch {
  scope: MemoryScope;
  text: string;
  excludeRunIds: readonly string[];
  limit: number;
  now: string;
}
export interface MemoryQueryStore {
  get(id: string, scope: MemoryScope): Promise<DiagnosticMemoryCase | null>;
  getCapture(input: { runId: string; scope: MemoryScope }): Promise<MemoryCaptureTicket | null>;
  findCaptureResult(command: MemoryManualCaptureCommand): Promise<MemoryCaptureTicket | null>;
  findReviewResult(command: MemoryReviewCommand): Promise<DiagnosticMemoryCase | null>;
  list(input: { scope: MemoryScope; status?: MemoryStatus;
    afterId?: string; limit: number }): Promise<readonly DiagnosticMemoryCase[]>;
  search(input: MemorySearch): Promise<readonly DiagnosticMemoryCase[]>;
  revalidate(input: { scope: MemoryScope; selections: readonly MemorySelection[];
    now: string }): Promise<readonly DiagnosticMemoryCase[]>;
}
export interface MemoryRecallPort {
  prepare(input: { runId: string; text: string; state: RunMemoryState },
    operation: MemoryOperation): Promise<RunMemoryState>;
}
export interface MemoryHintRenderer {
  render(state: RunMemoryState, operation: MemoryOperation): AgentMessage | null;
}
export interface MemoryCaptureRequest {
  candidateId: string;
  sourceRunId: string;
  scope: MemoryScope;
  extractorVersion: 'episodic-v1';
  origin: 'automatic' | 'manual';
  requestId: string;
  sourceRunStatus: 'completed' | 'failed' | 'cancelled';
  sourceContextVersion: number;
  sourceCheckpointChecksum: string;
  requiredSources: readonly HistoricalEvidenceRef['source'][];
  requestedAt: string;
}
export interface MemoryCaptureIntent {
  request: MemoryCaptureRequest;
  scheduledEvent: PendingAgentEventV2<'MEMORY_UPDATE_SCHEDULED'>;
  rejectedEvent: PendingAgentEventV2<'MEMORY_UPDATE_FAILED'>;
  failedEvent: PendingAgentEventV2<'MEMORY_UPDATE_FAILED'>;
}
export interface MemoryJobClaim {
  request: MemoryCaptureRequest;
  attempt: number;
  ownerId: string;
  leaseUntil: string;
}
export interface MemoryCaptureTicket {
  sourceRunId: string;
  state: 'not_saved' | 'queued' | 'running' | 'saved' | 'failed' | 'unavailable';
  sourceCheckpointRevision?: number;
  candidateId?: string;
  memoryId?: string;
  reasonCode?: MemoryErrorCode;
}
export interface MemoryManualCaptureCommand {
  sourceRunId: string;
  scope: MemoryScope;
  expectedCheckpointRevision: number;
  requestId: string;
  actorId: string;
  requestedAt: string;
}
export interface MemoryCapturePort {
  capture(command: MemoryManualCaptureCommand,
    operation: MemoryOperation): Promise<MemoryCaptureTicket>;
}
export interface MemoryReviewCommand {
  memoryId: string;
  scope: MemoryScope;
  expectedRevision: number;
  requestId: string;
  decision: 'approved' | 'rejected';
  claimCheck: 'supported' | 'unsupported';
  actorId: string;
  reviewedAt: string;
}
export interface MemoryWriteUnitOfWork {
  enqueueManualCapture(input: { command: MemoryManualCaptureCommand;
    intent: MemoryCaptureIntent }): Promise<MemoryCaptureTicket>;
  claimNext(input: { ownerId: string; now: string; leaseUntil: string;
    maxAttempts: number }): Promise<MemoryJobClaim | null>;
  completeCapture(input: { claim: MemoryJobClaim; candidate: DiagnosticMemoryCase;
    now: string; events: readonly PendingAgentEventV2[] }): Promise<DiagnosticMemoryCase>;
  failCapture(input: { claim: MemoryJobClaim; now: string; code: MemoryErrorCode;
    events: readonly PendingAgentEventV2[] }): Promise<void>;
  review(input: { command: MemoryReviewCommand;
    events: readonly PendingAgentEventV2[] }): Promise<DiagnosticMemoryCase>;
}
export interface MemoryCaptureSource {
  inspect(runId: string, operation: MemoryOperation): Promise<{
    context: AgentContext; checkpointRevision: number;
    checkpointChecksum: string; isParent: boolean;
  } | null>;
  load(request: MemoryCaptureRequest, operation: MemoryOperation): Promise<{
    context: AgentContext;
    evidenceRefs: readonly HistoricalEvidenceRef[];
    requiredEvidenceComplete: boolean;
    limitations: readonly string[];
  }>;
}
export interface MemoryMaintenance {
  prune(input: { now: string; limit: number }): Promise<{
    expiredObservations: number; signalsRemoved: number;
  }>;
}
export interface MemoryCaptureWorkerPort {
  drain(input: { limit: number; signal?: AbortSignal }): Promise<{
    completed: number; failed: number; pending: boolean;
  }>;
  close(): Promise<void>;
}
export interface MemoryReviewPort {
  review(command: MemoryReviewCommand,
    operation: MemoryOperation): Promise<DiagnosticMemoryCase>;
}
export interface MemoryReadServicePort {
  capabilities(profileId: string): MemoryCapabilities;
  list(profileId: string, input: { status?: MemoryStatus; afterId?: string;
    limit: number }): Promise<readonly DiagnosticMemoryCase[]>;
  get(profileId: string, id: string): Promise<DiagnosticMemoryCase | null>;
  getRun(runId: string): Promise<RunMemoryState | null>;
  getCapture(runId: string): Promise<MemoryCaptureTicket>;
}
export interface DiagnosticMemoryRuntime {
  profiles: Extract<DiagnosticMemoryConfig, { enabled: true }>['profiles'];
  policy: MemoryPolicyPort;
  requiredSources: readonly HistoricalEvidenceRef['source'][];
  modelWindowTokens: number;
  reservedOutputTokens: number;
  recall: MemoryRecallPort;
  renderer: MemoryHintRenderer;
  worker: MemoryCaptureWorkerPort;
  capture: MemoryCapturePort;
  reviews: MemoryReviewPort;
  queries: MemoryReadServicePort;
  close(): Promise<void>;
}
```

Implementation Plan 中给出 Worker、手动捕获、审核、召回、Schema 与 renderer 的准确入口。`MemoryQueryStore.revalidate` 同时检查范围、版本、摘要 digest、审核状态、有效期；证据有效性由审核与召回注入的显式只读接口复核，不能只信任记录中的布尔值。上述新类型当前尚未发布，R2 可修订初稿类型；旧 MemoryFacade 的已发布类型不变。

### 4.1 范围来源

- `MemoryScope` 由宿主根据明确的 Profile 与数据源配置构造；HTTP 用户消息、LLM 参数不能指定可信范围、状态或审核者。
- 实际 Target 标识用宿主的非敏感资源 ID 生成 fingerprint；不得把 MCP URL、内部地址或凭据当成可显示字段。
- `profileRevision` 取明确的 Profile revision/digest，不把当前 Web 的 Profile 名称冒充版本。缺少明确配置则记忆关闭/返回空，不从自由文本猜服务或故障类型。
- 所有搜索精确匹配 Profile、revision、服务、故障、环境、数据来源和 targetFingerprint；模拟来源还必须匹配 datasetId。
- 当前无多租户认证。一期仅支持本地单操作员；未来 tenantId、登录授权需要独立契约升级，不宣称现有隔离就是租户安全。

### 4.2 模拟记忆与质量

模拟案例可人工审核为 `approved`，仅在同一模拟范围召回；`eligibleForPromotion` 永远为 false。不能修改 environment 把模拟记录变成真实经验。

Worker 只能使用已持久化的 Run 状态、实际诊断文本和有界证据元数据；禁止读取模拟器 oracle/rootCause、评测 expectedOutcome 或标签文件。评测库和日常试验库分离，当前 Run 永远列入 excludeRunIds。手动保存也不能注入评测答案。

`quality=sufficient` 只表示该 Profile 定义的必需取证完整、关联和哈希有效，不表示根因已经验证。非必需数据源缺失保留在 limitations；必需证据 partial、窗口不正确、引用不属于父/子 Run 或 required completeness 无法确定时均为 insufficient/failed。人工批准仍需 `claimCheck=supported`，缺证记录不能靠人工勾选强行晋级。

一期始终 `diagnosisOnly=true`：只读诊断完成不是“问题已解决”；真实恢复和动作有效性不能从当前报告自动生成。

### 4.3 手动沉淀的产品行为

用户可以在 Run 结束后点击“沉淀本次巡检”，无需改环境变量或重新启动。命令只从服务端已保存的终态取数，不接受用户补写结论、原文、质量、scope 或 approved 标记，也不调用模型补一份报告。前端先显示入队状态，再用查询显示生成成功/失败；保存不代表批准。

允许 completed、failed、cancelled 父 Run 手动归档。后两者固定 `sourceRunStatus`，quality=failed、eligibleForPromotion=false，保存调查失败的原因码与已有安全摘要，不能宣称诊断成功或批准召回。paused、running、awaiting_confirmation 返回 MEMORY_RUN_NOT_TERMINAL，不保存会变化的半份案例。没有可信范围快照的旧 Run、子 Run 或已清理源状态拒绝，不从当前 Profile 猜历史身份。

manual/automatic 在 UNIQUE(sourceRunId, extractorVersion) 下产生同一个 Job/案例，不能双份入库。requestId 重放返回原入队 ticket；查询接口返回最新状态。服务在当前授权检查后先调用 findCaptureResult，合法重放不再次检查旧 CAS/执行入队；源与授权已被清理时仍可返回404，不绕过当前权限。新请求才检查 expectedCheckpointRevision，Job 固定 sourceContextVersion/checksum；源版本不符或恢复变动返回 MEMORY_SOURCE_CONFLICT，不自动重新提取新版本。

保存只新增案例命令、Job、候选及其审计记录，不修改已结束 Run 的状态、Checkpoint revision、消息、用量或证据归属。撤销只改变未来参考资格，不撤销历史审计或工具授权；取消保存/删除功能不作为本期隐含能力。

## 5. 存储、事务与恢复

### 5.1 迁移

在当前 SQLite v4 后追加 v5；如实施前已有新的 migration，顺延为下一版本，不修改已发布迁移。新增：

| 表 | 关键约束 |
|---|---|
| `diagnostic_memory_cases` | id PK；scope_key、各范围列、source_run_id、source_run_status、captured_at、revision、status、quality、valid_until、bounded case_json；UNIQUE(source_run_id, extractor_version) |
| `diagnostic_memory_case_fts` | FTS5 tokens + memory_id UNINDEXED；unicode61；只索引审核有效的文本，事务同步更新 |
| `diagnostic_memory_reviews` | request_id PK；memory_id FK 到实际 cases；actor、decision、claim_check、expected_revision、command_digest、有界原结果 JSON、结果 revision、时间 |
| `diagnostic_memory_capture_jobs` | candidate_id PK；UNIQUE(source_run_id, extractor_version)；pending/running/completed/failed/skipped、attempt、owner、lease_until、request_json、terminal_failure_event_json |
| `diagnostic_memory_capture_commands` | request_id PK；source_run_id、scope_key、actor、expected_checkpoint_revision、command_digest、bounded original_ticket_json；重复命令不产生第二份 Job |
| `diagnostic_memory_signals` | 唯一 signal_key；run_id、tool_call_id、phase、observed_at、bounded signal_json |

scope_key 使用固定规范化序列化的完整范围，而非 JSON 属性顺序。FTS、信号和 Job 的索引版本分别记入内容/元数据，不以“不报错”冒充完成重建。

共用 `SqlitePersistenceBundle` 的数据库和 WAL，不打开第二个隐藏数据库连接。外键只引用已有 memory 表；Run/证据所有权用实际 Checkpoint 与 InspectionQueryService 验证。InMemory 存储实现同一语义用于单元测试，不声称重启持久化。

FTS5 是 v5 迁移的数据库能力要求，升级前预检；不可用则迁移不开始并保留原库。功能关闭不需要模型文件，但不承诺能在缺少 FTS5 的 SQLite 上读取已升级库。

### 5.2 原子边界

扩展 `DurableTransitionUnitOfWork.commit` 的可选 `memoryCapture?: MemoryCaptureIntent`。

1. 工具结果：现有 Checkpoint、Execution Journal、Outbox 与允许 capture 的父 Run 的 `memory_signal` 在同一事务提交；manual/automatic 可收集，skip 不收集，recall=false 不影响该判断。信号唯一键由 runId/toolCallId/phase/outcome/observedAt 规范化得到，重放不重复。
2. 完成父 Run：仅 `memoryControl.capture=automatic` 且 status=completed 时，`RUN_FINISHED` 终态事务登记 Capture Job 与 `MEMORY_UPDATE_SCHEDULED`。首次入队才记录 schedule；队列饱和写 rejectedEvent，主诊断仍正常完成。recall=false 不阻止入队。
3. Worker：候选记录、FTS、Job completed 和候选更新事件同事务提交；崩溃前/后都不能产生两份候选。
4. 审核：CAS 状态、revision、索引、review 记录和审核 Outbox 同事务提交。不得 save 后另行 fire-and-forget 发布。
5. 手动捕获：另开同一数据库的 immediate transaction，检查授权 scope、父 Run、终态、源 Checkpoint revision/checksum，写 capture_commands、去重 Job 与 Outbox，不调用 transitions.commit 重存该 Run。相同 requestId/command_digest 返回原 ticket；不同命令使用同 requestId 返回 409，摘要不含宿主每次生成的 requestedAt。即使自动 Job 已存在，合法手动命令也只绑定已有 Job。

intent 的 rejectedEvent 用于容量拒绝，failedEvent 是预分配 eventId 的生成失败模板，入队时保存、到限恢复时使用；二者固定 category 不同，不拿容量错误冒充生成失败。

原有 SQLite/Checkpoint 本身写失败仍遵循现有失败/uncertain 规则，不能承诺共享数据库损坏时“记忆完全不影响主流程”。只有可选查询、生成和索引服务失败降级为空参考；不得无条件重放任何外部动作。

### 5.3 Worker 和资源上限

- Worker 是显式应用服务，不是第二个 Agent 或 Hook 内的 ReAct。启动恢复和父 Run 完成后的宿主回调可调用 `drain`；无隐式 cron、无限后台循环或模型调用。
- 手动请求持久入队后，宿主显式调度同一个 Worker；列表/审核/关闭 recall 不暂停 Job。部署关闭停止接收新命令并等待当前批次后关库；重新开启只恢复既有 Job，不能自动补跑 manual/skip Run。
- Job claim 使用事务 CAS、ownerId、30 秒 lease；complete/fail 校验 owner+attempt 和未过期 lease。只允许每 Job 最多 2 次生成尝试；到限后 failed，等待操作员检查，不自动无限重跑。
- lease 只保护本地案例 Job，不替代 Run 跨 Worker 恢复机制；一期部署为每 DB 一个 Worker。测试用注入 Clock 推进时间，不实际等待冷却。
- 回收过期 running Job 时，未到两次的回 pending；已达两次的变 failed 并登记固定失败事件。不能让到限 Job 永久留在 running；回收和事件登记同事务、有界最多 50 条。
- 单次 drain 最多 50 Job，pending/running 总量最多 1000；候选每 scope 最多 100 条，approved 最多 1000 条。容量不足拒绝新增，不默默删除 approved。
- 单候选 JSON 最多 16 KiB，summary 2 KiB，证据引用最多 20 条，limitations/symptomCodes 各最多 20 条；来源 Checkpoint 超过 1 MiB 则标记生成失败，不能一次加载无限历史。
- 候选/案例默认有效 30 天，信号默认保留 7 天。`prune` 是有界显式维护接口，先处理过期 observation/signals；approved 过期不再召回，但保留审核/来源元数据，不自动物理删除证据。

## 6. 审核状态机

```text
observation ─支持的声明 + sufficient + 引用有效─> approved
observation ─拒绝────────────────────────────> rejected
approved    ─撤销（新审核）──────────────────> rejected
rejected    ─禁止原地再批准；修订产生新版本候选流程（不属一期）
```

案例内容不可被 review 请求编辑。approved → rejected 是撤销；不修改历史 review。未过期、数据来源匹配、required evidence 完整、哈希/归属可复核且 claimCheck supported 才能 approved。

还必须 sourceRunStatus=completed、quality=sufficient。failed/cancelled 调查只能保留 observation 或人工 rejected，不得凭勾选 supported 变成可信正向案例。人工批准只赋予案例“可作为历史参考”的资格，不自动转换成 Semantic 事实或 Procedural 模板。

证据有效性读取现有受控元数据、归属关系、Manifest 状态/保留期限和记录哈希；retrievable=false 是公共页面不提供原文的设计，不是证据不存在，不能因该字段拒绝所有案例。无需为了审核对大 Blob 全量重算哈希或开放原文 HTTP 接口；内部引用记录不存在/过期/损坏才判不可用。

每次新审核 revision +1；`expectedRevision` 冲突返回 409。相同 requestId + 相同规范化命令返回存入 review 的原结果、不发第二份事件；同 requestId 不同命令返回 409。命令 digest 包含案例 ID、完整 scope、expectedRevision、decision、claimCheck 和 actorId，不包含宿主每次新生成的 reviewedAt。服务先通过 findReviewResult 校验重放，再检查新请求的当前状态/证据；原结果不代表最新状态，UI 操作完成后刷新当前案例。actorId 来自宿主授权上下文，本地为固定 `local-operator`；HTTP body 不接受 actorId。审批只认可当前白名单 memory scope，与 ToolCall 的 HITL 授权完全无关。

Review 服务产生现有 `EXPERIENCE_REVIEWED` 与 `MEMORY_UPDATE_COMPLETED`，前者记录诊断经验候选的人工审核，后者记录案例状态；不表示已经产生 Procedural 模板。模拟数据 eligibility 仍为 not_eligible。

## 7. 召回与模型视图

### 7.1 确定性搜索

顺序：本 Run recall=true → 严格范围 → approved/sufficient/completed 来源/有效期/排除 sourceRun → 文本匹配与 BM25 → 稳定排序 → Top-K → 证据复核 → 预算裁剪。SQL 必须在同一次候选查询的 WHERE 中做范围过滤，不能全库 Top-K 后过滤。召回关闭时不查询/渲染，不删除或禁止保存候选；向量实验关闭或故障不阻止基础 BM25。

FTS 语料内的词频统计可以用于评分，但任何候选返回必须已满足 scope；不返回跨范围文档、全局统计或匹配片段。

中文按 Unicode 字符生成相邻 bigram，英文/标识符正规化为小写 token；不把中文切分寄托给 porter 或空格。输入最多 1 KiB、64 token，逐 token 加引号并绑定为 MATCH 参数，禁止用户直接传 FTS 操作符或 SQL。空/无有效 token 输入返回空。

FTS5 `bm25` 分数越小排名越靠前；同分按 capturedAt 降序、id 升序。模拟/评测 fixture 的期待排序是确定性测试结果，不保证真实诊断准确率。未来混合召回需保留此端口和范围前置约束。

默认 limit=5、硬上限 10；渲染最多 5 条，尾部总计不超过 4 KiB 且不超过 1024 token 的注入预算。无 tokenizer 时用 UTF-8 字节数作为保守 token 上界；超过父 Run 剩余时间或窗口预算直接返回空，不占用取证/输出保留预算。

宿主开启配置必须给出 modelWindowTokens 与 reservedOutputTokens，均为正整数且后者小于前者；它们是宿主确认的模型能力，不从模型名猜。Harness 在现有 compressor 之后根据最终基础消息、system 和 tools 的保守 token 估计计算剩余量，向 Renderer 传 availableMemoryTokens。最终允许量是 min(1024, 剩余窗口扣除输出保留量)；未知剩余量按 0 处理。召回快照可以存在，但没有渲染空间时不注入文本。

### 7.2 接入 Harness

新增可选 `AgentContext.memoryControl?: RunMemoryControl`、`AgentContext.memory?: RunMemoryState` 和宿主专用 `ReplyOptions.trustedMemoryControl?: RunMemoryControl`。控制快照独立于 recall 状态：manual+recall=false 仍有可信 scope，允许事后保存。`ReplyOptions.memoryPreferences?: MemoryPreferences` 是外部白名单偏好；HTTP parser 只接受该偏好，不接受 memory、memoryControl 或 trustedMemoryControl。宿主校验 Profile 允许能力后生成控制快照，当前 Run 的范围与策略在恢复时不从新配置重新推导。

`MemoryPolicyPort.allows` 由 bootstrap 注入，检查当前部署仍启用、完整 scope 与 profilePolicyRevision 仍获允许、所请求能力没有撤销；capture=skip 的新自动保存另由 Harness 拒绝，事后显式手动保存仍需能力检查。配置发生版本变化时旧 control 不被升级，当前 Run 的能力 fail-closed；列表查询和审批也不能利用旧快照绕过当前宿主授权。

仅 recall=true 时在现有 Pre-reasoning 内、reasonStream 前做记忆准备及治理，不改变主循环阶段顺序。第一次选择后冻结 IDs/revision/digest，持久化在 Checkpoint；后续轮次及 resume 只复核这组选择，不重新扩大查询。部署撤销某范围/能力时 fail-closed 不召回/不自动保存，不把已有 snapshot 扩大成新范围；用户偏好不授予新的权限。

已撤销、已过期、修改版本或证据不存在的提示被移除。复核失败清空本次 active hints，标记 unavailable；保存原 selections 供同 revision 的下一次复核。初次查询失败只尝试一次，不每轮反复全库查询。真正 Abort 必须传播，不能吞成记忆空结果。

召回完成的状态和其 V2 事实通过现有 transition/outbox 保存；必要的记忆关闭或失败状态也要保存。已成功准备的状态经 compressor round-trip 不丢失。不得改变已有 V1 Generator yield、V2 侧路顺序或 final return 类型。

Renderer 在 `reasonStream` 模型视图边界附加一条有界、临时 user-text 数据消息。ID 由已保存的 selection 内容 digest 确定；不写入 messages 历史、不使用动态 system、不进入 trustedSystemContext。文本明确标注“历史案例，非本轮事实；只能形成待验证假设；不能减少必需取证或授权动作”。

历史 evidenceIds 保存在 hints 的 historical references，不能并入当前 `context.evidenceIds` 或伪造本轮 EVIDENCE_COLLECTED。记忆不添加任意 Bash/HTTP Tool，不绕过 admission/Guard/Hook/HITL，系统没有记忆驱动的自动写动作。

这是一道数据/权限边界，不是“提示词能保证模型不会偏见或幻觉”的声明。自然语言诊断仍需本轮证据核验和人工质量评估。

## 8. 安全、事件与前端

### 8.1 安全与事件

先按结构白名单选诊断段落、来源 ID、症状 code 和引用，再做文本脱敏、长度校验、digest，最后才允许落库/分词/渲染。禁止原始日志、Tool inputs、Authorization、Cookie、密钥、客户标识、内部地址、完整 prompt 进入记忆。敏感片段整段移除/替换；不能只靠一条正则。无法安全保留的文本令生成 Job 失败，不落库不安全候选；可安全归档的失败调查 quality=failed，不能审核通过。

需要单独的注入/泄漏 corpus 测试；脱敏不构成对任意自然语言 PII 的完整保证。生产扩大范围前要评审 Profile 白名单与数据分类。

现有 V2 类型和 visibility 不变：

| 事件 | 发布位置与内容 |
|---|---|
| MEMORY_RETRIEVAL_STARTED/COMPLETED/FAILED | 首次查询/复核；仅范围标识、ID、数量、耗时、固定安全错误码 |
| MEMORY_UPDATE_SCHEDULED | 自动终态事务或手动命令事务首次登记 Job；sourceRunId，无诊断全文 |
| MEMORY_UPDATE_COMPLETED/FAILED | 生成或审核结果，status/eligibility 或安全失败对象 |
| EXPERIENCE_CANDIDATE_CREATED | 候选事务；ID、证据 ID、qualityStatus |
| EXPERIENCE_REVIEWED | 审核事务；ID、decision、宿主 actor 标识 |

以上继续属于 audit，不能为了前端展示改成 public。检索事件 filters 不含用户全文、端点或原始证据。失败使用现有 ErrorPayload code（STORAGE_ERROR/TIMEOUT/UNAVAILABLE）及 details.category=MemoryErrorCode，不修改公开枚举。LangSmith 仅保留允许的元数据，独立安全测试验证。

### 8.2 本地 API

新增 opt-in 显式接口，所有接口复用现有 Host/Origin、JSON body 大小与 DTO 校验；不得把审核动作发成事件命令。

- `GET /memory/capabilities?profileId=...`：MemoryCapabilities；服务关闭返回 enabled=false、manualCapture/automaticCapture/recall=false，不暴露范围配置全文。服务可用但 recall=false 不隐藏保存/审核入口。
- `GET /memory/cases?profileId=...&status=...&afterId=...&limit=...`：宿主按 profileId 映射允许的完整 scope，20 条默认、50 条上限；返回有界案例 DTO。
- `GET /memory/cases/:id?profileId=...`：宿主范围内的摘要、来源、证据引用、审核状态；越界与不存在统一 404。
- `GET /runs/:runId/memory`：该 Run 的 active hints、选择状态、availability 与固定原因；不返回完整 Checkpoint。
- `GET /runs/:runId/memory/capture`：MemoryCaptureTicket，包含经授权的源 Checkpoint revision 和最新 Job 状态，不返回完整源状态；源不存在/越界统一 404。
- `POST /runs/:runId/memory/capture`：只接收 requestId、expectedCheckpointRevision；宿主由已有控制快照取 scope、固定 local-operator 和当前时间。首次入队 202，重放/已有案例 200；body 不能补 report/quality/actor/scope。400 格式或策略无效，404 越界/不存在，409 源 CAS 或 requestId 冲突，422 非终态/旧 Run 无可信范围/子 Run，503 服务关闭/容量不可用。不启动另一个诊断 Run。
- `POST /memory/cases/:id/review`：只接收 profileId、requestId、expectedRevision、decision、claimCheck；scope/actor/time 由宿主生成。400 无效输入，404 越界，409 CAS/幂等冲突，422 不满足批准条件；关闭时 503 MEMORY_DISABLED。

现有创建 Run 接口增量接受 memoryPreferences，字段缺省按 Profile 策略；其他信任字段仍禁止。不改变旧字段语义。设置只控制该次 Run，不提供无认证的“修改服务器配置”接口。

一期没有远程多人审批。生产开放前必须补认证、授权、CSRF/部署安全和数据权限设计；不能直接把本地操作员接口监听到公网。

### 8.3 UI

巡检前端增加独立 MemoryPanel，不另起第三套应用。发起 Run 时分开显示“本次沉淀：手动/自动/不自动沉淀”和“使用已审核历史参考”，由 capabilities 限定可选值。Run 结束后提供“沉淀本次巡检”，展示“未保存/排队中/生成中/已保存候选/生成失败”。服务不可用时禁用交互并说明管理员需一次性启用，不让用户每次修改环境变量；recall=false 时保存、列表与审核仍可用。

案例显示来源 Run、sourceRunStatus、摘要、证据引用、质量、有效期和批准/拒绝；failed/cancelled 显示“失败调查，仅供归档，不可批准召回”。模拟记录持续显示“仅模拟环境可用，不可晋级”。证据点击沿用摘要/引用页面，`retrievable=false` 的公共边界不变。

observation 默认不参与召回；低质量案例批准按钮禁用，后端仍做同样校验。已批准可撤销；操作提交 revision/requestId，重复点击不重复审核。新的 Run 面板可显示召回为空、撤销移除、服务暂不可用，不把空结果渲染成系统失败。

页面走明确的查询/捕获/审核接口；不扩大 SSE/Audit 可见范围。requestId 在一次用户操作内保持稳定，保存后刷新最新 ticket；弱网、重复点击、刷新和重启不产生第二份候选。服务关闭时旧巡检功能保持可用，新增控件显示禁用原因；没有召回不渲染历史提示。

## 9. 兼容性和迁移决策

- MemoryFacade/Event/Message/ToolResponse 原有契约不改；本期不新增 MessageBlock。
- AgentContext.memoryControl/memory 和 ReplyOptions.trustedMemoryControl/memoryPreferences 为可选项；缺省且没有合法部署配置时保持原行为。R2 修订的是未发布草案，不需要迁移初稿中尚未落地的 trustedMemoryScope。
- Checkpoint 新写 Schema 3；读 v1/v2 先按原始存储数据校验 checksum，再按各版本 codec 迁移。旧状态不自动补 scope 或作召回；旧字段不丢失，首次合法保存才升级。
- 关闭功能不等于数据库回滚。已迁移 DB 需新版本程序读取；回退二进制应使用升级前备份，不能删除记忆表或降低 user_version 冒充迁移成功。
- 原型 MemoryFacade 无正式持久化数据，不自动批量导入宽松 observation。
- 实际分支锁定 Node.js 24、pnpm 11.19.0；用户早期工作目录规则仍记录 Node 20。本文不修改工具链，执行计划沿用本分支基线；如要恢复 Node 20，另行决策和 native-module 兼容验证。

## 10. 验收与依赖顺序

阶段 A 顺序：契约/Checkpoint → SQLite/信号/命令/Job → 候选生成与手动捕获 → 审核 → BM25 召回 → Harness 控制快照 → Bootstrap/API → UI → 联合回归。逐文件计划见 [实施计划](../plans/2026-10-10-governed-diagnostic-memory.md)。阶段 B 按独立向量实验计划执行，阶段 A 基础联验不以向量/模型下载/外部 Embedding 通过为前提。

必须通过：

1. 两种 Store 运行同一组范围、状态、CAS、幂等与排序契约测试；v4 DB 升级和旧 Checkpoint 重启读取。
2. 工具信号/终态 Job/候选/审核分别做事务故障注入：回滚不留半记录；重放不重复，lease 过期的旧 Worker 不能提交。
3. completed 与缺证/failed/cancelled 质量分离；失败调查手动可归档但永不可批准，paused/子 Run 不捕获；无模拟标签污染。
4. Profile、revision、环境、target、dataset、sourceRun 的负向隔离全部通过；中文、英文与 FTS 操作符输入有确定性测试。
5. 第二个 Run 只召回人工 approved 同范围记录；撤销/过期/删除证据后下一轮或恢复移除提示；无历史引用混入本轮证据。
6. 查询失败空降级、Abort 传播，记忆不重置主预算、不增加模型调用、不改变动作授权或 AsyncGenerator 事件契约。
7. 前端手动沉淀、automatic/skip、召回关闭仍可保存、批准/拒绝/撤销、冲突、引用导航和重启展示通过；接口不接收可信 scope/actor，public SSE 不漏内容。
8. 独立模拟记忆联验和现有无记忆烟测契约均通过；验收报告区分“功能正确”“检索 fixture 排序”“诊断效果尚待真实数据评估”。

9. capture/recall 的独立矩阵（manual/automatic/skip × false/true）全部验证；自动与手动并发、requestId 重放、容量/生成失败、源 revision/checksum 改变、服务重启均不重复案例，手动命令不改变源 Run。
10. 四类范围标签准确：阶段 A 完成不得宣称 Semantic 知识库、Procedural 模板库或阶段 B 已通过。阶段 B 必须实际落库/重开/检索/降级，并区分真实向量可用性与语义质量数据是否已提供。

本轮只修订设计，不触发付费请求，也不把未来向量搜索性能或诊断改善写成已验证结论。
