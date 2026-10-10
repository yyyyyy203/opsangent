# Governed Diagnostic Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成默认关闭、人工审核后才可召回的诊断案例记忆闭环，不增加记忆专用模型调用。

**Architecture:** 保留现有 MemoryFacade；新增小型契约、SQLite/InMemory 实现、Worker、ReviewService、Recall 与 Renderer。核心只依赖 contracts，具体组装在 bootstrap；信号、Job、候选和审核通过现有 durable transition/outbox 保证事务一致性。

**Tech Stack:** 本分支 TypeScript、Node.js 24、pnpm 11.19.0、Zod 3、better-sqlite3/FTS5、Vitest、现有 React/Playwright；不增加 Embedding 或向量依赖。

**Spec:** [受控诊断记忆一期设计](../specs/2026-10-10-governed-diagnostic-memory-design.md)。状态：计划待执行，复选框不表示已实现。

## Global Constraints

- 全部功能默认关闭。
- 原 MemoryFacade、Event/Message/ToolResponse、V1 Generator yield 和 V2 侧路顺序不变。
- SQLite 在当前 v4 后追加迁移；Checkpoint 新写 Schema 3，旧版先验原 checksum 再迁移。
- 只做 Episodic 闭环；Working 继续用现有 Checkpoint，Semantic 继续用 Profile，不启用 Procedural 自动执行。
- 所有搜索强制匹配完整 scope；模拟记录 eligibleForPromotion=false，不能读取 oracle/expectedOutcome。
- 最多 5 条模型提示、4 KiB/1024 token；单候选 16 KiB，summary 2 KiB，证据引用最多 20 条。
- Job 最多 2 次尝试、30 秒 lease、每次 drain 最多 50 条；pending/running 最多 1000 条。
- 时间、ID、外部调用注入；审批和记忆不授予 ToolCall 执行权限。
- 记忆验收使用独立 SQLite、模拟数据、ScriptedModel，不访问 DeepSeek、LangSmith 或真实业务系统。
- 实施前重新检查 git status；现有熔断/UI 未提交修改属于既有工作，禁止覆盖或整体 git add。
- 本工作树沿用 Node 24 基线，不顺手修改早期 Node 20 约定或升级 pnpm/native module。

---

## 文件地图、测试工具和接线顺序

新增文件职责：

| 文件 | 职责 |
|---|---|
| `src/contracts/diagnostic-memory.ts` | Spec §4 类型、查询/写入/召回/渲染端口 |
| `src/contracts/diagnostic-memory-schema.ts` | 严格解析和边界限制 |
| `src/memory/memory-error.ts` | 固定 MemoryErrorCode，无原始异常透传 |
| `src/memory/memory-scope.ts` | scope 规范化与精确比较 |
| `src/memory/chinese-tokenizer.ts` | 中文 bigram 与安全 FTS query |
| `src/memory/in-memory-diagnostic-memory.ts` | 新端口的确定性测试实现 |
| `src/memory/case-builder.ts` | 白名单生成候选、质量与长度校验 |
| `src/memory/capture-worker.ts` | 有界 Job 消费、lease fencing、重启重试 |
| `src/memory/review-service.ts` | 批准/拒绝/撤销与证据复核 |
| `src/memory/bounded-recall.ts` | 首次查询、冻结选择、后续复核与预算 |
| `src/memory/hint-renderer.ts` | 临时有界模型视图，不修改持久消息 |
| `src/memory/index.ts` | 新模块公开入口，保留已有导出 |
| `src/infrastructure/sqlite/diagnostic-memory-store.ts` | 案例/审核/索引事务与 CAS |
| `src/infrastructure/sqlite/memory-job-store.ts` | Job、信号、claim 与幂等 |
| `src/infrastructure/sqlite/memory-capture-source.ts` | 有界 Checkpoint/证据元数据读取，不选 raw_json |
| `src/application/memory-query-service.ts` | 安全 DTO 与宿主授权查询 |
| `src/bootstrap/diagnostic-memory.ts` | 配置、实现组装、runtime 生命周期 |
| `src/api/memory-routes.ts` | 查询和审核路由，不含核心状态机 |
| `apps/agent-web/src/components/MemoryPanel.tsx` | 本地案例管理与 Run 历史参考展示 |
| `apps/acceptance/memory.mjs` | 无付费调用的独立模拟联验入口 |
| `docs/guides/diagnostic-memory-local.md` | 开关、审核、撤销、数据隔离和验收步骤 |

任务依赖：T1 → T2 → T3/T4/T5 → T6 → T7 → T8 → T9。T3/T4/T5 可在契约冻结后独立阅读/测试，但 SQLite Store 共享，写同一文件时必须串行合并；不要让多个 Agent 同时改 Harness、migrations 或 App.tsx。

测试统一命令：`pnpm exec vitest run <exact-test-path> --maxWorkers=2`。红阶段应是新行为断言失败，不把拼写错误、环境错误当成有效红测试。

T1 新增 `test/fixtures/diagnostic-memory.ts` 的统一 fixture，避免后续任务靠未声明的辅助函数：

