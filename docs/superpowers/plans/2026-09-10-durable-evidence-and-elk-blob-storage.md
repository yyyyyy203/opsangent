# Durable Evidence and ELK Blob Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在单机 SQLite 运行时中实现可恢复 Run、可审计小型 Evidence，并在其上提供支持几十 MiB 日志的本地 BlobStore 与受控流式证据摄取能力。

**Architecture:** SQLite 是 Checkpoint、执行日志、内联指标证据和大证据 Manifest 的控制面；本地文件 BlobStore 保存独立压缩 chunk。Harness、Tool 和 Subagent 只依赖 contracts 中的小接口，所有具体 SQLite、文件系统与 ELK 分页适配器在 bootstrap/infrastructure 组装。真实 ELK、生产对象存储、KMS 加密和远程部署不在本计划内；以可注入分页来源和 64 MiB 生成式日志 fixture 验证相同边界。

**Tech Stack:** TypeScript 5.9 strict、Node.js 20、pnpm、better-sqlite3、Node `fs/promises` 和 `zlib`、Zod、Vitest。

**Spec:**
- `docs/superpowers/specs/2026-09-10-durable-run-state-evidence-design.md`
- `docs/superpowers/specs/2026-09-10-elk-large-evidence-blob-storage-design.md`

## Global Constraints

- 保留已发布的 `CheckpointStore`、`EvidenceStore`、Event/Message V2 和 ToolResponse 语义；新增能力使用独立可选接口或兼容适配器。
- `agent/`、`tool/` 和 `application/` 不导入 `better-sqlite3`、`fs/promises`、ELK/MCP SDK 或具体 Blob 实现。
- 时间、ID、哈希、路径和大小预算均通过构造器注入；禁止 Run 级全局可变状态和 `process.cwd()`。
- 原始 Evidence、完整 Tool 输入、Blob 路径、查询 DSL、凭证、Cookie、Token、内部地址不得进入 Message、公共 Event、SSE 或 LangSmith。
- SQLite 继续启用 WAL、foreign keys、5 秒 busy timeout 和 immediate transaction；Schema 只追加 migration。
- `RUN_PAUSED` 前必须成功保存可恢复 Checkpoint；动作的 `prepared` 状态不得盲目重放。
- MCP HTTP 传输上限维持 1 MiB；ELK 分页目标上限 512 KiB，不能通过放大 ToolResult 传输原始日志。
- 默认预算：内联指标 Evidence 1 MiB、Blob chunk 4 MiB 未压缩、单次 capture 64 MiB、单 Run 256 MiB、摘要 16 KiB、样本 20 条且每条 2 KiB；均可由 bootstrap/Profile 覆盖。

---

## File map

| 文件 | 职责 |
|---|---|
| `src/contracts/storage.ts` | 版本化 Checkpoint、执行日志、Evidence 查询、Blob/流式 Evidence 的稳定接口 |
| `src/contracts/context.ts` / `src/contracts/tool.ts` | 可选 pending batch、Tool recoveryPolicy、toolCallId 兼容字段 |
| `src/storage/durable-codec.ts` | 纯 Zod/哈希/规范化 JSON 编解码与安全错误 |
| `src/storage/in-memory-*.ts` | 内存合同实现，供所有持久化语义测试复用 |
| `src/infrastructure/sqlite/durable-*.ts` | SQLite Checkpoint、Evidence、Journal、UoW 与 bundle 实现 |
| `src/application/evidence-recorder.ts` | 唯一的内联 Evidence 写入 + V2 事件应用服务 |
| `src/agent/*` / `src/tool/*` | Pending batch、每分支持久化、恢复策略和动作不确定状态 |
| `src/infrastructure/blob/local-evidence-blob-store.ts` | 临时文件、chunk 哈希、原子发布与受控读取 |
| `src/application/streaming-evidence-recorder.ts` | 页式大证据摄取、预算、摘要、Manifest 提交 |
| `src/infrastructure/elk/paged-evidence-source.ts` | MCP/ELK 页式来源的无 SDK 核心适配器 |
| `src/bootstrap/log-evidence-tools.ts` | `logs.capture/search/aggregate/read_slice` 的受控 Tool 组装 |

## Task 1: Durable contracts and deterministic codecs

