# ELK 大体量证据流式摄取与 BlobStore 设计

> 状态：2026-09-10 已由项目负责人确认，尚未实施。本文是 [Durable Run State & Evidence V1](./2026-09-10-durable-run-state-evidence-design.md) 的大证据扩展设计。代码和验收完成前，不得宣称系统已经支持几十 MiB ELK 日志的持久化、恢复或审计回放。

## 1. 问题与决策

ELK 一次调查可能命中数万条日志，原始结果达到几十 MiB。此类数据不得作为一个对象整体放入 SQLite `raw_json`、MCP ToolResult、Agent Message、公共 Event、SSE 或 LangSmith，也不得在进程内一次性拼接为完整字符串。

采用两级证据存储：

- SQLite 是控制面，保存证据身份、摘要、状态、游标、大小、哈希和 Blob Manifest。
- `EvidenceBlobStore` 是数据面，以流式、分块、压缩方式保存大体量原文。
- Agent、Subagent 和模型只消费有界的 `EvidenceSummary` 与 `evidenceId`；需要细节时通过受控查询 Tool 分页读取。

第一实现可使用本地文件 BlobStore；生产环境可替换为 OSS、S3 或 MinIO。存储实现由 bootstrap 注入，不改变 Harness、Tool 和公共事件契约。

## 2. 当前代码约束

- 当前 `EvidenceRecord.raw: unknown` 和 `EvidenceStore.save/get` 只适合有界的小型证据，默认实现仍为内存存储。
- 已确认的第一持久化增量只允许把不超过 1 MiB 的指标原文内联到 SQLite。
- 当前 MCP HTTP 响应流默认上限为 1 MiB，因此 ELK MCP 不得用一次 Tool 调用返回几十 MiB 日志。
- `EVIDENCE_COLLECTED`、`evidence_ref` 和 ToolResult 已能表达“证据已提交并可回查”，无需为了大对象扩展公共 Event/Message 字段。
- LangSmith 是 Agent 执行链路的可观测投影，不是原始业务日志仓库。

这意味着 ELK 接入必须同时解决数据源分页、流式落盘、有界摘要、恢复游标和受控二次读取，不能只给现有 `EvidenceStore` 增加一个更大的 size limit。

## 3. 方案比较

### 方案 A：原文全部写入 SQLite BLOB/JSON

实现最少，但会造成 WAL 写放大、长事务、备份膨胀和读取时的内存峰值。几十 MiB 单条记录还会把控制状态与大对象生命周期绑死，不采用。

### 方案 B：只保存 ELK 查询条件和远端文档 ID

本地很轻，但 ELK 数据受保留期、滚动索引和后续修改影响，无法保证审计时仍能复现当时证据。可以作为来源引用，但不能成为唯一证据，不采用。

### 方案 C：SQLite Manifest + 可替换 BlobStore

SQLite 保存可查询元数据和状态，BlobStore 保存不可直接进入模型的大对象；两者通过提交协议和哈希形成可恢复引用。该方案兼顾本地验证、生产扩展与审计，采用。

## 4. 组件边界

```text
ELK
  -> PIT/search_after 分页
  -> ElkEvidenceSource（每页有界）
  -> StreamingEvidenceRecorder
       -> Redactor / Normalizer
       -> DeterministicLogAggregator
       -> EvidenceBlobWriter（分块压缩、背压）
       -> EvidenceManifestStore（SQLite）
  -> EvidenceCaptureResult
  -> Logs Subagent
  -> 主 Agent：EvidenceSummary + evidence_ref
```

职责必须保持分离：

- `ElkEvidenceSource`：只负责 ELK 查询、分页和来源错误规范化。
- `StreamingEvidenceRecorder`：负责摄取事务、预算、摘要和提交顺序。
- `EvidenceBlobStore`：只负责 Blob 分块写入、读取和删除，不了解 Agent。
- `EvidenceManifestStore`：只保存 Manifest、页游标和提交状态。
- `EvidenceReader`：提供有界分页/切片读取，不暴露本地路径和任意文件读取。
- Logs Subagent：决定查询顺序并收敛诊断摘要，不自行实现存储。

Harness 不得直接依赖 ELK SDK、文件系统、压缩库或 BlobStore。

## 5. 内部契约

现有 `EvidenceRecord` 和 `EvidenceStore` 在兼容期保留，继续服务小型内联证据。大证据使用独立应用端口，避免改变 `raw` 已发布语义：