```ts
import type { DiagnosticMemoryCase, MemoryScope } from '../../src/contracts/diagnostic-memory.js';
export const memoryNow = '2026-10-10T00:00:00.000Z';
export function simulationMemoryScope(): MemoryScope {
  return {
    profileId: 'simulation', profileRevision: 'sim-v1', serviceId: 'settlement',
    faultType: 'settlement_failure', targetFingerprint: 'a'.repeat(64),
    environment: 'simulation', dataClass: 'simulated', datasetId: 'memory-lab-v1',
  };
}
export function memoryCase(overrides: Partial<DiagnosticMemoryCase> = {}): DiagnosticMemoryCase {
  return {
    schemaVersion: 1, id: 'memory-1', revision: 1, extractorVersion: 'episodic-v1',
    scope: simulationMemoryScope(), sourceRunId: 'historical-run-1',
    capturedAt: memoryNow, validUntil: '2026-11-09T00:00:00.000Z',
    status: 'observation', quality: 'sufficient', summary: '结算失败率升高，连接池等待增加。',
    symptomCodes: ['SETTLEMENT_FAILURE_HIGH'], limitations: [],
    evidenceRefs: [{ evidenceId: 'evidence-1', ownerRunId: 'historical-run-1',
      source: 'metric', capturedAt: memoryNow, rawSha256: 'b'.repeat(64) }],
    diagnosisOnly: true, eligibleForPromotion: false, digest: 'c'.repeat(64), ...overrides,
  };
}
```

fixture digest 是端口契约测试的固定假值，案例生成/摘要校验测试必须走真实 canonicalJson + SHA-256；不能把 fixture digest 硬编码进生产。

## Task 1：契约、Schema 与 Checkpoint 兼容

**Files**

- Create: `src/contracts/diagnostic-memory.ts`, `src/contracts/diagnostic-memory-schema.ts`, `src/memory/memory-error.ts`, `src/memory/memory-scope.ts`, `src/memory/index.ts`, `test/fixtures/diagnostic-memory.ts`, `test/diagnostic-memory-contract.test.ts`。
- Modify: `src/contracts/index.ts`, `src/contracts/context.ts`, `src/agent/types.ts`, `src/storage/durable-codec.ts`, `src/infrastructure/sqlite/durable-state-store.ts`。
- Test: `test/sqlite-durable-state.test.ts`, `test/governance-contract.test.ts`。

**Interfaces**

- Consumes: Spec §4 全部类型；现有 `parseAgentContext(value: unknown): AgentContext`、`checkpointChecksum(context: AgentContext): string`。
- Produces: `parseMemoryScope(value: unknown): MemoryScope`；`parseDiagnosticMemoryCase(value: unknown): DiagnosticMemoryCase`；`parseRunMemoryState(value: unknown): RunMemoryState`；`memoryScopeKey(scope: MemoryScope): string`；`sameMemoryScope(left: MemoryScope, right: MemoryScope): boolean`；`MemoryError` 类包含只读 `code: MemoryErrorCode`。

- [ ] Step 1：加入以下红测试，以及 simulation+live、缺 datasetId、越界长度、未知字段、坏 digest/时间、hint 超预算的负向用例。

```ts
import { expect, it } from 'vitest';
import { parseMemoryScope } from '../src/contracts/diagnostic-memory-schema.js';
import { simulationMemoryScope } from './fixtures/diagnostic-memory.js';
it('rejects simulated memory without a dataset boundary', () => {
  const value = { ...simulationMemoryScope(), datasetId: undefined };
  expect(() => parseMemoryScope(value)).toThrow();
});
```

- [ ] Step 2：运行 `pnpm exec vitest run test/diagnostic-memory-contract.test.ts --maxWorkers=2`，记录红结果。
- [ ] Step 3：实现 Spec 类型和 strict Zod schema。Scope 的数据分类通过 discriminated union 实现，不用 optional datasetId 放宽校验；初始化状态代码如下。

```ts
const initialMemory: RunMemoryState = {
  schemaVersion: 1, scope: parseMemoryScope(trustedMemoryScope),
  selectionState: 'unselected', availability: 'empty', selections: [], hints: [],
};
```

`initialMemory` 初始化在 T6 使用，此任务只建立类型/解析。scopeKey 对固定字段清单 canonicalJson，不 include 未声明数据；error message 由固定 code 映射，不拼接原始错误。

- [ ] Step 4：AgentContext 增加 `memory?`，ReplyOptions 增加 host-only `trustedMemoryScope?`。Checkpoint 写版本升 3，读版本 1/2/3 分支明确；v1/v2 使用原 JSON checksum 校验，解析旧数据后保持 memory 缺省，不能提前加默认字段改变 checksum。
- [ ] Step 5：扩展现有 SQLite checkpoint 测试：真实 v1/v2 存量恢复、v3 memory round-trip、未知未来版本拒绝、篡改内容失败、无 memory 的旧默认行为不变。运行 T1 三个测试文件与 typecheck。
- [ ] Step 6：只提交本任务文件，commit message：`feat(memory): define governed case contracts and checkpoint compatibility`。

## Task 2：SQLite/InMemory、Job 与 Hook 信号原子持久化

**Files**

- Create: `src/infrastructure/sqlite/diagnostic-memory-store.ts`, `src/infrastructure/sqlite/memory-job-store.ts`, `src/memory/in-memory-diagnostic-memory.ts`, `test/diagnostic-memory-store.test.ts`, `test/memory-transition-atomicity.test.ts`。
- Modify: `src/contracts/storage.ts`, `src/infrastructure/sqlite/migrations.ts`, `src/infrastructure/sqlite/durable-state-store.ts`, `src/infrastructure/sqlite/persistence-bundle.ts`, `src/infrastructure/sqlite/index.ts`, `src/storage/in-memory-durable-state.ts`。

**Interfaces**

