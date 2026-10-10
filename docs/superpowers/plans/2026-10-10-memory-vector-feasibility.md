# Memory Vector Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证可替换向量索引的真实落库、隔离、重启和降级，并支持真实本地 Embedding 包下的 BM25/向量/混合对照；不把合成测试冒充语义质量通过。

**Architecture:** 小型 EmbeddingProvider/VectorIndex 接口 + 本地文件 provider + 独立 SQLite Float32 索引 + 影子检索器。基础案例库是事实来源，实验不改 Harness 默认、不依赖联网模型；索引或包故障回到同范围 BM25。

**Tech Stack:** TypeScript、Node.js 24、pnpm 11.19.0、Zod 3、better-sqlite3、Float32/DataView、Vitest；不增加 native extension、Embedding SDK 或模型下载。

**Spec:** [向量记忆可用性实验设计](../specs/2026-10-10-memory-vector-feasibility-design.md)。状态：待执行；与 [阶段 A 基础计划](./2026-10-10-governed-diagnostic-memory.md) 分开验收。

## Global Constraints

- Working 不向量化；默认仅 approved/sufficient/completed、未过期、同模拟范围的 Episodic 入实验索引。
- 索引是可重建的派生数据，不能代替案例、证据或人工审核，也不赋予工具执行权限。
- scope/space/eligible 的 revision+digest 过滤在计算与 Top-K 前；排序结果不得经无序 SQL IN 重排。
- 实验库最多1000条，每条向量最多16 KiB、dimensions=2..4096，单批16条、Top-K默认5/上限10；每64条检查 Abort/deadline。
- 包最大32 MiB、2000个唯一 textDigest；embed最多16段、每段2 KiB；零向量/NaN/Infinity/维度错拒绝。
- real/synthetic 分别报告；没有真实包输出 realEmbedding=not_provided，不算语义验证通过。
- AGENTOPS_MEMORY_VECTOR_EXPERIMENT=1 显式启用，AGENTOPS_MEMORY_EMBEDDING_PACK 是受信宿主的绝对路径；不开放 HTTP 上传/任意路径入口。
- 验收使用独立实验 DB，不调用 DeepSeek、LangSmith、Embedding HTTP，不下载模型、不改生产召回默认。
- 时间与测量工具注入；不覆盖现有熔断/UI 修改，不整体 git add，不自动推送。

---

## 文件与依赖地图

| 文件 | 单一职责 |
|---|---|
| src/contracts/memory-vector.ts | 本 Spec 的小接口与向量包类型 |
| src/contracts/memory-vector-schema.ts | 严格包/空间/输入校验 |
| src/memory/vector/embedding-space.ts | 空间键、文本正规化、digest、向量正规化 |
| src/memory/vector/vector-error.ts | VectorExperimentError，固定 code/message |
| src/infrastructure/memory/file-embedding-provider.ts | 有界读取本地预生成包，按 textDigest 精确取向量 |
| src/infrastructure/sqlite/memory-vector-database.ts | 显式实验库、schemaVersion=1、WAL、关闭 |
| src/infrastructure/sqlite/memory-vector-index.ts | little-endian BLOB、事务写入、过滤排名、删除 |
| src/memory/vector/vector-indexer.ts | 受控语料过滤后的有界建索引 |
| src/memory/vector/shadow-retriever.ts | 独立 BM25/向量/混合模式与降级 |
| src/memory/vector/rrf.ts | 保序 RRF 去重与排序 |
| src/memory/vector/index.ts | 公开入口，不能把文件系统/SQLite 类型导出到 contracts |
| src/bootstrap/memory-vector-experiment.ts | 实验配置、端口和生命周期组装 |
| apps/acceptance/memory-vector.mjs | 独立验收与脱敏机制/效果报告 |
| docs/guides/memory-vector-experiment.md | 本地包协议、来源要求、执行/失败/回退指南 |

