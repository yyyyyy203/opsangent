# 向量记忆存储与检索可用性实验 Spec

日期：2026-10-10。状态：待实施、待验收。与 [基础记忆 Spec R2](./2026-10-10-governed-diagnostic-memory-design.md) 分开交付；本文不表示现有代码已有向量存储，也不表示四类记忆均已实现。

## 1. 目标与范围

验证向量能否在本项目中被安全存储、检索、重启恢复和降级，并用固定语料对比 BM25、向量与混合检索。它是阶段 B 实验，不是基础案例沉淀的开关，也不强制把向量接入日常 Harness。

交付两个层次的报告：

- 存储/机制验证：真实 Float32 向量落库、排名、范围/版本隔离、删除、重开、故障降级；确定性合成向量可以验证算法和契约，但不能证明语义可用性。
- 真实 Embedding 验证：使用有可复核生成信息的真实本地向量包，完成同义表达、中文/英文、不同故障与错范围对照。未提供真实包时报告 not_provided，不把合成向量的成功写成真实语义检索通过。

不进行模型下载、DeepSeek/LangSmith 请求或付费 Embedding 请求。第一实验适配器消费本地预生成向量包；由用户或另一个明确授权的任务生成真实包。真实包的来源缺失只阻止语义效果结论，不阻止基础记忆或存储机制验收。实时 Embedding SDK、生产 ANN 服务、跨范围泛化、Semantic 完整知识库与 Procedural 模板库不在本实验交付中。

本期实现 SQLite Float32 BLOB + 有界余弦穷举索引，复用已有 better-sqlite3，不引入新的 native extension。它是可替换的实验实现，不声称千条以上或生产吞吐能力；是否采用 sqlite-vss、其他扩展或独立向量服务由测量后的独立设计决定。

## 2. 分工、数据权威和依赖

SQLite 案例/审核记录仍是事实来源，向量仅是可丢弃、可重建的派生索引。原始日志、证据原文、凭据和完整 prompt 不进入向量包或索引。

Working 使用结构化 Context，不向量化；实验默认只索引同一模拟范围内 approved/sufficient/completed 的 Episodic 案例。Semantic 以后可以复用同一检索接口，但必须先有受控、版本化知识来源；Procedural 先检查适用条件，向量相似度不代替审核或动作授权。

依赖单向：

```text
实验 bootstrap -> 本地 EmbeddingProvider + SQLite VectorIndex
               -> ShadowMemoryRetriever -> 基础 MemoryQueryStore
独立验收 CLI -> 实验查询结果/质量报告
基础 Capture / Review / Harness 不依赖实验模块
```

VectorIndex 面向小接口；核心不导入 SQLite、文件系统或第三方 SDK。实验 CLI 明确打开独立实验数据库，不在基础 runtime 隐式打开第二个连接。服务端不提供用户上传向量包或任意文件路径接口。

## 3. 稳定小接口

类型放入未来的 src/contracts/memory-vector.ts，引用基础 memory contracts；实现分别放 memory 和 infrastructure，实验组装在 bootstrap。以下为未发布的新增接口，不改 MemoryFacade/Event/Message/ToolResponse：