```ts
export interface StreamingEvidenceCaptureRequest {
  evidenceId: string;
  runId: string;
  stepId: string;
  toolCallId: string;
  captureKey: string;
  source: 'log' | 'trace';
  queryDigest: string;
  timeRange: { start: string; end: string };
  pages: AsyncIterable<EvidenceSourcePage>;
  budget: EvidenceCaptureBudget;
}

export interface StreamingEvidenceRecorder {
  capture(
    request: StreamingEvidenceCaptureRequest,
    options?: { signal?: AbortSignal },
  ): Promise<EvidenceCaptureResult>;
}

export interface EvidenceCaptureResult {
  evidenceId: string;
  summary: EvidenceSummary;
  manifest: EvidenceManifestSummary;
  coverage: number;
  truncated: boolean;
  missingEvidence: string[];
}
```

来源分页是有界结构，不允许把全部命中结果藏进一个 page：

```ts
export interface EvidenceSourcePage {
  records: readonly NormalizedLogRecord[];
  encodedBytes: number;
  nextCursor?: string;
  sourceSnapshotId?: string;
}

export interface EvidenceCaptureBudget {
  maxSourceBytes: number;
  maxRecords: number;
  maxDurationMs: number;
  maxModelSummaryBytes: number;
  maxSamples: number;
}
```

BlobStore 采用 writer，而不是 `put(buffer)`，以保证背压和 Abort：

```ts
export interface EvidenceBlobStore {
  begin(input: BeginEvidenceBlobInput): Promise<EvidenceBlobWriter>;
  readChunk(ref: EvidenceChunkRef): AsyncIterable<Uint8Array>;
  delete(ref: EvidenceBlobDescriptor): Promise<void>;
}

export interface EvidenceBlobWriter {
  write(chunk: Uint8Array, options?: { signal?: AbortSignal }): Promise<void>;
  commit(): Promise<EvidenceBlobDescriptor>;
  abort(reasonCode: string): Promise<void>;
}
```

第一版本使用独立 gzip NDJSON chunk；每个 chunk 都有独立哈希和对象键，避免为了读取少量日志解压整个大文件。未来可新增 zstd 实现，但不能改变上层端口。

## 6. 摄取与提交协议

固定执行顺序：

```text
1. 校验查询范围、来源、预算和 captureKey
2. SQLite 创建 pending Manifest
3. 逐页拉取 ELK；每页不超过来源适配器上限
4. 对记录做规范化、脱敏和确定性聚合
5. 以 NDJSON 编码并写入有界 chunk
6. 每个 chunk：临时写入 -> 关闭 -> SHA-256 校验 -> 原子发布
7. SQLite 记录已提交 chunk、累计计数和恢复游标
8. 达到结束或预算后提交 Manifest
9. 回读并校验 Manifest 后发布 EVIDENCE_COLLECTED
10. ToolResult 只返回摘要、evidenceId、coverage 和 missingEvidence
```

任何时候内存里最多保留一个来源页、一个编码 chunk 和有界聚合状态。writer 必须等待 BlobStore 完成当前写入后才拉取下一页，形成自然背压；不得用无界 `Promise.all` 预取全部页。

SQLite 与本地文件无法形成真正的跨资源事务，因此采用可恢复提交协议：

- Manifest 为 `pending` 时，证据不可对 Agent 宣称可用。
- Blob chunk 原子发布后才写入已提交 chunk 记录。
- Manifest 经过完整性校验并标记为 `committed` 或可用的 `partial` 后才能返回 `evidence_ref`；`pending`、`failed` 和 `deleting` 均不可见。
- 启动恢复器检查 pending Manifest、临时文件和孤立 chunk，按哈希继续、标记 partial 或回收。
- 删除采用 tombstone，再异步删除 Blob，最后清理元数据，避免先删元数据造成不可追踪文件。

## 7. SQLite Manifest

大证据实现新增独立迁移，不修改已经发布的历史迁移：

```sql
CREATE TABLE evidence_blob_manifests (
  manifest_id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  capture_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('log', 'trace')),
  query_digest TEXT NOT NULL,
  source_snapshot_id TEXT,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'partial', 'failed', 'deleting')),
  record_count INTEGER NOT NULL DEFAULT 0,
  source_bytes INTEGER NOT NULL DEFAULT 0,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  compression TEXT NOT NULL,
  next_cursor TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  missing_evidence_json TEXT NOT NULL DEFAULT '[]',
  redaction_policy_version TEXT NOT NULL,
  retention_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE TABLE evidence_blob_chunks (
  manifest_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  record_count INTEGER NOT NULL,
  source_bytes INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  first_captured_at TEXT,
  last_captured_at TEXT,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (manifest_id, chunk_index),
  FOREIGN KEY (manifest_id)
    REFERENCES evidence_blob_manifests(manifest_id)
    ON DELETE RESTRICT
);

CREATE INDEX evidence_blob_manifests_run_time
  ON evidence_blob_manifests(run_id, range_start, range_end);
CREATE INDEX evidence_blob_manifests_state_updated
  ON evidence_blob_manifests(state, updated_at);
```