依赖：基础 T1 的 scope/types → V1 → V2 → V3；V3 的基础 BM25/revalidation 集成需要基础 T5/T9 已通过。V1/V2 可以先用合成向量验证机制，但不能把 V3 或真实语义结论提前勾选完成。

V1 新增 test/fixtures/memory-vector.ts，导出 vectorNow、vectorOperation、vectorSpace、vectorEntry：

```ts
import type { MemoryVectorEntry } from '../../src/contracts/memory-vector.js';
import { memoryCase, simulationMemoryScope } from './diagnostic-memory.js';
export const vectorNow = '2026-10-10T00:00:00.000Z';
export const vectorOperation = {
  now: vectorNow, deadlineMs: Date.parse(vectorNow) + 1000,
};
export const vectorSpace = {
  provider: 'fixture', model: 'unit-vectors', revision: 'v1',
  dimensions: 3, normalization: 'l2' as const, metric: 'cosine' as const,
};
export function vectorEntry(overrides: Partial<MemoryVectorEntry> = {}): MemoryVectorEntry {
  const item = memoryCase({ status: 'approved', sourceRunStatus: 'completed' });
  return { memoryId: item.id, revision: item.revision, digest: item.digest,
    scope: simulationMemoryScope(), kind: 'episodic', space: vectorSpace,
    vector: new Float32Array([1, 0, 0]), ...overrides };
}
```

该 fixture 必须 provenance=synthetic，只用于算法/隔离；真实语义验收不得复用。临时目录用现有 Node mkdtemp 模式，cleanup 仅针对已验证的测试目录，不能删除工作区或用户数据。

## Task V1：契约、空间版本与本地 Embedding 适配器

**Files**

- Create: src/contracts/memory-vector.ts、src/contracts/memory-vector-schema.ts、src/memory/vector/embedding-space.ts、src/memory/vector/vector-error.ts、src/memory/vector/index.ts、src/infrastructure/memory/file-embedding-provider.ts、test/fixtures/memory-vector.ts、test/memory-vector-contract.test.ts、test/file-embedding-provider.test.ts。
- Modify: src/contracts/index.ts，仅追加类型/解析导出。

**Interfaces**

- Consumes: Spec §3 的完整类型、基础 MemoryScope/MemoryOperation/MemorySelection。
- Produces: parseEmbeddingSpace(value: unknown): EmbeddingSpace；parseLocalEmbeddingPack(value: unknown): LocalEmbeddingPack。
- Produces: embeddingSpaceKey(space: EmbeddingSpace): string；normalizeMemoryEmbeddingText(text: string): string；memoryEmbeddingTextDigest(text: string): string；normalizeMemoryVector(vector: Float32Array, dimensions: number): Float32Array。
- Produces: VectorExperimentError，位于 src/memory/vector/vector-error.ts，readonly code: VectorExperimentErrorCode，固定 message 映射，不拼入原始异常。
- Produces: FileEmbeddingProvider implements EmbeddingProvider；static load(input: { path: string; expectedSpace: EmbeddingSpace; corpusDigest: string; querySetDigest: string; clock: Clock }): Promise<FileEmbeddingProvider>；embed 签名见 Spec，Clock 从既有 src/contracts/common.ts 导入。

- [ ] Step 1：写空间/包 strict parser 与 provider 红测试：缺来源、非法维度、unknown字段、重复digest、错space、oversize、零向量、缺 query 向量、禁止外部调用。数学正规化示例：

```ts
import { expect, it } from 'vitest';
import { normalizeMemoryVector } from '../src/memory/vector/embedding-space.js';
it('normalizes valid float32 vectors and rejects zero vectors', () => {
  const result = normalizeMemoryVector(new Float32Array([3, 4, 0]), 3);
  expect(result[0]).toBeCloseTo(0.6, 6);
  expect(result[1]).toBeCloseTo(0.8, 6);
  expect(() => normalizeMemoryVector(new Float32Array(3), 3)).toThrow();
});
```

