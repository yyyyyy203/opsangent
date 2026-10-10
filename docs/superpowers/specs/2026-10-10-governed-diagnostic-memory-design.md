# 受控诊断记忆一期设计 Spec

日期：2026-10-10。状态：待实施；本文不代表代码已具备这些能力。

## 1. 目标、依据和当前事实

目标：在现有只读巡检链路上形成“保存历史案例 → 人工审核 → 按范围召回 → 下次调查参考”的闭环，且可替换实现、可重启、可审计，不增加记忆专用模型调用。

参考用户提供的 `2026-01-12-memory-system-design-v2.md` 中的四类记忆、分层接口、质量管理和混合检索思想；采用 clean-room 实现，不复制其他项目代码。其向量模型资源、耗时、准确率和工期估计不作为本项目承诺。

本次代码核验结果：

| 位置 | 已有事实 | 本期衔接方式 |
|---|---|---|
| `src/contracts/memory.ts` | `MemoryFacade` 已发布，查询缺少强制环境/来源隔离 | 原接口保留，新增严格的小接口；不让旧宽松查询访问正式案例库 |
| `src/memory/in-memory-memory.ts` | 内存原型，未接入 runtime；不是完整生产记忆 | 保留兼容，新增独立实现和契约测试 |
| `src/hooks/diagnosis-memory-hook.ts` | 已产生有界 `memory_signal` | 仅在开启记忆的父 Run 内事务落库，不在 Hook 中查询或修改长期记忆 |
| SQLite `DurableTransitionUnitOfWork.commit` | 接口接收 `governanceEffects`，具体实现未保存记忆信号 | 补信号持久化；不顺手重构其他 Hook effect |
| `src/contracts/event-v2/subsystem.ts` | 已有记忆检索、更新、候选和审核事件 | 保留类型及字段，补发布点与安全投影测试 |
| `src/contracts/context.ts` / `src/storage/durable-codec.ts` | 无结构化记忆状态；Checkpoint codec 为严格校验 | 增加可选状态，明确 Schema 3 和旧数据读取策略 |
| SQLite migrations | 当前版本 4，无记忆表，也没有 `runs` 表 | 追加迁移，不给不存在的 `runs(id)` 建外键 |
| Harness / Web bootstrap | 已有权威主循环、模型视图、显式查询与本地前端入口 | 构造器注入；不另建主循环、不把事件当命令 |

本机已用当前分支的 Node 和 `better-sqlite3` 在内存库验证 FTS5 建表及中文 token 查询可用。这只证明本机能力，不等于其他部署环境通过预检。

## 2. 本期范围和非目标

| 记忆 | 一期处理 | 不做的扩展 |
|---|---|---|
| Working | 继续以现有 AgentContext/Checkpoint 为唯一运行事实，补召回快照 | 不再建第二份工作状态库 |
| Episodic | 有界案例、证据引用、质量状态、人工审核、撤销、召回 | 不自动判定根因正确或业务恢复 |
| Semantic | 继续使用受控 Profile 中的规则、指标定义和 Runbook | 不自动从日志学习规则，不建全文知识库导入系统 |
| Procedural | 保留既有候选接口及晋级约束 | 不自动生成/执行经验模板，不启用 Triage 跳过取证快路径 |

一期检索采用 FTS5/BM25 与中文 bigram 预分词；不引入 sqlite-vss、Transformers.js、Embedding 服务或额外模型。向量、RRF、跨 Profile 泛化、经验模板蒸馏各自需要评测与独立设计，不能作为本期验收的隐藏依赖。

全部功能默认关闭。现有真实模型烟测和评测入口显式关闭记忆；记忆验收用独立 SQLite、模拟数据、ScriptedModel，不访问 DeepSeek、LangSmith 或真实业务系统。

## 3. 依赖与组装

```text
bootstrap/diagnostic-memory
  ├─ SQLite / InMemory 存储实现
  ├─ MemoryCaptureWorker / MemoryReviewService
  └─ BoundedMemoryRecall / MemoryHintRenderer
       └─ 注入 AgentHarness 的 Pre-reasoning 和模型视图边界

完成的父 Run ─事务─> Capture Job ─显式 Worker─> observation
                                               ↓ 人工审核
下一次同范围 Run <─有界模型视图─ Recall <──────── approved
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
  capabilities(): { enabled: boolean; kind: 'episodic'; reviewMode: 'local_operator' };
  list(profileId: string, input: { status?: MemoryStatus; afterId?: string;
    limit: number }): Promise<readonly DiagnosticMemoryCase[]>;
  get(profileId: string, id: string): Promise<DiagnosticMemoryCase | null>;
  getRun(runId: string): Promise<RunMemoryState | null>;
}
export interface DiagnosticMemoryRuntime {
  requiredSources: readonly HistoricalEvidenceRef['source'][];
  modelWindowTokens: number;
  reservedOutputTokens: number;
  recall: MemoryRecallPort;
  renderer: MemoryHintRenderer;
  worker: MemoryCaptureWorkerPort;
  reviews: MemoryReviewPort;
  queries: MemoryReadServicePort;
  close(): Promise<void>;
}
```