`storage_key` 是 BlobStore 内部键，不是可供模型、前端或普通 Tool 使用的路径。公共查询始终以 `evidenceId` 为入口。

## 8. MCP 与 ELK 分页

当前 MCP HTTP 响应上限保持 1 MiB，不为 ELK 放大。ELK MCP 工具采用游标分页：

- 单次响应目标不超过 512 KiB，为协议包装和错误信息保留余量。
- 使用 PIT + `search_after` 获得稳定排序，禁止深分页 `from + size`。
- 每页返回规范化记录、统计、下一游标和来源快照 ID。
- 游标是受签名或服务端保存的 opaque token，不把凭证、完整 DSL 或内部地址暴露给模型。
- `ElkEvidenceSource` 在 MCP Client 侧把多次有界调用适配为 `AsyncIterable<EvidenceSourcePage>`。

若未来 MCP 服务与 Agent 共享对象存储，可以新增“服务端摄取后返回 Manifest 引用”的适配器，但该引用必须经过本地 Registry 校验，不能接受模型提供的任意 URL。

## 9. Tool 与 Subagent 使用方式

ELK 的普通 Tool 和 Logs Subagent 分工如下：

- `logs.capture`：执行受控查询、流式保存原文、返回摘要和 `evidence_ref`。
- `logs.search_evidence`：在已提交证据内按条件分页检索。
- `logs.aggregate_evidence`：按 level、service、exception signature、traceId 等确定性聚合。
- `logs.read_evidence_slice`：按 opaque cursor 读取少量脱敏样本。
- `logs.get_trace_context`：围绕一个业务 traceId 获取有界上下文。

Logs Subagent 作为高级 Tool 调用这些普通 Tool，多轮收集后只返回 `EvidenceSubagentResult`。主 Agent 不获得原始 Blob，也不感知 BlobStore 类型。

二次读取必须有独立预算；禁止模型通过重复分页绕过一次取证上限。读取 Tool 只能访问 Registry 中已提交、属于当前 Run/Profile 的 evidenceId。

## 10. 默认预算与截断语义

首版建议默认值如下，全部由 Profile/bootstrap 注入：

| 项目 | 默认值 |
|---|---:|
| MCP 单页目标上限 | 512 KiB |
| 本地 Blob chunk 目标 | 4 MiB 未压缩 |
| 单次 capture 原始数据上限 | 64 MiB |
| 单次 capture 记录数上限 | 50,000 |
| 单次 capture 总时限 | 60 秒 |
| 单个 Run 大证据总预算 | 256 MiB |
| 模型可见摘要上限 | 16 KiB |
| 模型可见代表样本 | 20 条，每条最多 2 KiB |
| 并发预取页数 | 1；后续最多提高到有界 2 |

达到字节、记录数、时间或来源限制时，不把 capture 标记为完整成功。只要已有可校验证据，可提交为 `partial`，并返回：

```ts
{
  truncated: true,
  coverage: 0.72,
  missingEvidence: ['ELK_CAPTURE_BYTE_BUDGET_EXCEEDED'],
}
```

`coverage` 必须由已扫描时间桶、分页状态和查询范围确定性计算；不能由 LLM 猜测。证据不足时主诊断只能输出 `partial` 或 `inconclusive`。

## 11. 摘要和上下文治理

大证据在到达模型前立即执行 L0 外置：

- 原文只进入 BlobStore。
- SQLite 保存确定性统计、异常签名 Top-N、时间分布、服务分布和代表样本引用。
- LLM 仅对有界聚合结果和脱敏样本做解释性总结。
- Message 只保存 `evidence_ref` 及有界摘要。
- 上下文压缩不得复制 Blob 内容；压缩后仍通过 evidenceId 回查。

日志签名、计数、阈值、时间覆盖率和 traceId 关联由确定性代码计算，不交给模型。

## 12. Event、SSE、LangSmith 与审计

本设计不新增 EventType，也不修改严格的 V2 payload：