**Files:**
- Modify: `src/contracts/storage.ts`, `src/contracts/context.ts`, `src/contracts/tool.ts`, `src/contracts/index.ts`
- Create: `src/storage/durable-codec.ts`
- Test: `test/durable-contracts.test.ts`

**Interfaces:**
- Produces `StoredRunCheckpoint`, `VersionedCheckpointStore`, `ToolExecutionJournal`, `AgentStateUnitOfWork`, `EvidenceQueryStore`, `CheckpointConflictError`, `StoredDataCorruptionError` mapping helpers, `PendingToolBatch`, `Tool.recoveryPolicy` and optional `ToolCallOptions.toolCallId`.
- Consumed by every later persistence, Harness and Blob task.

- [ ] **Step 1: Write failing contract tests**

```ts
it('creates a stable checksum for semantically identical checkpoint JSON', () => {
  expect(checkpointChecksum({ b: 2, a: 1 })).toBe(checkpointChecksum({ a: 1, b: 2 }));
});

it('rejects a pending batch whose completed result is not one of its calls', () => {
  expect(() => parsePendingToolBatch({
    batchId: 'batch-1', stepId: 'step-1',
    calls: [{ id: 'call-a', name: 'metrics.query', input: {} }],
    completedResults: [{ toolCallId: 'call-b', toolName: 'metrics.query', status: 'success', startedAt: '2026-09-10T00:00:00.000Z' }],
    state: 'executing', createdAt: '2026-09-10T00:00:00.000Z',
  })).toThrow();
});
```

- [ ] **Step 2: Run RED verification**

Run: `pnpm vitest run test/durable-contracts.test.ts`

Expected: failure because durable contracts/codecs are not exported.

- [ ] **Step 3: Add minimal strict contracts and codecs**

```ts
export interface VersionedCheckpointStore {
  load(runId: string): Promise<StoredRunCheckpoint | null>;
  save(context: AgentContext, expectedRevision: number | null): Promise<StoredRunCheckpoint>;
}

export interface PendingToolBatch {
  batchId: string;
  stepId: string;
  calls: ToolCall[];
  completedResults: ToolExecutionResult[];
  state: 'admitted' | 'executing' | 'awaiting_confirmation' | 'awaiting_external';
  createdAt: string;
}
```

Use canonical key ordering for checksum input, validate JSON-safe data with Zod, retain legacy fields as optional/compatible, and use `STORAGE_ERROR` plus safe `details.category` at the public boundary rather than a new public error code.

- [ ] **Step 4: Run GREEN verification**

Run: `pnpm vitest run test/durable-contracts.test.ts`

Expected: all new contract tests pass.

- [x] **Step 5: Commit**

```bash
git add src/contracts src/storage/durable-codec.ts test/durable-contracts.test.ts
git commit -m "feat: add durable state contracts"
```

## Task 2: In-memory durable-state conformance

**Files:**
- Modify: `src/storage/in-memory-checkpoint-store.ts`, `src/storage/in-memory-evidence-store.ts`
- Create: `src/storage/in-memory-durable-state.ts`, `test/durable-state-contract.test.ts`
- Test: `test/durable-state-contract.test.ts`

**Interfaces:**
- Consumes Task 1 contracts.
- Produces memory implementations of versioned Checkpoint, Evidence query, Journal and UoW semantics for SQLite conformance tests.

- [ ] **Step 1: Write failing conformance tests**

```ts
it('rejects a stale checkpoint revision without overwriting the newer context', async () => {
  const first = await store.save(context('run-1'), null);
  await store.save({ ...first.context, stage: 'hypothesis' }, first.revision);
  await expect(store.save({ ...first.context, stage: 'action' }, first.revision)).rejects.toMatchObject({ category: 'checkpoint_conflict' });
});

it('returns the same revision for an exact retry and rejects an execution identity collision', async () => {
  const saved = await store.save(context('run-2'), null);
  await expect(store.save(saved.context, saved.revision)).resolves.toMatchObject({ revision: saved.revision });
  await expect(journal.prepare(conflictingRecord())).rejects.toThrow();
});
```

- [ ] **Step 2: Run RED verification**

Run: `pnpm vitest run test/durable-state-contract.test.ts`

Expected: failure because the in-memory stores lack revision, Journal and UoW behavior.

- [ ] **Step 3: Implement memory stores without changing legacy callers**

Implement a `InMemoryDurableState` that satisfies new interfaces and exposes a legacy `CheckpointStore` adapter. `commitToolResult` must atomically update the execution result, the matching pending batch result and the Checkpoint revision in one synchronous state transition.