```ts
import type { MemoryOperation, MemoryScope, MemorySelection } from './diagnostic-memory.js';

export interface EmbeddingSpace {
  provider: string;
  model: string;
  revision: string;
  dimensions: number;
  normalization: 'l2';
  metric: 'cosine';
}
export interface EmbeddingProvider {
  readonly space: EmbeddingSpace;
  embed(texts: readonly string[], operation: MemoryOperation): Promise<readonly Float32Array[]>;
}
export interface MemoryVectorDocument extends MemorySelection {
  scope: MemoryScope;
  kind: 'episodic';
  sourceRunId: string;
  text: string;
}
export interface MemoryVectorEntry extends MemorySelection {
  scope: MemoryScope;
  kind: 'episodic';
  space: EmbeddingSpace;
  vector: Float32Array;
}
export interface MemoryVectorHit extends MemorySelection {
  score: number;
}
export interface MemoryVectorSearch {
  scope: MemoryScope;
  space: EmbeddingSpace;
  vector: Float32Array;
  eligible: readonly MemorySelection[];
  limit: number;
}
export interface VectorIndex {
  upsert(entries: readonly MemoryVectorEntry[], operation: MemoryOperation): Promise<void>;
  search(input: MemoryVectorSearch, operation: MemoryOperation): Promise<readonly MemoryVectorHit[]>;
  remove(input: { scope: MemoryScope; space: EmbeddingSpace;
    memoryIds: readonly string[] }, operation: MemoryOperation): Promise<void>;
  close(): Promise<void>;
}
export interface MemoryExperimentCorpus {
  read(input: { scope: MemoryScope; excludeRunIds: readonly string[] },
    operation: MemoryOperation): Promise<readonly MemoryVectorDocument[]>;
}
export type VectorExperimentErrorCode =
  | 'VECTOR_INPUT_INVALID' | 'VECTOR_SPACE_MISMATCH' | 'VECTOR_PACK_INVALID'
  | 'VECTOR_EMBEDDING_MISSING' | 'VECTOR_INDEX_UNAVAILABLE'
  | 'VECTOR_CAPACITY_EXCEEDED';
export interface ShadowRetrievalResult {
  requestedMode: 'bm25' | 'vector' | 'hybrid';
  usedMode: 'bm25' | 'vector' | 'hybrid';
  hits: readonly MemorySelection[];
  fallbackReason?: VectorExperimentErrorCode;
}
export interface MemoryVectorMeasurements {
  nowMs(): number;
  rssBytes(): number;
  indexBytes(): Promise<number>;
}
```

MemoryExperimentCorpus 只能从已过滤、脱敏且审核有效的案例快照读取；scope、now、excludeRunIds、状态、质量、来源终态和有效期检查在入索引和搜索前均执行。检索结束后再次用基础 queries.revalidate 检查 revision/digest/审核与证据引用；撤销和过期即时不再返回，不等待异步索引清理。

### 3.1 本地向量包

未来 schema 为严格 JSON：

```ts
export interface LocalEmbeddingPack {
  schemaVersion: 1;
  space: EmbeddingSpace;
  provenance: 'real' | 'synthetic';
  generatorRevision: string;
  corpusDigest: string;
  querySetDigest: string;
  entries: readonly { textDigest: string; vector: readonly number[] }[];
}
```

textDigest 是基础脱敏文本正规化后的 SHA-256；正规化固定 NFKC、CRLF→LF、trim，不小写或删除中文，再按 UTF-8 编码。querySetDigest/corpusDigest 绑定实验语料和查询集。向量包不包含原文；provider 按 exact textDigest 查找，不用近似文本或另一个模型补缺失向量。缺 query/doc 向量明确失败并降级 BM25，不静默生成随机向量。

真实包附带可复核的生成器版本、模型/修订与维度信息，使用实验报告记录其文件 SHA-256；provenance 标记本身不是来源或效果证明。不能把 synthetic 改成 real 冒充模型评测。包最大 32 MiB、最多 2000 个唯一 textDigest，读取前检查大小；每次 embed 最多 16 条，每段文本最多 2 KiB；dimensions 在 2..4096 且全包一致。

所有元素 finite，拒绝 NaN/Infinity、零向量、维度不符；用 float32 完成一致的 L2 正规化，provider/index 双重校验并拒绝无效结果。模型版本/维度/正规化策略改变产生新的 spaceKey，不能混用；原包和旧索引不原地伪装成新模型。

## 4. 持久化、范围与资源边界

实验独立库 schemaVersion=1，开启 WAL、事务和完整校验：

| 表 | 内容与约束 |
|---|---|
| vector_experiment_meta | schema version、按 space_key 保存完整 space descriptor/语料 digest，无密钥/真实端点 |
| memory_vector_rows | space_key、scope_key、kind、memory_id、revision、digest、dimensions、vector_blob、vector_sha256；主键(space_key, scope_key, kind, memory_id) |

Float32 按显式 little-endian 编码，不能依赖 TypedArray 的平台内存布局；vector_blob 长度必须 dimensions×4。upsert 一批全校验后事务写入，拒绝降低已有 revision 或同 revision 不同 digest，故障不留半批；重开检查 schema/descriptor/长度和哈希，损坏条目不能返回。索引重建写新 space，完整通过后才由实验配置选用；失败保留旧 space，但不得把旧空间用于新模型查询。

过滤必须先于余弦和 Top-K：SQL WHERE 同时约束 scope_key、space_key、kind，并与 eligible 的 memoryId/revision/digest 精确匹配，再读取候选 BLOB 计算排名。eligible 来自基础受控语料，不是 LLM/HTTP 输入。禁止全库 Top-K 后过滤、全库向量装入内存或忽略 scope 的缓存。