- [ ] Step 2：运行 pnpm exec vitest run test/memory-vector-contract.test.ts test/file-embedding-provider.test.ts --maxWorkers=2，确认新增行为断言为红，不把环境错误算红。
- [ ] Step 3：文本固定 NFKC、CRLF→LF、trim，不小写、不删除中文；UTF-8 SHA-256 作为 exact textDigest。spaceKey 对全部空间字段固定序列 canonical JSON。实现 pack 大小预检、strict parse、digest唯一、expected space/corpus/querySet 全匹配；embed 只按 digest 返回向量副本，缺失抛 VECTOR_EMBEDDING_MISSING。

```ts
const bytes = new TextEncoder().encode(normalizeMemoryEmbeddingText(text));
const digest = createHash('sha256').update(bytes).digest('hex');
const magnitude = Math.hypot(...vector);
if (!Number.isFinite(magnitude) || magnitude === 0) {
  throw new VectorExperimentError('VECTOR_INPUT_INVALID');
}
```

createHash 从 node:crypto 导入；纯 digest 是确定性工具，不含文件访问。VectorExperimentError 从本任务声明的 vector-error.ts 导入；message 无包内容或路径。维度/finite 检查必须在 magnitude 前；正规化后再 finite 校验。provider 文件系统仅存在于 infrastructure。

- [ ] Step 4：跑上述测试与 pnpm typecheck；测试真实包标记/生成信息不代表来源已验证，synthetic 不得计入 semantic pass。只提交本任务文件，消息 feat(memory): add versioned local embedding experiment ports。

## Task V2：SQLite Float32 索引与隔离/重启

**Files**

- Create: src/infrastructure/sqlite/memory-vector-database.ts、src/infrastructure/sqlite/memory-vector-index.ts、test/memory-vector-index.test.ts。
- Modify: src/infrastructure/sqlite/index.ts，仅追加实验入口，不改基础 migrations.ts 或生产 SqlitePersistenceBundle。

**Interfaces**

- Consumes: V1 spaceKey/vector解析、VectorIndex。
- Produces: MemoryVectorDatabase.open(path: string): MemoryVectorDatabase，含 raw/close，仅 infrastructure 使用；SqliteVectorIndex implements VectorIndex，constructor { database: MemoryVectorDatabase; clock: Clock }。index.close 停止接受调用，数据库由 bootstrap 的唯一 owner 关闭。

- [ ] Step 1：红测试在独立临时库插入 scope A/B、同scope不同space、不同revision/digest；A 的 eligible 仅一个ID，B的相似度更高也不能抢占 Top-K：

```ts
await index.upsert([vectorEntry(), vectorEntry({
  memoryId: 'other-scope', scope: { ...simulationMemoryScope(), datasetId: 'other' },
})], vectorOperation);
const hits = await index.search({
  scope: simulationMemoryScope(), space: vectorSpace,
  vector: new Float32Array([1, 0, 0]),
  eligible: [{ memoryId: 'memory-1', revision: 1, digest: memoryCase().digest }],
  limit: 5,
}, vectorOperation);
expect(hits.map((hit) => hit.memoryId)).toEqual(['memory-1']);
```

同文件还测去重upsert、wrong dimension、坏BLOB、事务回滚、容量边界、同分保序、删除隔离与关闭重开。index/database/fixtures 均由本任务声明的构造器与 V1 fixture 建立。

- [ ] Step 2：运行 pnpm exec vitest run test/memory-vector-index.test.ts --maxWorkers=2 看红。
- [ ] Step 3：实现 Spec §4 两表，WAL/schema=1；DataView.setFloat32(offset, value, true) 编码，读取按相同 endianness，校验 bytes/dimensions/hash。参数化 SQL 的 scope/space/kind + eligible ID/revision/digest 条件在取BLOB前；LIMIT 不能先对全库或未排序候选截断。