- [ ] **Step 4: Run GREEN verification**

Run: `pnpm vitest run test/durable-state-contract.test.ts`

Expected: create/update/idempotence/conflict/evidence pagination/journal/UoW tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/storage test/durable-state-contract.test.ts
git commit -m "feat: add in-memory durable state"
```

## Task 3: SQLite migration, stores and persistence bundle

**Files:**
- Modify: `src/infrastructure/sqlite/migrations.ts`, `src/infrastructure/sqlite/index.ts`
- Create: `src/infrastructure/sqlite/durable-state-store.ts`, `src/infrastructure/sqlite/sqlite-evidence-store.ts`, `src/infrastructure/sqlite/persistence-bundle.ts`, `test/sqlite-durable-state.test.ts`
- Test: `test/sqlite-durable-state.test.ts`

**Interfaces:**
- Consumes Tasks 1–2.
- Produces `createSqlitePersistence({ path, clock, limits })` and `SqlitePersistenceBundle` with one database ownership/close boundary.

- [ ] **Step 1: Write failing SQLite restart and transaction tests**

```ts
it('reopens a versioned checkpoint and evidence record after closing SQLite', async () => {
  const first = createSqlitePersistence({ path, clock });
  const checkpoint = await first.checkpoints.save(context('run-sqlite'), null);
  await first.evidence.save(metricEvidence('evidence-1'));
  first.close();
  const second = createSqlitePersistence({ path, clock });
  expect(await second.checkpoints.load('run-sqlite')).toMatchObject({ revision: checkpoint.revision });
  expect(await second.evidence.get('evidence-1')).toMatchObject({ source: 'metric' });
});

it('does not commit a result when the checkpoint revision is stale', async () => {
  await expect(bundle.stateUnitOfWork.commitToolResult(staleCommit)).rejects.toMatchObject({ category: 'checkpoint_conflict' });
  expect(await bundle.executions.get(staleCommit.execution.toolCallId)).toBeNull();
});
```

- [ ] **Step 2: Run RED verification**

Run: `pnpm vitest run test/sqlite-durable-state.test.ts`

Expected: failure because migration v2 and durable bundle do not exist.

- [ ] **Step 3: Append migration v2 and SQLite implementations**

Create `agent_checkpoints`, `evidence_records` and `tool_executions` exactly as specified. Use `database.raw.transaction(commit).immediate()` for CAS/UoW writes. Verify stored JSON with Task 1 codecs, preserve raw hash/capture-key idempotence, and use opaque cursor pagination ordered by `(captured_at, evidence_id)`.

- [ ] **Step 4: Run GREEN verification**

Run: `pnpm vitest run test/sqlite-durable-state.test.ts test/sqlite-event-message-store.test.ts`

Expected: durable restart/conformance tests and existing Event/Message tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/sqlite test/sqlite-durable-state.test.ts
git commit -m "feat: persist checkpoints evidence and executions in sqlite"
```

## Task 4: EvidenceRecorder and runtime composition

**Files:**
- Create: `src/application/evidence-recorder.ts`
- Modify: `src/application/create-runtime.ts`, `src/bootstrap/settlement-evidence-tool.ts`, `src/bootstrap/inspection-runtime.ts`
- Test: `test/evidence-recorder.test.ts`, `test/runtime-durable-persistence.test.ts`, `test/settlement-mcp.test.ts`

**Interfaces:**
- Consumes `EvidenceStore & EvidenceQueryStore`, V2 event factory/publisher and `SqlitePersistenceBundle`.
- Produces `DefaultEvidenceRecorder.capture()` and runtime-owned `close()` semantics.

- [ ] **Step 1: Write failing application tests**

```ts
it('publishes EVIDENCE_COLLECTED only after a committed record can be read back', async () => {
  await recorder.capture(request);
  expect(await evidence.get(request.record.evidenceId)).toEqual(request.record);
  expect(events.map((event) => event.type)).toContain('EVIDENCE_COLLECTED');
});

it('uses one SQLite database for events, checkpoints and evidence across runtime restart', async () => {
  const first = createAgentRuntime({ sqlitePath: path, workspaceRoots: [], includeExternalBash: false,
    model: new ScriptedModel([{ text: 'done', toolCalls: [] }]) });
  const result = await first.agent.reply(runOptions);
  first.close();
  const second = createAgentRuntime({ sqlitePath: path, workspaceRoots: [], includeExternalBash: false,
    model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]) });
  expect(await second.checkpoints.load(result.runId)).not.toBeNull();
});
```