最多 1000 个索引条目/实验库；单条向量最多 16 KiB，单批 upsert 最多16条，limit 默认5/上限10。查询候选最多1000、vector BLOB 总量最多16 MiB，超过容量返回固定错误，不默默截断当作完整对照；循环每64条检查 signal/deadline。当前时间通过 Clock 注入，耗时/RSS 通过实验测量端口注入，不在实现中隐藏调用 Date.now。规模扩大需更换实现并重新测量，不把这个实验算法宣传成生产 ANN。

余弦 score 降序，浮点计算结束检查 finite，同分按 memoryId 升序；结果保留独立 score/order，不通过无 ORDER BY 的 SQL IN 重排。删除指定 scope/space 的 IDs 不影响其他模型或范围。日常证据/案例删除不由实验索引来决定。

## 5. BM25、向量与混合对照

ShadowMemoryRetriever 只产生实验结果，不向 Harness 注入提示。BM25 使用基础 MemoryQueryStore.search；向量和混合在同一个 scope、相同 eligible corpus、excludeRunIds 与预算下比较。

hybrid 使用 RRF：两列表分别保留自身顺序，rank 从1开始，score=Σ1/(60+rank)，去重键为 memoryId/revision/digest；同分 memoryId 升序。任何重排、重复 ID、不同版本混合均用确定性测试拒绝。

Embedding 包缺失/维度不符/空间变化/索引不可用/损坏/容量问题：固定 fallbackReason，usedMode=bm25，继续基础过滤与预算；基础 BM25 也失败则明确 empty/unavailable，不声称恢复成功。真实 Abort 立即传播，不吞成空结果；没有剩余 deadline 时不发起另一次搜索。报告记录降级，不扩大公共事件 visibility；实验数据/向量不进入 SSE、Message 或 LangSmith。

向量配置或实验全关闭时，基础 Capture、Review、BM25 及真实模型烟测输入/请求次数均不变。不能通过开启向量把 observation、失败调查、模拟记忆或其他 scope 变成生产可用参考。

## 6. 实验入口、预算与验收

独立 CLI 计划为 pnpm acceptance:memory-vector，只有 AGENTOPS_MEMORY_VECTOR_EXPERIMENT=1 才可运行；读取绝对路径 AGENTOPS_MEMORY_EMBEDDING_PACK。未开启固定 VECTOR_EXPERIMENT_NOT_ENABLED/退出1；缺包为 VECTOR_EMBEDDING_PACK_REQUIRED、realEmbedding=not_provided/退出2，机制单元测试仍可独立运行。合法 synthetic 包完成机制检查时 status=mechanism_verified、realEmbedding=not_provided/退出2，不能把真实 Embedding 项标为通过。真实来源校验失败返回固定码，不回显文件内容/路径/密钥。

索引库与报告放实验专用目录；不访问用户现有 acceptance DB。默认报告用例 ID、排名 ID、digest、模式/降级码、模型版本/维度、语料计数、耗时/内存/文件大小，无全文。模型 HTTP/外部 HTTP 请求计数必须由测试 spy 验证为0。

至少覆盖：中文/英文/同义不同措辞、同词不同故障、错 scope/target/dataset/revision、当前 Run 排除、observation/rejected/failed、撤销/过期、模型维度变化、包缺失、坏 BLOB、重复 upsert、事务失败、删除隔离、Abort/deadline、数据库重开、向量故障→BM25。

质量对照需要独立 holdout 查询/相关 ID 标注，标签只用于离线评测，不进入索引内容或 Agent。每种模式报告 hit@5、MRR@5、nDCG@5 和空召回数；样本不足不写“准确率提升”。记录 p50/p95、process RSS 峰值与索引字节；这些是观测值，不先写未经验证的资源承诺。

通过存储机制不等于真实语义质量通过；使用真实包完成对照也不等于业务根因准确或生产 ANN 可上线。实验决策报告只能建议保留/更换索引、补数据或开启下一轮集成设计，不能自动修改生产默认。

实施顺序与逐文件测试见 [向量实验计划](../plans/2026-10-10-memory-vector-feasibility.md)。阶段 A 完成和阶段 B 完成分别报告；本轮仅写文档，不生成 Embedding、不执行联网实验。