```sql
SELECT v.memory_id, v.revision, v.digest, v.dimensions, v.vector_blob, v.vector_sha256
FROM memory_vector_rows v
JOIN json_each(@eligible) e
  ON v.memory_id = json_extract(e.value, '$.memoryId')
 AND v.revision = json_extract(e.value, '$.revision')
 AND v.digest = json_extract(e.value, '$.digest')
WHERE v.scope_key = @scopeKey AND v.space_key = @spaceKey AND v.kind = 'episodic';
```

eligible 限1000且去重，绑定 JSON，不拼接 SQL。先验证候选总字节/条数，再计算余弦；score 降序、同分memoryId升序，保留数组顺序。upsert单批校验后同事务，降低revision/同revision不同digest拒绝；损坏/超预算固定错误，不能绕过 scope 或静默返回看似完整的结果。

- [ ] Step 4：增加预先 aborted signal、循环 deadline、未知schema、重建新space失败不污染旧space和重开恢复的测试。运行 V1/V2 与 typecheck，消息 feat(memory): add bounded scoped sqlite vector experiment index。

## Task V3：影子检索、RRF、离线对照与操作指南

**Files**

- Create: src/memory/vector/vector-indexer.ts、src/memory/vector/shadow-retriever.ts、src/memory/vector/rrf.ts、src/bootstrap/memory-vector-experiment.ts、apps/acceptance/memory-vector.mjs、test/memory-vector-retrieval.test.ts、test/memory-vector-acceptance.test.ts、docs/guides/memory-vector-experiment.md。
- Modify: package.json（仅追加 acceptance:memory-vector）、docs/README.md、src/memory/vector/index.ts。

**Interfaces**

- Consumes: 基础 T5 MemoryQueryStore/BM25/revalidate 与 T4 MemoryEvidenceValidator；MemoryExperimentCorpus、EmbeddingProvider、VectorIndex。
- Produces: reciprocalRankFusion(lists: readonly (readonly MemoryVectorHit[])[], limit: number): readonly MemorySelection[]，rank从1开始、k=60、完整版本键去重。
- Produces: MemoryVectorIndexer constructor { corpus: MemoryExperimentCorpus; embeddings: EmbeddingProvider; index: VectorIndex; clock: Clock }；rebuild(input: { scope: MemoryScope; excludeRunIds: readonly string[] }, operation: MemoryOperation): Promise<{ indexedCount: number; spaceKey: string }>。
- Produces: ShadowMemoryRetriever constructor { queries: MemoryQueryStore; corpus: MemoryExperimentCorpus; evidence: MemoryEvidenceValidator; embeddings: EmbeddingProvider; index: VectorIndex; clock: Clock }；retrieve(input: { mode: 'bm25' | 'vector' | 'hybrid'; scope: MemoryScope; text: string; excludeRunIds: readonly string[]; limit: number }, operation: MemoryOperation): Promise<ShadowRetrievalResult>。
- Produces: createMemoryVectorExperiment(input: { packPath: string; databasePath: string; scope: MemoryScope; space: EmbeddingSpace; corpusDigest: string; querySetDigest: string; corpus: MemoryExperimentCorpus; queries: MemoryQueryStore; evidence: MemoryEvidenceValidator; clock: Clock }): Promise<{ indexer: MemoryVectorIndexer; retriever: ShadowMemoryRetriever; close(): Promise<void> }>，仅 bootstrap 组装具体类；expectedSpace/语料/查询 digest 传给 V1 provider。
- Consumes: Spec 的 MemoryVectorMeasurements；验收 runner 从 CLI 注入 nowMs/rssBytes/indexBytes 的 host 实现，单测用固定计数器，不在检索器直接读取进程资源。

- [ ] Step 1：红测试 vector返回无序/交叉ID、RRF重复/版本错、撤销/过期/错scope、缺包/错space/坏索引→BM25、Abort立即传播。Fake index 抛固定错误，不调用任何HTTP：