- Consumes: Spec 的 `MemoryQueryStore`、`MemoryWriteUnitOfWork`、`MemoryCaptureIntent` 与既有 `DurableTransitionUnitOfWork.commit`。
- Produces: `SqliteDiagnosticMemoryStore implements MemoryQueryStore, MemoryWriteUnitOfWork`；构造参数 `{ database: SqliteDatabase; clock: Clock }`。
- Produces: `InMemoryDiagnosticMemoryStore implements MemoryQueryStore, MemoryWriteUnitOfWork`；构造参数 `{ clock: Clock }`。
- Produces: contracts 中 `MemoryMaintenance.prune(input: { now: string; limit: number }): Promise<{ expiredObservations: number; signalsRemoved: number }>`；bundle 可选 `memory?: { queries: MemoryQueryStore; writes: MemoryWriteUnitOfWork; maintenance: MemoryMaintenance; captureSource: MemoryCaptureSource }`。captureSource 在 T3 接入；T2 Store/Job 先独立验证，T3 完成后才开放 bundle.memory 的完整返回值。
- Produces: 内部 `persistMemorySignals(database: SqliteDatabase, context: AgentContext, effects: readonly GovernanceEffect[]): void` 与 `enqueueMemoryCapture(database: SqliteDatabase, intent: MemoryCaptureIntent): void`，必须在调用者现有事务中执行。

- [ ] Step 1：新建共享 Store 契约测试（内存、SQLite 双运行）：claim/complete、scope list/get、CAS review、requestId 重放/冲突、保留有效期、事务回滚。另做信号三重重放仅一条、未开记忆不存信号、陌生 runId 的 signal 拒绝。

```ts
// claim/complete 的完整参数来自 Spec；memoryCase()/memoryNow 来自 T1 fixture。
const claim = await writes.claimNext({
  ownerId: 'worker-1', now: memoryNow,
  leaseUntil: '2026-10-10T00:00:30.000Z', maxAttempts: 2,
});
expect(claim?.request.sourceRunId).toBe('historical-run-1');
if (claim === null) throw new Error('fixture job was not enqueued');
const saved = await writes.completeCapture({ claim, candidate: memoryCase(), now: memoryNow, events: [] });
expect(saved.status).toBe('observation');
expect(await queries.get(saved.id, simulationMemoryScope())).toEqual(saved);
```

测试 setup 先以 `DurableTransitionUnitOfWork.commit` 放入 complete context 与 MemoryCaptureIntent；使用现有 SQLite fixture 的临时目录、Clock 和 cleanup 模式，不在真实 agent.sqlite 写测试记录。

- [ ] Step 2：运行 `pnpm exec vitest run test/diagnostic-memory-store.test.ts test/memory-transition-atomicity.test.ts --maxWorkers=2`，记录缺少行为的红结果。
- [ ] Step 3：添加 Spec §5 表和索引；v5 升级前验证 FTS5，失败不启动迁移并保留原库，不能假称关闭功能可以跳过迁移要求。无需额外模型文件。CAS 更新最小 SQL：

```sql
UPDATE diagnostic_memory_cases
SET revision = revision + 1, status = @status, case_json = @caseJson
WHERE id = @id AND scope_key = @scopeKey AND revision = @expectedRevision;
```

受影响行数非 1 返回 MEMORY_REVISION_CONFLICT；审核请求唯一键比较 command_digest；索引插入/删除、review、outbox 全部在同一 immediate transaction。

- [ ] Step 4：扩展 commit 的可选 memoryCapture；处理 effects 只筛 kind=memory_signal、验证当前 memory scope/root、使用唯一键去重，保留 audit/checkpoint 原路径。Job 饱和只写 rejectedEvent；首次入队写 scheduledEvent 并保存 failedEvent 模板，重复入队不重复 schedule。Job 操作验证 sourceRunId/scope 与当前已完成状态，不能伪造与别的 Run 绑定的 request。
- [ ] Step 5：加入 v4→v5 迁移、重复迁移、数据库重开、outbox 写故障 rollback、Job 容量、lease 过期 fencing、保留审核记录的 prune 测试。索引损坏与 case_json 损坏不得返回可批准/可召回记录。内存 durable 与 memory 使用同一事务工作副本，提交失败不修改任一真实 Map；不能分别调用两个内存 Store 后声称原子。运行 T2 新测和 `test/sqlite-durable-state.test.ts`、`test/durable-event-outbox-contract.test.ts`、`test/durable-outbox-dispatcher.test.ts`。
- [ ] Step 6：提交明确文件，commit message：`feat(memory): persist cases jobs and hook signals atomically`。

## Task 3：确定性案例生成与有界 Worker

**Files**

- Create: `src/memory/case-builder.ts`, `src/memory/capture-worker.ts`, `src/infrastructure/sqlite/memory-capture-source.ts`, `test/memory-case-builder.test.ts`, `test/memory-capture-worker.test.ts`。
- Modify: `src/contracts/diagnostic-memory.ts`, `src/memory/index.ts`, `src/infrastructure/sqlite/persistence-bundle.ts`。

**Interfaces**

- Consumes: `MemoryCaptureSource.load(request, operation)`、`MemoryWriteUnitOfWork.claimNext/completeCapture/failCapture`。
- Produces: `buildMemoryCase(request: MemoryCaptureRequest, source: Awaited<ReturnType<MemoryCaptureSource['load']>>, now: string): DiagnosticMemoryCase`。
- Produces: `MemoryCaptureWorker` constructor `{ source: MemoryCaptureSource; writes: MemoryWriteUnitOfWork; clock: Clock; ownerId: string; events: MemoryEventFactory; dispatch: () => Promise<void> }`；`drain(input: { limit: number; signal?: AbortSignal }): Promise<{ completed: number; failed: number; pending: boolean }>`。
- Produces: `MemoryEventFactory.create<T extends AgentEventTypeV2>(type: T, runId: string, payload: AgentEventPayloadMap[T]): PendingAgentEventV2<T>`。这是注入的小适配器，bootstrap 复用现有 V2 factory，固定 audit/durable/correlation，不能另建事件源。
- Produces: `SqliteMemoryCaptureSource implements MemoryCaptureSource`，构造参数 `{ database: SqliteDatabase; queries: InspectionQueryService }`。受信的必需数据源清单随 Spec MemoryCaptureRequest.requiredSources 传入并持久化，不允许客户端覆盖。