Implementation Plan 中会给出 Worker、审核、召回、Schema 与 renderer 的准确入口。`MemoryQueryStore.revalidate` 同时检查范围、版本、摘要 digest、审核状态、有效期；证据有效性由审核与召回注入的显式只读接口复核，不能只信任记录中的布尔值。

### 4.1 范围来源

- `MemoryScope` 由宿主根据明确的 Profile 与数据源配置构造；HTTP 用户消息、LLM 参数不能指定可信范围、状态或审核者。
- 实际 Target 标识用宿主的非敏感资源 ID 生成 fingerprint；不得把 MCP URL、内部地址或凭据当成可显示字段。
- `profileRevision` 取明确的 Profile revision/digest，不把当前 Web 的 Profile 名称冒充版本。缺少明确配置则记忆关闭/返回空，不从自由文本猜服务或故障类型。
- 所有搜索精确匹配 Profile、revision、服务、故障、环境、数据来源和 targetFingerprint；模拟来源还必须匹配 datasetId。
- 当前无多租户认证。一期仅支持本地单操作员；未来 tenantId、登录授权需要独立契约升级，不宣称现有隔离就是租户安全。

### 4.2 模拟记忆与质量

模拟案例可人工审核为 `approved`，仅在同一模拟范围召回；`eligibleForPromotion` 永远为 false。不能修改 environment 把模拟记录变成真实经验。

Worker 只能使用已持久化的 Run 状态、实际诊断文本和有界证据元数据；禁止读取模拟器 oracle/rootCause、评测 expectedOutcome 或标签文件。评测库和日常试验库分离，当前 Run 永远列入 excludeRunIds。

`quality=sufficient` 只表示该 Profile 定义的必需取证完整、关联和哈希有效，不表示根因已经验证。非必需数据源缺失保留在 limitations；必需证据 partial、窗口不正确、引用不属于父/子 Run 或 required completeness 无法确定时均为 insufficient/failed。人工批准仍需 `claimCheck=supported`，缺证记录不能靠人工勾选强行晋级。

一期始终 `diagnosisOnly=true`：只读诊断完成不是“问题已解决”；真实恢复和动作有效性不能从当前报告自动生成。

## 5. 存储、事务与恢复

### 5.1 迁移

在当前 SQLite v4 后追加 v5；如实施前已有新的 migration，顺延为下一版本，不修改已发布迁移。新增：

| 表 | 关键约束 |
|---|---|
| `diagnostic_memory_cases` | id PK；scope_key、各范围列、source_run_id、revision、status、quality、valid_until、bounded case_json；UNIQUE(source_run_id, extractor_version) |
| `diagnostic_memory_case_fts` | FTS5 tokens + memory_id UNINDEXED；unicode61；只索引审核有效的文本，事务同步更新 |
| `diagnostic_memory_reviews` | request_id PK；memory_id FK 到实际 cases；actor、decision、claim_check、expected_revision、command_digest、有界原结果 JSON、结果 revision、时间 |
| `diagnostic_memory_capture_jobs` | candidate_id PK；UNIQUE(source_run_id, extractor_version)；pending/running/completed/failed/skipped、attempt、owner、lease_until、request_json、terminal_failure_event_json |
| `diagnostic_memory_signals` | 唯一 signal_key；run_id、tool_call_id、phase、observed_at、bounded signal_json |

scope_key 使用固定规范化序列化的完整范围，而非 JSON 属性顺序。FTS、信号和 Job 的索引版本分别记入内容/元数据，不以“不报错”冒充完成重建。

共用 `SqlitePersistenceBundle` 的数据库和 WAL，不打开第二个隐藏数据库连接。外键只引用已有 memory 表；Run/证据所有权用实际 Checkpoint 与 InspectionQueryService 验证。InMemory 存储实现同一语义用于单元测试，不声称重启持久化。