- `EVIDENCE_COLLECTED` 继续只携带 `evidenceIds`、`coverage`、`source` 和安全摘要。
- `TOOL_RESULT` 和 Message 使用 `evidence_ref`，不携带 storage key、查询正文或日志正文。
- 大小、记录数、截断状态等完整结构化元数据由 Evidence 查询 API 根据 evidenceId 返回；若未来确需放入公共事件，必须另做 Event schema 版本决策。
- LangSmith span 只记录 evidenceId、来源、耗时、页数、记录数、字节数、coverage、truncated、重试次数和错误码。
- 禁止把原始日志、完整 ELK DSL、内部地址、Authorization 或 Blob 路径上传 LangSmith。

业务日志中的 traceId 继续进入 `businessTraceIds`/证据索引；它与 Agent 自身 LangSmith trace/span ID 保持独立，只通过 evidenceId 关联。

## 13. 重试、恢复与熔断

- ELK 网络错误和普通 429/5xx 在来源适配器做有界指数退避；认证、DSL 和权限错误不重试。
- 重试按页进行，已提交 chunk 不重新写入；chunk identity 由 `captureKey + chunkIndex + sha256` 保证幂等。
- 每页成功后持久化 `nextCursor`、快照 ID 和累计状态，再请求下一页。
- PIT 仍有效时从已保存游标继续；PIT 已过期时，原 capture 标记 `partial`，新建 capture 重新取证，不伪装成原快照的无缝续传。
- 连续来源失败触发 ELK circuit breaker；熔断期间 Logs Subagent 返回明确的来源不可用和已有 partial evidence，不循环调用。
- BlobStore 空间不足、哈希不一致或 Manifest 冲突不得降级成内存保存。
- Abort 后停止拉取新页、关闭 writer、保存可恢复状态；只有通过完整性校验的 chunk 可进入 partial evidence。

## 14. 安全、保留与清理

默认在持久化前执行脱敏，至少处理凭证、Cookie、Token、个人信息和业务配置中的敏感字段。脱敏规则版本写入 Manifest，便于审计。

若未来法规或事故取证要求保留未脱敏原文，必须另行批准受限原文层：启用静态加密、独立密钥管理、最小权限、访问审计和更短保留期；不得默认开启，也不得向模型开放。

每个 Manifest 保存 `retentionUntil` 或由 Profile 的保留策略推导。清理器只能删除：已到期、无活动 Run/报告引用且不处于 pending 的证据。删除动作需要审计记录；失败可重试但不能影响在线诊断。

## 15. 验收标准

### 流式和资源边界

- 用至少 64 MiB 的生成数据验证摄取过程中内存不会随总数据量线性增长。
- MCP 每页不超过配置上限，跨 CRLF/UTF-8 边界和异常大单行日志都有确定性处理。
- 交替分页、慢 Blob 写入和 Abort 能体现背压，不出现无界队列。
- gzip chunk 可独立校验和读取，单个损坏 chunk 不被当作完整证据。

### 一致性和恢复

- pending、chunk 已发布但元数据未提交、Manifest 已提交、删除中等崩溃点均有恢复测试。
- 同一 captureKey 精确重试幂等；相同 identity 不同哈希产生冲突。
- PIT 过期不会把两个不同来源快照拼成一份完整证据。
- partial/truncated 的 coverage 与 missingEvidence 可稳定重放。

### Agent 集成

- Logs Subagent 能用分页 MCP 采集几十 MiB 日志，但主 Agent Message、公共 Event、SSE 和 LangSmith 都不含原文。
- `logs.search_evidence` 和 `logs.read_evidence_slice` 只能返回有界、脱敏、当前 Run 可访问的结果。
- 达到预算、ELK 熔断、BlobStore 空间不足和消费者取消时，Run 输出明确的部分诊断或结构化失败。
- 证据摘要中的计数、Top-N、时间覆盖和哈希由确定性断言验证，不以模型文本作为验收依据。

## 16. 实施顺序

1. 先完成 Durable Run State & Evidence V1 的 SQLite Checkpoint、内联指标证据和执行日志。
2. 提取 `StreamingEvidenceRecorder`、`EvidenceManifestStore`、`EvidenceBlobStore` 和本地文件实现。
3. 增加生成式大日志 fixture，先验证流式、背压、崩溃恢复和预算。
4. 实现分页 ELK MCP 与 `ElkEvidenceSource`，接入 `logs.capture` 等普通 Tool。
5. 将 Logs Subagent 作为 Tool 注册到 Toolkit，完成主 Agent 并行编排。
6. 最后接真实 ELK、生产 BlobStore、加密、保留清理和 LangSmith 评测集。