- [ ] Step 1：builder 红测试覆盖实际报告、missing required evidence、partial、错窗口/所有权/哈希、敏感内容、oversize、无模拟标签。测试建立 completed source context 和实际 refs；expected oracle 必须只在断言 fixture 中，不能传给 builder。

```ts
const built = buildMemoryCase(request, {
  context: completedContext, evidenceRefs: memoryCase().evidenceRefs,
  requiredEvidenceComplete: false, limitations: ['REQUIRED_METRIC_MISSING'],
}, memoryNow);
expect(built.status).toBe('observation');
expect(built.quality).toBe('insufficient');
expect(built.eligibleForPromotion).toBe(false);
expect(built.diagnosisOnly).toBe(true);
```

`request` 的 schema 是 Spec MemoryCaptureRequest；`completedContext` 在测试内按 `test/sqlite-durable-state.test.ts` 的 context fixture 创建、status=completed，末条 assistant text 为有界诊断。不能把 sourceRootCause 当最终消息。

- [ ] Step 2：运行 `pnpm exec vitest run test/memory-case-builder.test.ts test/memory-capture-worker.test.ts --maxWorkers=2` 看红。
- [ ] Step 3：builder 只提取最后诊断消息的白名单段落、明确症状 code、已验证 refs 和 limitations；先安全裁剪再 digest。固定 observation/revision=1、30 天有效期；simulation 固定 promotion=false，live 的 observation 也为 false，批准后才计算 live eligibility。

```ts
const quality: MemoryQuality = source.requiredEvidenceComplete
  && source.evidenceRefs.length > 0 ? 'sufficient' : 'insufficient';
const validUntil = new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1000).toISOString();
```

最终生成前再次 strict schema parse；安全清洗失败使用 failed，不伪造“已脱敏”。源码读取先检查 checkpoint_json 字节，超过 1 MiB 拒绝；证据查询只选元数据，校验 parent-child 归属，不读取 raw_json。

- [ ] Step 4：Worker 实现 MemoryCaptureWorkerPort，包括 close 停止接受新批次/等待当前批次；每次最多 50 个 claim、最多 2 次尝试。claimNext 事务有界回收过期 running：未到限回 pending，到限标记 failed 并用该 Job 的持久化失败 event 模板登记固定事件；enqueue 保存模板，不能永久卡在 running。claim 携带 owner/attempt，事务完成后 dispatch outbox。真正 Abort 保留可恢复 Job 并传播；普通生成失败写固定错误，不追加模型调用。加入 process 关闭重开、crash-after-candidate、stale owner 提交拒绝、dispatch 失败后 outbox 重放、两次 crash 后失败、零模型 HTTP 测试。
- [ ] Step 5：运行 T3 新测试及 T2 事务测试，确认幂等与不含原始日志/密钥。提交：`feat(memory): build bounded diagnostic observations without extra model calls`。

## Task 4：人工审核、撤销和审批幂等

**Files**

- Create: `src/memory/review-service.ts`, `test/memory-review-service.test.ts`。
- Modify: `src/contracts/diagnostic-memory.ts`, `src/memory/index.ts`。

**Interfaces**

- Consumes: `MemoryQueryStore.get/findReviewResult`、`MemoryWriteUnitOfWork.review`、T3 `MemoryEventFactory`。
- Produces: `MemoryEvidenceValidator.validate(input: { sourceRunId: string; refs: readonly HistoricalEvidenceRef[]; scope: MemoryScope }, operation: MemoryOperation): Promise<boolean>`。
- Produces: `MemoryReviewService` constructor `{ queries: MemoryQueryStore; writes: MemoryWriteUnitOfWork; evidence: MemoryEvidenceValidator; events: MemoryEventFactory; dispatch: () => Promise<void> }`；`review(command: MemoryReviewCommand, operation: MemoryOperation): Promise<DiagnosticMemoryCase>`。

- [ ] Step 1：以下红测试配合可控的 evidence validator fake；再覆盖 supported false、insufficient、过期、无证据、错误 scope、observation→approved、approved→rejected、rejected 再批准、CAS 冲突和相同 requestId 返回原结果。

```ts
await expect(reviewService.review({
  memoryId: 'memory-1', scope: simulationMemoryScope(), expectedRevision: 1,
  requestId: 'review-1', decision: 'approved', claimCheck: 'supported',
  actorId: 'local-operator', reviewedAt: memoryNow,
}, { now: memoryNow, deadlineMs: Date.parse(memoryNow) + 1000 }))
  .rejects.toMatchObject({ code: 'MEMORY_EVIDENCE_UNAVAILABLE' });
```

setup 以 T2 Job/completeCapture 插入 observation；validator fake 明确返回 false，service 用已声明 constructor 注入。不能靠直接修改 SQL status 跳过本任务的主路径测试。

- [ ] Step 2：运行 `pnpm exec vitest run test/memory-review-service.test.ts --maxWorkers=2` 看红。
- [ ] Step 3：先验证完整 scope、revision、状态、有效期与质量，再读取证据；生产 approved=true eligibility 的判断最小规则：

```ts
const eligibleForPromotion = command.decision === 'approved'
  && candidate.scope.dataClass === 'live'
  && candidate.quality === 'sufficient';
```

此变量仅在 scope、期限、证据、claimCheck 全部通过后计算，不能直接暴露为客户端开关。review Store transaction 仍复核条件和 revision；service 在证据查询前调用 findReviewResult，忽略宿主 reviewedAt 的变化，匹配已有 requestId/command_digest 后返回 review 中存入的原结果，不能因已到 approved 或其后撤销而错误拒绝合法重放。新 review 再走全部检查。