FTS5 是 v5 迁移的数据库能力要求，升级前预检；不可用则迁移不开始并保留原库。功能关闭不需要模型文件，但不承诺能在缺少 FTS5 的 SQLite 上读取已升级库。

### 5.2 原子边界

扩展 `DurableTransitionUnitOfWork.commit` 的可选 `memoryCapture?: MemoryCaptureIntent`。

1. 工具结果：现有 Checkpoint、Execution Journal、Outbox 与开启记忆父 Run 的 `memory_signal` 在同一事务提交。信号唯一键由 runId/toolCallId/phase/outcome/observedAt 规范化得到，重放不重复。
2. 完成父 Run：`RUN_FINISHED` 对应的终态事务同时登记 Capture Job 与 `MEMORY_UPDATE_SCHEDULED`。仅当第一次登记成功才记录 schedule；队列饱和写 rejectedEvent，主诊断仍正常完成。
3. Worker：候选记录、FTS、Job completed 和候选更新事件同事务提交；崩溃前/后都不能产生两份候选。
4. 审核：CAS 状态、revision、索引、review 记录和审核 Outbox 同事务提交。不得 save 后另行 fire-and-forget 发布。

intent 的 rejectedEvent 用于容量拒绝，failedEvent 是预分配 eventId 的生成失败模板，入队时保存、到限恢复时使用；二者固定 category 不同，不拿容量错误冒充生成失败。

原有 SQLite/Checkpoint 本身写失败仍遵循现有失败/uncertain 规则，不能承诺共享数据库损坏时“记忆完全不影响主流程”。只有可选查询、生成和索引服务失败降级为空参考；不得无条件重放任何外部动作。

### 5.3 Worker 和资源上限

- Worker 是显式应用服务，不是第二个 Agent 或 Hook 内的 ReAct。启动恢复和父 Run 完成后的宿主回调可调用 `drain`；无隐式 cron、无限后台循环或模型调用。
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

证据有效性读取现有受控元数据、归属关系、Manifest 状态/保留期限和记录哈希；retrievable=false 是公共页面不提供原文的设计，不是证据不存在，不能因该字段拒绝所有案例。无需为了审核对大 Blob 全量重算哈希或开放原文 HTTP 接口；内部引用记录不存在/过期/损坏才判不可用。

每次新审核 revision +1；`expectedRevision` 冲突返回 409。相同 requestId + 相同规范化命令返回存入 review 的原结果、不发第二份事件；同 requestId 不同命令返回 409。命令 digest 包含案例 ID、完整 scope、expectedRevision、decision、claimCheck 和 actorId，不包含宿主每次新生成的 reviewedAt。服务先通过 findReviewResult 校验重放，再检查新请求的当前状态/证据；原结果不代表最新状态，UI 操作完成后刷新当前案例。actorId 来自宿主授权上下文，本地为固定 `local-operator`；HTTP body 不接受 actorId。审批只认可当前白名单 memory scope，与 ToolCall 的 HITL 授权完全无关。

Review 服务产生现有 `EXPERIENCE_REVIEWED` 与 `MEMORY_UPDATE_COMPLETED`，前者记录诊断经验候选的人工审核，后者记录案例状态；不表示已经产生 Procedural 模板。模拟数据 eligibility 仍为 not_eligible。

## 7. 召回与模型视图

### 7.1 确定性搜索

顺序：严格范围 → approved/sufficient/有效期/排除 sourceRun → 文本匹配与 BM25 → 稳定排序 → Top-K → 证据复核 → 预算裁剪。SQL 必须在同一次候选查询的 WHERE 中做范围过滤，不能全库 Top-K 后过滤。

FTS 语料内的词频统计可以用于评分，但任何候选返回必须已满足 scope；不返回跨范围文档、全局统计或匹配片段。

中文按 Unicode 字符生成相邻 bigram，英文/标识符正规化为小写 token；不把中文切分寄托给 porter 或空格。输入最多 1 KiB、64 token，逐 token 加引号并绑定为 MATCH 参数，禁止用户直接传 FTS 操作符或 SQL。空/无有效 token 输入返回空。

FTS5 `bm25` 分数越小排名越靠前；同分按 capturedAt 降序、id 升序。模拟/评测 fixture 的期待排序是确定性测试结果，不保证真实诊断准确率。未来混合召回需保留此端口和范围前置约束。