- [ ] **Step 2: Run RED verification**

Run: `pnpm vitest run test/evidence-recorder.test.ts test/runtime-durable-persistence.test.ts`

Expected: failure because the runtime creates only Event/Message SQLite storage and evidence tools write directly to a store.

- [ ] **Step 3: Implement recorder and composition**

`DefaultEvidenceRecorder` validates, persists, reads back and then emits `EVIDENCE_COLLECTED`; duplicate capture uses a stable evidence/event identity. Modify Settlement Evidence Tool to depend on the recorder, retain its safe `STORAGE_ERROR` behavior, and make `createAgentRuntime({ sqlitePath })` create the complete bundle unless explicit stores are injected.

- [ ] **Step 4: Run GREEN verification**

Run: `pnpm vitest run test/evidence-recorder.test.ts test/runtime-durable-persistence.test.ts test/settlement-mcp.test.ts`

Expected: tests prove no raw marker enters Agent context, Event/SSE or LangSmith projection.

- [ ] **Step 5: Commit**

```bash
git add src/application src/bootstrap test/evidence-recorder.test.ts test/runtime-durable-persistence.test.ts test/settlement-mcp.test.ts
git commit -m "feat: compose durable runtime persistence"
```

## Task 5: Pending batches, per-tool persistence and recovery policy

**Files:**
- Modify: `src/agent/agent-harness.ts`, `src/tool/batch-executor.ts`, `src/tool/execution-pipeline.ts`, `src/tool/tool-runner.ts`
- Create: `src/agent/run-recovery.ts`
- Test: `test/durable-harness-recovery.test.ts`, `test/tool-batch-stream.test.ts`, `test/external-bash-flow.test.ts`

**Interfaces:**
- Consumes Versioned Checkpoint/Journaling/UoW from Tasks 1–3.
- Produces deterministic resume rules: reuse saved results, replay only `replay_safe`, verify or mark `uncertain` for all other prepared calls.

- [ ] **Step 1: Write failing restart and partial batch tests**

```ts
it('reuses the completed parallel branch and only replays the unfinished replay-safe call', async () => {
  const first = await stopAfterFirstToolCompletion(runtime, 'run-parallel');
  const resumed = await drain(reopened.agent.resumeStream(first.runId));
  expect(counter('finished')).toBe(1);
  expect(counter('unfinished')).toBe(1);
  expect(resumed.status).toBe('completed');
});

it('marks a prepared never-replay action uncertain rather than invoking it after restart', async () => {
  await seedPreparedAction(bundle, 'action-1');
  await drain(reopened.agent.resumeStream('run-action'));
  expect(actionCalls).toBe(0);
  expect(events).toContainEqual(expect.objectContaining({ type: 'EXTERNAL_EXECUTION_UNCERTAIN' }));
});
```

- [ ] **Step 2: Run RED verification**

Run: `pnpm vitest run test/durable-harness-recovery.test.ts`

Expected: failure because the Harness persists only a single pending call and the pipeline has no execution journal.

- [ ] **Step 3: Implement bounded run-state transitions**

Before dispatching a batch, persist `pendingToolBatch: admitted`. Pipeline writes `prepared` before a ToolRunner call. Each final tool result calls the UoW before batch aggregation. The batch executor receives completion callbacks without learning SQLite. `resumeStream` delegates to `run-recovery.ts`; it must never construct a recovery action from an arbitrary stored tool name or input.

- [ ] **Step 4: Run GREEN verification**

Run: `pnpm vitest run test/durable-harness-recovery.test.ts test/tool-batch-stream.test.ts test/external-bash-flow.test.ts test/agent-harness-async-generator.test.ts`

Expected: completion, cancellation, HITL, external execution and per-branch restart behavior remain deterministic.

- [ ] **Step 5: Commit**

```bash
git add src/agent src/tool test/durable-harness-recovery.test.ts test/tool-batch-stream.test.ts test/external-bash-flow.test.ts test/agent-harness-async-generator.test.ts
git commit -m "feat: recover durable tool batches safely"
```

## Task 6: HITL and external-result CAS integration