- [ ] Step 4：同事务写 EXPERIENCE_REVIEWED / MEMORY_UPDATE_COMPLETED；故障注入确认无半审核、不漏 actor/prompt。验证撤销移除 FTS、重开仍 rejected、模拟 approved promotion=false。运行 T4/T2 测试并提交：`feat(memory): add evidence-gated review and revocation`。

## Task 5：中文检索、有界召回与冻结选择

**Files**

- Create: `src/memory/chinese-tokenizer.ts`, `src/memory/bounded-recall.ts`, `test/memory-tokenizer.test.ts`, `test/memory-recall.test.ts`。
- Modify: `src/memory/index.ts`, `src/infrastructure/sqlite/diagnostic-memory-store.ts`, `src/memory/in-memory-diagnostic-memory.ts`。

**Interfaces**

- Consumes: `MemoryQueryStore.search/revalidate`、T4 `MemoryEvidenceValidator`。
- Produces: `tokenizeMemoryText(text: string): readonly string[]`；`buildMemoryMatchQuery(text: string): string | null`；`BoundedMemoryRecall implements MemoryRecallPort`，constructor `{ queries: MemoryQueryStore; evidence: MemoryEvidenceValidator; maxHints?: number; maxBytes?: number; maxTokens?: number }`。

- [ ] Step 1：分词红测试如下；召回红测试建立 3 个 scope、observation/rejected/approved、不同 revision/target/dataset、时间与源 Run；只允许当前完整 scope 的 approved sufficient 命中。

```ts
import { expect, it } from 'vitest';
import { tokenizeMemoryText } from '../src/memory/chinese-tokenizer.js';
it('indexes adjacent Chinese characters rather than whitespace only', () => {
  expect(tokenizeMemoryText('连接池 timeout')).toEqual(['连接', '接池', 'timeout']);
});
```

- [ ] Step 2：运行 `pnpm exec vitest run test/memory-tokenizer.test.ts test/memory-recall.test.ts --maxWorkers=2` 看红。
- [ ] Step 3：使用 Unicode code point 数组取中文 bigram，英文 NFKC/lowercase 后筛合法 token；禁止把用户 OR/NEAR/引号作为 FTS 语法。MATCH 用绑定的 quoted tokens OR 连接。SQL 范围条件完整在 WHERE 中：

```sql
SELECT c.case_json, bm25(diagnostic_memory_case_fts) AS rank
FROM diagnostic_memory_case_fts
JOIN diagnostic_memory_cases c ON c.id = diagnostic_memory_case_fts.memory_id
WHERE diagnostic_memory_case_fts MATCH @match
  AND c.scope_key = @scopeKey
  AND c.status = 'approved' AND c.quality = 'sufficient'
  AND c.valid_until > @now
  AND c.source_run_id NOT IN (SELECT value FROM json_each(@excludedRunIds))
ORDER BY rank ASC, c.captured_at DESC, c.id ASC
LIMIT @limit;
```

@excludedRunIds 为有界 JSON 参数，不拼 SQL；返回前 strict parse 和完整 scope 再核验。内存端用同样 tokenizer/BM25 词频公式和 tie-break，共享 fixture 验证；不把简单 substring 伪称 BM25。

- [ ] Step 4：首次查询包含 runId 排除，保存 selections；后续只 revalidate selections，不重新 search。撤销、过期、digest/revision 改动、证据缺失删除 active hint；lookup 抛错返回 unavailable/空 hints，signal aborted 则传播。
- [ ] Step 5：测试 budget/token cap、空 query、混合语言、UTF-8、安全 MATCH、当前 Run/holdout 库排除、上限、tie-break、无跨库假数据；运行 T5 + T2/T4 测试，提交：`feat(memory): add scoped Chinese lexical recall and bounded snapshots`。

## Task 6：Harness、Renderer 与重启复核

**Files**

- Create: `src/memory/hint-renderer.ts`, `src/memory/capture-intent.ts`, `test/memory-harness.test.ts`, `test/memory-harness-recovery.test.ts`。
- Modify: `src/agent/agent-harness.ts`, `src/agent/types.ts`, `src/application/create-runtime.ts`, `src/memory/index.ts`。
- Test: `test/agent-harness-async-generator.test.ts`, `test/model-harness-contract.test.ts`, `test/context-compression-recovery.test.ts`, `test/trusted-run-context.test.ts`。

**Interfaces**

- Consumes: `MemoryRecallPort.prepare(input, operation)`、`MemoryHintRenderer.render(state, operation)`。
- Produces: AgentHarnessDependencies 可选 `memory?: { recall: MemoryRecallPort; renderer: MemoryHintRenderer; requiredSources: readonly HistoricalEvidenceRef['source'][]; modelWindowTokens: number; reservedOutputTokens: number }`。
- Produces: `AgentRuntimeOptions.memoryHarness?: { recall: MemoryRecallPort; renderer: MemoryHintRenderer; requiredSources: readonly HistoricalEvidenceRef['source'][]; modelWindowTokens: number; reservedOutputTokens: number }`，仅供受信宿主/单测注入；不在 application 组装具体实现。
- Produces: `BoundedMemoryHintRenderer implements MemoryHintRenderer`，constructor `{ maxBytes?: number; maxTokens?: number }`。
- Produces: `createMemoryCaptureIntent(context: AgentContext, input: { candidateId: string; now: string; requiredSources: readonly HistoricalEvidenceRef['source'][]; events: MemoryEventFactory }): MemoryCaptureIntent | null`，仅有 memory scope 的 completed 父 Run 返回 intent。

- [ ] Step 1：红测试以捕获 `ChatModel.stream(messages, tools, options)` 的第一个参数的 ScriptedModel fake 验证尾部历史提示、stable system、tool schema 不变、context.messages 未新增临时消息、当前 evidenceIds 无历史引用；关闭时 model 输入 byte-for-byte 与旧测试 fixture 一致。