默认 limit=5、硬上限 10；渲染最多 5 条，尾部总计不超过 4 KiB 且不超过 1024 token 的注入预算。无 tokenizer 时用 UTF-8 字节数作为保守 token 上界；超过父 Run 剩余时间或窗口预算直接返回空，不占用取证/输出保留预算。

宿主开启配置必须给出 modelWindowTokens 与 reservedOutputTokens，均为正整数且后者小于前者；它们是宿主确认的模型能力，不从模型名猜。Harness 在现有 compressor 之后根据最终基础消息、system 和 tools 的保守 token 估计计算剩余量，向 Renderer 传 availableMemoryTokens。最终允许量是 min(1024, 剩余窗口扣除输出保留量)；未知剩余量按 0 处理。召回快照可以存在，但没有渲染空间时不注入文本。

### 7.2 接入 Harness

新增可选 `AgentContext.memory?: RunMemoryState` 和宿主专用 `ReplyOptions.trustedMemoryScope?: MemoryScope`。HTTP parser 不接受这两项。

在现有 Pre-reasoning 内、reasonStream 前做记忆准备及治理，不改变主循环阶段顺序。第一次选择后冻结 IDs/revision/digest，持久化在 Checkpoint；后续轮次及 resume 只复核这组选择，不重新扩大查询。

已撤销、已过期、修改版本或证据不存在的提示被移除。复核失败清空本次 active hints，标记 unavailable；保存原 selections 供同 revision 的下一次复核。初次查询失败只尝试一次，不每轮反复全库查询。真正 Abort 必须传播，不能吞成记忆空结果。

召回完成的状态和其 V2 事实通过现有 transition/outbox 保存；必要的记忆关闭或失败状态也要保存。已成功准备的状态经 compressor round-trip 不丢失。不得改变已有 V1 Generator yield、V2 侧路顺序或 final return 类型。

Renderer 在 `reasonStream` 模型视图边界附加一条有界、临时 user-text 数据消息。ID 由已保存的 selection 内容 digest 确定；不写入 messages 历史、不使用动态 system、不进入 trustedSystemContext。文本明确标注“历史案例，非本轮事实；只能形成待验证假设；不能减少必需取证或授权动作”。

历史 evidenceIds 保存在 hints 的 historical references，不能并入当前 `context.evidenceIds` 或伪造本轮 EVIDENCE_COLLECTED。记忆不添加任意 Bash/HTTP Tool，不绕过 admission/Guard/Hook/HITL，系统没有记忆驱动的自动写动作。

这是一道数据/权限边界，不是“提示词能保证模型不会偏见或幻觉”的声明。自然语言诊断仍需本轮证据核验和人工质量评估。

## 8. 安全、事件与前端

### 8.1 安全与事件

先按结构白名单选诊断段落、来源 ID、症状 code 和引用，再做文本脱敏、长度校验、digest，最后才允许落库/分词/渲染。禁止原始日志、Tool inputs、Authorization、Cookie、密钥、客户标识、内部地址、完整 prompt 进入记忆。敏感片段整段移除/替换；不能只靠一条正则。无法安全保留的案例 quality=failed，不能审核通过。

需要单独的注入/泄漏 corpus 测试；脱敏不构成对任意自然语言 PII 的完整保证。生产扩大范围前要评审 Profile 白名单与数据分类。

现有 V2 类型和 visibility 不变：

| 事件 | 发布位置与内容 |
|---|---|
| MEMORY_RETRIEVAL_STARTED/COMPLETED/FAILED | 首次查询/复核；仅范围标识、ID、数量、耗时、固定安全错误码 |
| MEMORY_UPDATE_SCHEDULED | 终态事务登记 Job；sourceRunId，无诊断全文 |
| MEMORY_UPDATE_COMPLETED/FAILED | 生成或审核结果，status/eligibility 或安全失败对象 |
| EXPERIENCE_CANDIDATE_CREATED | 候选事务；ID、证据 ID、qualityStatus |
| EXPERIENCE_REVIEWED | 审核事务；ID、decision、宿主 actor 标识 |

以上继续属于 audit，不能为了前端展示改成 public。检索事件 filters 不含用户全文、端点或原始证据。失败使用现有 ErrorPayload code（STORAGE_ERROR/TIMEOUT/UNAVAILABLE）及 details.category=MemoryErrorCode，不修改公开枚举。LangSmith 仅保留允许的元数据，独立安全测试验证。

### 8.2 本地 API

新增 opt-in 显式接口，所有接口复用现有 Host/Origin、JSON body 大小与 DTO 校验；不得把审核动作发成事件命令。