**Files:**
- Modify: `src/application/hitl-service.ts`, `src/application/external-tool-result-service.ts`, `src/application/create-runtime.ts`
- Test: `test/hitl-durable-revision.test.ts`, `test/external-bash-flow.test.ts`

**Interfaces:**
- Consumes versioned Checkpoint save and journal record from Tasks 1–5.
- Produces one-decision-per-revision semantics for confirmation, rejection, expiry and external result submission.

- [ ] **Step 1: Write failing simultaneous-decision tests**

```ts
it('accepts one confirmation decision and rejects a stale concurrent decision', async () => {
  await Promise.allSettled([hitl.decide(approved), hitl.decide(rejected)]);
  const checkpoint = await bundle.checkpoints.load(approved.runId);
  expect(checkpoint?.context.confirmedToolCallIds).toContain(approved.toolCallId);
  expect(checkpoint?.context.rejectedToolCallIds).not.toContain(approved.toolCallId);
});
```

- [ ] **Step 2: Run RED verification**

Run: `pnpm vitest run test/hitl-durable-revision.test.ts`

Expected: failure because service writes use legacy unconditional `CheckpointStore.save`.

- [ ] **Step 3: Implement revision-aware application services**

Load `StoredRunCheckpoint`, validate that the target call belongs to the persisted batch, apply exactly one legal transition and save with expected revision. Map conflicts to existing `STORAGE_ERROR/details.category=checkpoint_conflict`; never publish an approval/rejection event if storage commit fails.

- [ ] **Step 4: Run GREEN verification**

Run: `pnpm vitest run test/hitl-durable-revision.test.ts test/external-bash-flow.test.ts`

Expected: duplicate, expired and concurrent decisions cannot overwrite durable state.

- [ ] **Step 5: Commit**

```bash
git add src/application test/hitl-durable-revision.test.ts test/external-bash-flow.test.ts
git commit -m "feat: make hitl decisions revision safe"
```

## Task 7: Blob contracts, local BlobStore and Manifest persistence

**Files:**
- Modify: `src/contracts/storage.ts`, `src/infrastructure/sqlite/migrations.ts`, `src/infrastructure/sqlite/persistence-bundle.ts`, `src/infrastructure/sqlite/index.ts`
- Create: `src/infrastructure/blob/local-evidence-blob-store.ts`, `src/infrastructure/sqlite/blob-manifest-store.ts`, `test/local-evidence-blob-store.test.ts`

**Interfaces:**
- Consumes durable codecs and the SQLite bundle.
- Produces `EvidenceBlobStore`, `EvidenceBlobWriter`, `EvidenceManifestStore` and independently hashable gzip NDJSON chunks.

- [ ] **Step 1: Write failing Blob lifecycle tests**

```ts
it('publishes only complete chunks and reads one chunk without loading another', async () => {
  const writer = await blobStore.begin(beginInput);
  await writer.write(utf8('first\n'));
  await writer.write(utf8('second\n'));
  const descriptor = await writer.commit();
  expect(await decode(blobStore.readChunk(descriptor.chunks[0]!))).toContain('first');
  expect(await findTemporaryFiles(root)).toEqual([]);
});

it('keeps a pending manifest invisible after a crash point', async () => {
  await seedPendingManifestAfterChunkPublish(bundle, descriptor);
  expect(await manifests.getVisible('evidence-blob-1')).toBeNull();
});
```

- [ ] **Step 2: Run RED verification**

Run: `pnpm vitest run test/local-evidence-blob-store.test.ts`

Expected: failure because Blob contracts, v3 migration and local writer do not exist.

- [ ] **Step 3: Implement local chunk storage and Manifest tables**

Use injected absolute `rootPath`; never derive it from CWD. The writer creates a temporary sibling, streams gzip bytes, hashes uncompressed/cipher-free data, atomically renames on success and records only opaque `storageKey`. Add v3 `evidence_blob_manifests` and `evidence_blob_chunks` exactly as the Blob spec defines, including `retention_until` and terminal `pending/committed/partial/failed/deleting` states.

- [ ] **Step 4: Run GREEN verification**

Run: `pnpm vitest run test/local-evidence-blob-store.test.ts test/sqlite-durable-state.test.ts`