```ts
const rendered = renderer.render(state, { now: memoryNow,
  deadlineMs: Date.parse(memoryNow) + 1000, availableMemoryTokens: 1024 });
expect(rendered?.role).toBe('user');
expect(JSON.stringify(rendered)).toContain('historical-run-1');
expect(JSON.stringify(rendered)).toContain('历史案例');
expect(context.evidenceIds).not.toContain('evidence-1');
```

测试 state 含从 T5 approved case 生成的 hints；renderer 实例用上方 constructor 创建。harness 集成测试使用 `createAgentRuntime` 现有 ScriptedModel 模式，只注入抽象 memory ports。

- [ ] Step 2：运行 T6 三类测试（新 memory、已有 generator/model contract、compression recovery）看红。
- [ ] Step 3：createContext 只在 ports+trusted scope 合法时建立初始 memory state。在现有 mainLoop Pre-reasoning 调用 prepare，不把 recall 放进 Tool/Hooks。模型输入接线的局部实现：

```ts
const historical = context.memory === undefined || this.dependencies.memory === undefined
  ? null : this.dependencies.memory.renderer.render(context.memory, operation);
const modelMessages = historical === null
  ? context.messages : [...context.messages, historical];
```

`operation` 由注入 Clock/Run deadline/signal 创建，availableMemoryTokens 根据已压缩基础消息和工具 schema 的保守字节/token 上界，扣去 configured reservedOutputTokens 后计算。Renderer 未获该值或剩余量≤0返回 null；测试包含压缩前后、工具 schema 变化和无窗口配置的边界。`modelMessages` 只传当前 reasonStream 调用，不赋回 context.messages；临时 ID 与 selection 内容 digest 稳定关联。

- [ ] Step 4：记忆 retrieval facts 和状态通过 publishTransitionV2 保存，保留原 V1 yield 顺序。正常 RUN_FINISHED 事务新增 capture intent；paused/failed/cancelled 和没有 trustedMemoryScope 的子 Run 不入队。父 scope 不自动继承给 source child。
- [ ] Step 5：恢复测试暂停后关闭重开，撤销案例/删除历史证据，再 resume：预算与当前工具幂等不重置，hint 移除，未 approved 永不注入。消费者 `.return()` 与 Abort 不留下正向案例；记忆服务超时/失败不额外调用模型。提交：`feat(memory): integrate checkpointed historical hints without changing agent control flow`。

## Task 7：Bootstrap、宿主范围、查询/审核 API

**Files**

- Create: `src/bootstrap/diagnostic-memory.ts`, `src/application/memory-query-service.ts`, `src/api/memory-routes.ts`, `test/memory-api.test.ts`, `test/memory-runtime.test.ts`。
- Modify: `src/application/create-runtime.ts`, `src/application/run-execution-coordinator.ts`, `src/bootstrap/inspection-runtime.ts`, `src/bootstrap/agent-web-runtime.ts`, `src/api/http-server.ts`, `apps/agent-server/index.mjs`。

**Interfaces**

- Consumes: T2/T3 bundle.memory、T3 Worker/EventFactory/MemoryCaptureSource、T4 ReviewService、T5 Recall、T6 Renderer/capture intent。
- Produces: `DiagnosticMemoryConfig = { enabled: false } | { enabled: true; scopes: readonly MemoryScope[]; requiredSources: readonly HistoricalEvidenceRef['source'][]; modelWindowTokens: number; reservedOutputTokens: number }`。
- Produces: `RuntimeMemoryAssemblyPorts { queries: MemoryQueryStore; writes: MemoryWriteUnitOfWork; captureSource: MemoryCaptureSource; evidenceQueries: InspectionQueryService; checkpoints: VersionedCheckpointStore; clock: Clock; ids: IdGenerator; events: MemoryEventFactory; dispatch: () => Promise<void> }`，置于 contracts，类型只依赖其他 contracts。
- Produces: `createDiagnosticMemoryRuntime(input: { config: DiagnosticMemoryConfig; ports: RuntimeMemoryAssemblyPorts }): DiagnosticMemoryRuntime | undefined`。
- Produces: `AgentRuntimeOptions.memoryFactory?: (ports: RuntimeMemoryAssemblyPorts) => DiagnosticMemoryRuntime`。现有 create-runtime 在 persistence/queries/V2 outbox 建立后、Harness 构造前调用宿主 factory，bootstrapping 不需要再次打开 DB。与 memoryHarness 同时提供时报配置错误；子 Run 默认不传 factory。
- Produces: 返回 Spec 定义的 `DiagnosticMemoryRuntime`，窗口属性 modelWindowTokens/reservedOutputTokens 与 T6 保持一致；worker/reviews/queries 分别面向 MemoryCaptureWorkerPort/MemoryReviewPort/MemoryReadServicePort，不让 application 引入具体 bootstrap/SQLite 类。
- Produces: `MemoryQueryService implements MemoryReadServicePort`，准确方法见 Spec；`MemoryReviewService implements MemoryReviewPort`，构造签名见 T4；实现的类型依赖为 contracts，不跨层依赖反向实现。
- Produces: Coordinator 可选 `afterTerminal?: (runId: string) => Promise<void>`，是显式 Worker 调度，不改变 terminal status。

- [ ] Step 1：API 红测试覆盖关闭 capabilities、开启列表/详情/审核、400/404/409/422/503、Host/Origin、body 大小和未知字段；重点外部 payload 不能指定 trustedMemoryScope、memory、actorId、eligibleForPromotion 或 raw。