```ts
const result = await retriever.retrieve({
  mode: 'hybrid', scope: simulationMemoryScope(),
  text: '结算失败率', excludeRunIds: ['current-run'], limit: 5,
}, vectorOperation);
expect(result.usedMode).toBe('bm25');
expect(result.fallbackReason).toBe('VECTOR_INDEX_UNAVAILABLE');
expect(result.hits.map((hit) => hit.memoryId)).toEqual(['memory-1']);
expect(externalRequestsSent).toBe(0);
```

setup 注入 queries/corpus/evidence 的已批准同scope fixture 与拒绝HTTP的 spy；base memoryCase 的固定digest仅供接口测试，实际建索引和报告验收必须使用真实canonical case/text digest。

- [ ] Step 2：运行 pnpm exec vitest run test/memory-vector-retrieval.test.ts test/memory-vector-acceptance.test.ts --maxWorkers=2 看红。
- [ ] Step 3：indexer 只取 bounded approved corpus，最多16条一批，索引写本scope/space；retriever每次重新取 eligibility，vector/hybrid 先过滤再搜索，RRF保序后 queries.revalidate+evidence复核，全部限制同一剩余deadline。普通实验故障返回明确BM25降级，Abort传播；如果BM25也失败，不输出恢复成功。
- [ ] Step 4：实现 CLI 显式配置预检与两层报告，build后运行。添加脚本：

```json
"acceptance:memory-vector": "pnpm build && node apps/acceptance/memory-vector.mjs"
```

预检未开启退出1；缺包输出 VECTOR_EMBEDDING_PACK_REQUIRED、realEmbedding=not_provided，退出2。合法synthetic包机制检查通过，输出 status=mechanism_verified、realEmbedding=not_provided/退出2；不自动造随机包补输入。来源可复核的real包且全部机制/对照执行成功才 status=verified；效果指标是观测值，不因向量没优于BM25就伪造结论。报告含 semanticEvaluation=measured、不含根因准确或生产效果承诺。

- [ ] Step 5：建立固定 holdout 查询集，标签与索引文本分离；至少12个中文/英文/同义/近词/错范围/无匹配查询，逐模式输出排名、hit@5/MRR@5/nDCG@5与空召回。timer/RSS测量注入，验收记录p50/p95/峰值RSS/索引字节；手动来源检查真实包的生成器信息和文件hash，不把标记本身当证明。报告不含全文/向量/内部路径；外部请求spy计数为0。
- [ ] Step 6：运行 V1/V2/V3全部测试、基础 memory 联验与无记忆烟测本地契约，再 pnpm lint/typecheck/test -- --maxWorkers=2/build。操作指南给出固定包schema、正规化、空间变化/重建、opt-in、退出码、缺包不算语义通过、关闭不影响保存的说明。提交 test(memory): verify vector shadow retrieval isolation restart and fallback。

## 完成定义与自检

| Spec | 对应任务 |
|---|---|
| §1 机制/真实Embedding分开，独立边界 | V1/V3 |
| §2 依赖、派生索引、四类职责 | V1/V2/V3 |
| §3 空间/包/错误/范围端口 | V1 |
| §4 编码、WAL、事务、过滤、容量、重开 | V2 |
| §5 RRF/复核/降级/Abort与生产基线 | V3 |
| §6 预检、报告、质量/资源指标、无HTTP | V3 |

完成必须有实际向量写入/重开/查询/删除/故障测试，不仅有接口。没有真实包可以交付机制验证，但真实Embedding质量项保持未验证；不得掩盖这个差别。生产在线接入、实时Embedding Provider和Semantic/Procedural的完整库仍不在本计划中；不因实验通过自动修改基础配置。

计划尚未执行；先由用户审核修订后的 Spec/计划，再按依赖任务实施。当前不生成向量包、不下载模型、不联网调用或推送。