Expected: lifecycle, hash mismatch, abort, orphan recovery and Manifest visibility tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/contracts src/infrastructure/blob src/infrastructure/sqlite test/local-evidence-blob-store.test.ts
git commit -m "feat: add local evidence blob storage"
```

## Task 8: Streaming EvidenceRecorder, budgets and generated large-log fixture

**Files:**
- Create: `src/application/streaming-evidence-recorder.ts`, `test/streaming-evidence-recorder.test.ts`, `test/fixtures/generated-log-pages.ts`
- Modify: `src/application/create-runtime.ts`, `src/infrastructure/sqlite/persistence-bundle.ts`
- Test: `test/streaming-evidence-recorder.test.ts`

**Interfaces:**
- Consumes Tasks 3, 4 and 7.
- Produces streaming `capture()` with one-page backpressure, deterministic aggregation, partial status and opaque continuation state.

- [ ] **Step 1: Write failing streaming tests**

```ts
it('stores 64 MiB of generated pages without returning raw content to the summary', async () => {
  const result = await recorder.capture({ ...request, pages: generatedLogPages({ totalBytes: 64 * 1024 * 1024 }) });
  expect(result.manifest.sourceBytes).toBe(64 * 1024 * 1024);
  expect(JSON.stringify(result.summary)).not.toContain('raw-log-marker');
  expect(result.manifest.chunks.length).toBeGreaterThan(1);
});

it('commits partial evidence with deterministic coverage when the byte budget is reached', async () => {
  const result = await recorder.capture({ ...request, budget: { ...budget, maxSourceBytes: 1024 } });
  expect(result).toMatchObject({ truncated: true, missingEvidence: ['ELK_CAPTURE_BYTE_BUDGET_EXCEEDED'] });
});
```

- [ ] **Step 2: Run RED verification**

Run: `pnpm vitest run test/streaming-evidence-recorder.test.ts`

Expected: failure because page ingestion and Blob Manifest commit do not exist.

- [ ] **Step 3: Implement bounded capture**

Consume one `AsyncIterable<EvidenceSourcePage>` page at a time, normalize/redact before persistence, append NDJSON to 4 MiB chunks, compute counts/signature Top-N/time coverage deterministically and limit samples/summary. On byte/record/time boundary commit a validated `partial` Manifest; source failure before any committed chunk is `failed`, not partial. Publish `EVIDENCE_COLLECTED` only after a visible committed/partial Manifest exists.

- [ ] **Step 4: Run GREEN verification**

Run: `pnpm vitest run test/streaming-evidence-recorder.test.ts`

Expected: 64 MiB, byte/record/time budgets, Abort, redaction and no-raw-event tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/application src/infrastructure/sqlite test/fixtures/generated-log-pages.ts test/streaming-evidence-recorder.test.ts
git commit -m "feat: stream large evidence into blob storage"
```

## Task 9: Bounded ELK page adapter and log evidence Tools

**Files:**
- Create: `src/infrastructure/elk/paged-evidence-source.ts`, `src/bootstrap/log-evidence-tools.ts`, `test/paged-evidence-source.test.ts`, `test/log-evidence-tools.test.ts`
- Modify: `src/bootstrap/index.ts`, `src/application/create-runtime.ts`
- Test: `test/paged-evidence-source.test.ts`, `test/log-evidence-tools.test.ts`

**Interfaces:**
- Consumes Task 8 page and capture contracts.
- Produces injected page-client adapter plus `logs.capture`, `logs.search_evidence`, `logs.aggregate_evidence` and `logs.read_evidence_slice` Tool factories. No real Elastic endpoint or credentials are added.

- [x] **Step 1: Write failing bounded-page and Tool tests**

```ts
it('rejects a source page above 512 KiB before it reaches the recorder', async () => {
  const source = new PagedEvidenceSource(overLimitClient);
  await expect(collect(source.pages(query))).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
});

it('returns evidence references and bounded redacted samples without exposing storage keys', async () => {
  const result = await call(logTools.capture, { service: 'checkout', start, end });
  expect(result.blocks).toContainEqual(expect.objectContaining({ type: 'evidence_ref' }));
  expect(JSON.stringify(result)).not.toContain('storageKey');
});
```

- [x] **Step 2: Run RED verification**

Run: `pnpm vitest run test/paged-evidence-source.test.ts test/log-evidence-tools.test.ts`

Expected: failure because no ELK page port or log Tool factories exist.

- [x] **Step 3: Implement injected bounded adapter and Tools**