```ts
const response = await fetch(`${url}/memory/cases/memory-1/review`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: allowedOrigin },
  body: JSON.stringify({ profileId: 'simulation', requestId: 'review-1',
    expectedRevision: 1, decision: 'approved', claimCheck: 'supported', actorId: 'forged' }),
});
expect(response.status).toBe(400);
```

url/allowedOrigin 从该文件启动本地 fixture 取得；approved 完整正例无 actorId，期望服务收到固定 local-operator。

- [ ] Step 2：运行 `pnpm exec vitest run test/memory-api.test.ts test/memory-runtime.test.ts --maxWorkers=2` 看红。
- [ ] Step 3：实现 config 显式开关 `AGENTOPS_MEMORY_ENABLED=1`，scope 来自配置文件 `AGENTOPS_MEMORY_CONFIG` 的绝对路径，文件 schema 验证且无密钥/端点。modelWindowTokens/reservedOutputTokens 按 Spec 验证，不猜供应商窗口；默认 false，非法启用配置报固定错误，不从环境中的 model/MCP URL 推断 scope。

```ts
const trustedMemoryScope = config.enabled
  ? config.scopes.find((scope) => scope.profileId === options.profileId)
  : undefined;
```

同一 profileId 一期只允许一个完整 scope，否则配置错误，不能随意取 first。同步 prepareStart 追加此宿主属性，异步 recall 保留在 Harness；旧 simulation system context 准备不被替换。

- [ ] Step 4：Concrete memory 组装全部在 bootstrap；application/create-runtime 复用现有 toolFactories 的 late-binding 模式调用 memoryFactory，输入为已经建立的稳定 ports，不把 SqliteDatabase 暴露给核心。SqlitePersistenceBundle.memory.captureSource 使用同一 database，bootstrap 只组合服务。证据 validator 不因公共 retrievable=false 判定引用缺失，而是检查受控记录/Manifest 的状态、哈希、归属和有效期。runtime.ready 后显式 drain 最多50 Job；Coordinator 完成后 bounded drain，失败产生安全日志/outbox，不反转已经提交的 Run 状态。关闭时 await worker 当前批次，禁止 close DB 后写入。
- [ ] Step 5：路由严格绑定宿主 scope 与 actor/time；GET Run只返回经安全投影的 active hint DTO，不返回 AgentContext 其他数据。现有 public visibility 不扩张，加入 SSE/Audit/LangSmith 白名单负向测试。配置 disabled 时既有 smoke runtime 和 HTTP 语义不变。运行新测及 `test/agent-web-runtime.test.ts`、`test/run-execution-coordinator.test.ts`、`test/trusted-run-context.test.ts`，提交：`feat(memory): wire opt-in local memory queries and reviewed commands`。

## Task 8：前端历史参考与案例审核

**Files**

- Create: `apps/agent-web/src/components/MemoryPanel.tsx`, `test/memory-web-view.test.ts`, `test/e2e/memory-web.spec.ts`, `test/e2e/memory-fixture-server.mjs`, `playwright.memory.config.ts`。
- Modify: `apps/agent-web/src/App.tsx`, `apps/agent-web/src/api/client.ts`, `apps/agent-web/src/api/types.ts`, `apps/agent-web/src/styles.css`；不新建平行客户端。

**Interfaces**

- Consumes: Spec §8.2 endpoints；原 evidence 摘要接口不改变。
- Produces: client `memoryCapabilities(): Promise<{ enabled: boolean; kind: 'episodic'; reviewMode: 'local_operator' }>`；`listMemoryCases(profileId: string, input: { status?: MemoryStatus; afterId?: string; limit: number }): Promise<readonly DiagnosticMemoryCase[]>`；`getRunMemory(runId: string): Promise<RunMemoryState | null>`；`reviewMemory(id: string, command: { profileId: string; requestId: string; expectedRevision: number; decision: 'approved' | 'rejected'; claimCheck: 'supported' | 'unsupported' }): Promise<DiagnosticMemoryCase>`；命令不含 trusted actor/scope。
- Produces: `MemoryPanel` props `{ profileId: string; runId?: string }`；caps disabled 不显示新增交互，空/暂不可用明确文案。

- [ ] Step 1：状态/客户端红测试覆盖 observation、approved、rejected、insufficient、simulation、expired、409刷新、不重复请求、禁用批准；E2E 的断言入口：

```ts
await expect(page.getByText('仅模拟环境可用，不可晋级')).toBeVisible();
await page.getByRole('button', { name: '批准历史参考' }).click();
await expect(page.getByText('已批准')).toBeVisible();
await page.getByRole('button', { name: '撤销历史参考' }).click();
await expect(page.getByText('已拒绝')).toBeVisible();
```

fixture 启动内存/独立 SQLite memory API，只用 ScriptedModel；按钮仅在后端 sufficient+有效引用案例可用，操作前显示复核声明支持性的确认项。

- [ ] Step 2：运行 `pnpm exec vitest run test/memory-web-view.test.ts test/web-api-client.test.ts --maxWorkers=2` 和 `pnpm exec playwright test --config playwright.memory.config.ts` 看红。
- [ ] Step 3：展示有界 summary、sourceRunId、历史 evidence 引用、quality/expiry/状态和模拟徽标；列表/详情不显示 raw，点击证据沿用当前摘要与引用页面。提交审核时生成 requestId，带 expectedRevision；409刷新并请用户重新复核，不自动 approve 新版本。

```ts
const command = { profileId, expectedRevision: item.revision, requestId,
  decision: 'approved' as const, claimCheck: 'supported' as const };
await client.reviewMemory(item.id, command);
```

`item` 来自安全 DTO；requestId 在用户发起一次操作时生成并保留至该请求结束，不每次网络重试生成新值。