- `GET /memory/capabilities`：enabled、kind=episodic、reviewMode=local_operator；关闭时返回 enabled=false，不暴露范围配置全文。
- `GET /memory/cases?profileId=...&status=...&afterId=...&limit=...`：宿主按 profileId 映射允许的完整 scope，20 条默认、50 条上限；返回有界案例 DTO。
- `GET /memory/cases/:id?profileId=...`：宿主范围内的摘要、来源、证据引用、审核状态；越界与不存在统一 404。
- `GET /runs/:runId/memory`：该 Run 的 active hints、选择状态、availability 与固定原因；不返回完整 Checkpoint。
- `POST /memory/cases/:id/review`：只接收 profileId、requestId、expectedRevision、decision、claimCheck；scope/actor/time 由宿主生成。400 无效输入，404 越界，409 CAS/幂等冲突，422 不满足批准条件；关闭时 503 MEMORY_DISABLED。

一期没有远程多人审批。生产开放前必须补认证、授权、CSRF/部署安全和数据权限设计；不能直接把本地操作员接口监听到公网。

### 8.3 UI

巡检前端增加独立 MemoryPanel，不另起第三套应用。显示“历史参考”、来源 Run、时间、摘要、证据引用、质量、有效期和批准/拒绝。模拟记录持续显示“仅模拟环境可用，不可晋级”。证据点击沿用摘要/引用页面，`retrievable=false` 的公共边界不变。

observation 默认不参与召回；低质量案例批准按钮禁用，后端仍做同样校验。已批准可撤销；操作提交 revision/requestId，重复点击不重复审核。新的 Run 面板可显示召回为空、撤销移除、服务暂不可用，不把空结果渲染成系统失败。

页面走明确的查询/审核接口；不扩大 SSE/Audit 可见范围。关闭记忆时保持旧页面行为。

## 9. 兼容性和迁移决策

- MemoryFacade/Event/Message/ToolResponse 原有契约不改；本期不新增 MessageBlock。
- AgentContext.memory 和 ReplyOptions.trustedMemoryScope 为可选项；缺省保持原行为。
- Checkpoint 新写 Schema 3；读 v1/v2 先按原始存储数据校验 checksum，再按各版本 codec 迁移。旧状态不自动补 scope 或作召回；旧字段不丢失，首次合法保存才升级。
- 关闭功能不等于数据库回滚。已迁移 DB 需新版本程序读取；回退二进制应使用升级前备份，不能删除记忆表或降低 user_version 冒充迁移成功。
- 原型 MemoryFacade 无正式持久化数据，不自动批量导入宽松 observation。
- 实际分支锁定 Node.js 24、pnpm 11.19.0；用户早期工作目录规则仍记录 Node 20。本文不修改工具链，执行计划沿用本分支基线；如要恢复 Node 20，另行决策和 native-module 兼容验证。

## 10. 验收与依赖顺序

顺序：契约/Checkpoint → SQLite/信号/Job → 候选生成 → 审核 → 召回 → Harness → Bootstrap/API → UI → 联合回归。逐文件计划见 [实施计划](../plans/2026-10-10-governed-diagnostic-memory.md)。

必须通过：

1. 两种 Store 运行同一组范围、状态、CAS、幂等与排序契约测试；v4 DB 升级和旧 Checkpoint 重启读取。
2. 工具信号/终态 Job/候选/审核分别做事务故障注入：回滚不留半记录；重放不重复，lease 过期的旧 Worker 不能提交。
3. 正常案例和缺证案例质量分离；failed/cancelled/paused、子 Run 不产生可批准正向案例；无模拟标签污染。
4. Profile、revision、环境、target、dataset、sourceRun 的负向隔离全部通过；中文、英文与 FTS 操作符输入有确定性测试。
5. 第二个 Run 只召回人工 approved 同范围记录；撤销/过期/删除证据后下一轮或恢复移除提示；无历史引用混入本轮证据。
6. 查询失败空降级、Abort 传播，记忆不重置主预算、不增加模型调用、不改变动作授权或 AsyncGenerator 事件契约。
7. 前端批准、拒绝、撤销、冲突、引用导航和重启展示通过；接口不接收可信 scope/actor，public SSE 不漏内容。
8. 独立模拟记忆联验和现有无记忆烟测契约均通过；验收报告区分“功能正确”“检索 fixture 排序”“诊断效果尚待真实数据评估”。

本轮只设计，不触发付费请求，也不把未来向量搜索性能或诊断改善写成已验证结论。