Define a source client independent of MCP SDK; its concrete MCP adapter uses opaque cursor/PIT inputs and converts each response to a page under 512 KiB. Log Tools only access evidence IDs owned by the current Run/Profile, return samples through opaque cursors, and never expose filesystem paths, query DSL or credentials. Mark capture `recoveryPolicy: 'verify_before_retry'` and read-only analysis Tools `replay_safe`.

- [x] **Step 4: Run GREEN verification**

Run: `pnpm vitest run test/paged-evidence-source.test.ts test/log-evidence-tools.test.ts test/mcp-http.test.ts`

Expected: page size, duplicate/looping cursor, capture, aggregation, access scope and redaction tests pass while existing MCP size protection remains unchanged.

- [x] **Step 5: Commit**

```bash
git add src/infrastructure/elk src/bootstrap test/paged-evidence-source.test.ts test/log-evidence-tools.test.ts
git commit -m "feat: add bounded log evidence tools"
```

## Task 10: End-to-end persistence acceptance and documentation state

**Files:**
- Create: `test/durable-evidence-acceptance.test.ts`
- Modify: `docs/implementation-status.md`, `docs/architecture/07-context-memory-storage.md`, `docs/architecture/12-mcp-implementation.md`, `docs/architecture/14-settlement-mcp-evidence.md`
- Test: `test/durable-evidence-acceptance.test.ts`

**Interfaces:**
- Consumes all prior tasks.
- Produces a tested restart/partial-evidence closure and accurate implemented-vs-design documentation.

- [x] **Step 1: Write failing acceptance tests**

```ts
it('persists a metrics run, reopens it, and resolves evidence without raw data in public projections', async () => {
  const first = createInspectionRuntime({ sqlitePath: path, workspaceRoots: [],
    model: new ScriptedModel([{ toolCalls: [{ id: 'metrics-1', name: 'metrics.settlement', input: { service: 'checkout' } }] }, { text: 'done', toolCalls: [] }]),
    tools: [metricsTool] });
  const run = await first.agent.reply(runOptions);
  first.close();
  const second = createInspectionRuntime({ sqlitePath: path, workspaceRoots: [],
    model: new ScriptedModel([{ text: 'unused', toolCalls: [] }]), tools: [metricsTool] });
  expect(await second.checkpoints.load(run.runId)).not.toBeNull();
  expect(JSON.stringify(await second.eventStreamV2.replay(run.runId))).not.toContain('raw-only-marker');
});
```

- [x] **Step 2: Run RED verification**

Run: `pnpm vitest run test/durable-evidence-acceptance.test.ts`

Expected: failure until all persistence, recorder and bundle wiring are complete.

- [x] **Step 3: Implement only integration glue required by the acceptance test**

Do not add a real ELK URL, credentials, automatic blob cleanup, production encryption or automatic write actions. Update status documents to distinguish the implemented local Blob/paged-source foundation from still-unimplemented real ELK and production Blob deployments.

- [x] **Step 4: Run focused and full verification**

Run:

```bash
pnpm vitest run test/durable-evidence-acceptance.test.ts
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: focused acceptance passes; full suite has no failures; real Prometheus remains explicitly skipped unless `AGENTOPS_REAL_PROMETHEUS=1` is configured.

- [x] **Step 5: Commit**

```bash
git add test/durable-evidence-acceptance.test.ts docs
git commit -m "test: verify durable evidence recovery"
```

## Plan self-review

| Spec requirement | Planned task |
|---|---|
| CAS Checkpoint, execution journal, atomic ToolResult state | 1–3, 5–6 |
| In-memory/SQLite conformance and WAL migration | 2–3 |
| Evidence Recorder and no raw Event/Message/LangSmith exposure | 4, 8, 10 |
| Pending batch and action no-replay recovery | 5–6 |
| SQLite Manifest + local BlobStore and chunk integrity | 7 |
| 512 KiB pages, 4 MiB chunks, 64 MiB capture, partial coverage | 8–9 |
| Bounded second-read tools and no storage path leakage | 9 |
| Restart/acceptance and accurate docs | 10 |

Ruling: A live ELK cluster, production object storage/KMS and user-supplied credentials are external/security-sensitive dependencies. This plan implements the contract, local BlobStore, injected source adapter and generated large-log validation only. Cost if wrong: a later integration task must add the concrete ELK client/deployment configuration, but no unsafe endpoint or credential assumption enters this branch.