- [ ] Step 4：浏览器完整案例“首轮 observation → 人工批准 → 第二轮历史参考 → 撤销 → 第三轮不再召回”；再测刷新/重启显示、低质量禁止、冲突/Unavailable、引用跳转、关闭记忆旧页面。只合并 App/client/styles 的本任务 hunks，保留已有熔断改动。提交：`feat(web): show governed historical memory and local review`。

## Task 9：离线联合验收、基线防回归与文档收口

**Files**

- Create: `apps/acceptance/memory.mjs`, `test/memory-acceptance.integration.test.ts`, `docs/guides/diagnostic-memory-local.md`, `docs/verification/2026-10-10-diagnostic-memory-plan-review.md`（实施记录时应另记实际执行日期，不把计划日期当测试日期）。
- Modify: `package.json`（只追加 acceptance:memory）、`docs/README.md`, `docs/architecture/07-context-memory-storage.md`, `docs/implementation-status.md`。
- Test: `test/acceptance-scripted.integration.test.ts`, `test/acceptance-runtime-contract.integration.test.ts`, `test/real-model-acceptance-runner.test.ts` 及现有 circuit、recovery、event/public projection 测试。

**Interfaces**

- Consumes: 完整 opt-in runtime 和 reviewer commands。
- Produces: `pnpm acceptance:memory` 执行 build + `apps/acceptance/memory.mjs`；默认只创建独立临时库，输出脱敏 JSON `{ status, checks, modelRequestsSent: 0, externalRequestsSent: 0 }`，任一确定性检查失败 exit 1。

- [ ] Step 1：联验红测试运行两个合法模拟 scope 和一个 live 负向 scope，检查完整 Capture→Approve→Recall→Restart→Revoke 流程、oracle 泄漏负例、无权输入、事件配对和原始数据边界。用请求 spy 断言 externalRequestsSent=0，不仅相信脚本自行声明。

```ts
expect(result.checks.captureOnce).toBe(true);
expect(result.checks.approvedOnly).toBe(true);
expect(result.checks.scopeIsolation).toBe(true);
expect(result.checks.resumeRevalidation).toBe(true);
expect(result.checks.noRawPublicData).toBe(true);
expect(result.modelRequestsSent).toBe(0);
expect(result.externalRequestsSent).toBe(0);
```

`result` 是本脚本返回/测试捕获的 JSON；checks schema固定，还要包括 transactionRollback、staleWorkerRejected、noOracleLeak、disabledBaseline。

- [ ] Step 2：运行 `pnpm exec vitest run test/memory-acceptance.integration.test.ts --maxWorkers=2` 看红。
- [ ] Step 3：脚本显式禁用真实 model/LangSmith/export，注入 ScriptedModel、受控内存遥测 Tool 和独立 scoped stores；不使用用户现有 acceptance 数据库。review 用明确的 supported 标记，只评价 fixture 声明，不宣传模型准确率。

```json
"acceptance:memory": "pnpm build && node apps/acceptance/memory.mjs"
```

检索 fixture 至少覆盖中文/英文、同词错scope、同分排序、过期、版本变化、缺证、操作符输入、无匹配 12 种查询；输出 deterministic ranking 断言，不写未经评测的百分比。

- [ ] Step 4：先运行 memory 全部单元、API和联验；再运行 `pnpm exec playwright test --config playwright.memory.config.ts`、`pnpm e2e:circuit`（原确定性 circuit Web E2E）；最后 `pnpm lint`、`pnpm typecheck`、`pnpm test -- --maxWorkers=2`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build`。失败按首次失败定位，不自动付费烟测。
- [ ] Step 5：对无记忆真实烟测做本地契约回归：配置 disabled、模型输入前缀/工具 schema、请求预算、required evidence、token usage/trace 安全字段不变。只能说 scripted 基线通过；联网 DeepSeek/LangSmith 再验收需另行授权，不把本期离线测试说成真实模型通过。
- [ ] Step 6：写本地操作指南、资源/保留限制、数据备份与回退边界，更新实现状态为已实现/未验证的准确条目；记录测试数量、命令/退出码、环境与未验证项。运行 `git diff --check`，审查依赖方向和所有数据出口。提交：`test(memory): verify isolated review recall and restart workflow`。

## 执行检查点与实施完成定义

每个任务执行 TDD + Spec review + code-quality review 后，才允许下一个依赖任务修改它的公共入口。T1/T2、T6、T7 分别是契约/持久化、主循环兼容、对外权限三个强制检查点。

完成必须包含：case 持久化与审核、查询隔离、冻结召回与恢复、前端操作、事务故障测试、默认关闭基线和离线联验；只新增接口或 events 枚举不能算完成。

本期明确不覆盖：向量语义提升、真实业务数据效果、生产远程权限、多租户、Procedural 自动晋级/自动动作、跨 Worker Run 调度。不得以“框架有接口”宣称这些能力已经可上线。

## 计划自检覆盖表

| Spec 要求 | 任务 |
|---|---|
| §2 四类记忆边界、默认关闭 | T1/T7/T9 |
| §3 小端口、bootstrap 依赖 | T1/T3/T4/T5/T6/T7 |
| §4 scope、模拟隔离、质量 | T1/T3/T4/T5/T9 |
| §5 原子信号/Job/候选、lease、资源/维护 | T2/T3/T6/T7 |
| §6 审核、CAS、撤销/幂等 | T2/T4/T7/T8 |
| §7 中文排名、预算、状态冻结、模型视图 | T5/T6 |
| §8 安全、事件、API、UI | T3/T4/T6/T7/T8/T9 |
| §9 兼容/迁移/回退 | T1/T2/T7/T9 |
| §10 联验、无付费调用、效果边界 | T9 |

计划交付时尚未执行任何任务。实施时使用本工作树，逐任务小步提交；未经明确请求，不把既有未提交修改或新提交一并推送远端。
