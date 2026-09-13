# L0 Large Evidence Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** 按运行时治理 Spec 实现 L0 大证据边界：小结果保持兼容，大日志/Trace 以有界、可回读、可审计的 Manifest + Blob 形式进入系统，模型只看到有界摘要和 evidence reference。

**Architecture:** contracts 层新增独立的 EvidenceBlobStore、EvidenceManifestStore、StreamingEvidenceRecorder 和 ToolResultCompactor 接口；应用层只依赖这些端口。首版文件 BlobStore 使用注入的绝对根目录，以每个 4 MiB 目标的 gzip NDJSON chunk 形成背压；SQLite 只存 Manifest 和 chunk 元数据。已有 EvidenceStore/EvidenceRecord.raw 保持不变，继续处理不超过 1 MiB 的指标证据。

**Tech Stack:** TypeScript 5.9 strict、Node.js 20、pnpm、better-sqlite3、Node fs/promises、crypto、zlib、Vitest。

**Spec:**
- docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md §9.1、§15 增量5
- docs/superpowers/specs/2026-09-10-elk-large-evidence-blob-storage-design.md §4–§7、§10–§12、§15–§16

## Global Constraints

- 保留已发布的 EvidenceStore、EvidenceRecord.raw、Event/Message V2 和 ToolResponse 语义；大证据使用新增端口，不修改旧字段。
- agent/、tool/ 和 context-compressor/ 不依赖 better-sqlite3、文件系统、zlib 或具体 Blob 实现。
- Blob 根目录、时间、ID、chunk 大小、摘要预算和脱敏规则必须通过构造器注入；禁止 process.cwd()。
- 原始日志、完整查询 DSL、storage key、内部路径、凭证、Cookie、Token 不得进入 ToolResult 模型视图、公共 Event、SSE 或 LangSmith。
- 单页目标上限 512 KiB、chunk 目标 4 MiB、单次 capture 默认 64 MiB、模型可见摘要默认 16 KiB；达到预算只提交 partial 并携带 coverage/truncated/missingEvidence。
- Manifest 只有 committed 或 partial 对调用方可见；pending、failed 和 deleting 不得生成 evidence reference。
- 每个实现任务先写失败测试并观察正确失败，再写最小生产代码；每个任务独立提交。

## File Map

| 文件 | 职责 |
|---|---|
| src/contracts/storage.ts | 大证据、Blob、Manifest 的稳定端口和结构化类型 |
| src/context-compressor/types.ts | L0 ToolResultCompactor 公共端口 |
| src/infrastructure/blob/local-evidence-blob-store.ts | 注入根目录的 gzip chunk 文件实现 |
| src/infrastructure/sqlite/migrations.ts | 追加 Manifest/chunk 迁移，不改历史迁移 |
| src/infrastructure/sqlite/blob-manifest-store.ts | SQLite Manifest 控制面和可见性 |
| src/application/streaming-evidence-recorder.ts | 单页背压、预算、确定性摘要、提交顺序 |
| src/context-compressor/tool-result-compactor.ts | 不创建 Evidence、只构造有界模型视图 |
| src/application/create-runtime.ts | 可选端口的依赖注入与公开运行时返回值 |
| test/l0-large-evidence.test.ts | Blob/Manifest/Recorder/Compactor 的合同和边界测试 |

### Task 1: Define L0 ports and bounded value contracts

**Files:**
- Modify: src/contracts/storage.ts, src/contracts/index.ts
- Modify: src/context-compressor/types.ts
- Create: test/l0-contracts.test.ts

**Interfaces:**
- NormalizedLogRecord：timestamp，及可选 service/level/message/exception/traceId 和 JSON fields。
- EvidenceSourcePage：readonly records、encodedBytes、可选 opaque nextCursor 和 sourceSnapshotId。
- EvidenceCaptureBudget：maxSourceBytes、maxRecords、maxDurationMs、maxModelSummaryBytes、maxSamples。
- EvidenceBlobStore.begin/readChunk/delete 和 writer.write/commit/abort。
- EvidenceManifestStore.createPending/recordChunk/commit/markFailed/get/getVisible。
- StreamingEvidenceRecorder.capture 和 EvidenceCaptureResult。
- ToolResultCompactor.compact 返回有界模型视图，不创建 Evidence。

- [ ] **Step 1: Write failing contract tests**

~~~ts
it('accepts a page contract without exposing a storage path', () => {
  const page: EvidenceSourcePage = {
    records: [{ timestamp: '2026-09-13T00:00:00.000Z', level: 'ERROR', message: 'redacted' }],
    encodedBytes: 64,
  };
  expect(page.nextCursor).toBeUndefined();
});

it('exposes a separate compactor port instead of changing EvidenceStore.raw', () => {
  const compactor: ToolResultCompactor = {
    compact: (result) => ({ result, decision: { level: 'none', originalBytes: 0, modelBytes: 0 } }),
  };
  expect(compactor.compact({
    toolCallId: 'call-1', toolName: 'logs.capture', status: 'success',
    startedAt: '2026-09-13T00:00:00.000Z',
  }).decision.level).toBe('none');
});
~~~

- [ ] **Step 2: Run RED verification**

Run: pnpm vitest run test/l0-contracts.test.ts

Expected: FAIL because the new ports and result types do not exist.

- [ ] **Step 3: Add strict additive contracts**

Use JsonValue for persisted summary values, keep storageKey only in the internal EvidenceChunkRef, and make EvidenceManifestSummary omit storage keys. Use source log or trace for streaming captures; do not widen old EvidenceRecord.source.

- [ ] **Step 4: Run GREEN verification**

Run: pnpm vitest run test/l0-contracts.test.ts

Expected: PASS with no changes to existing EvidenceStore tests.

- [ ] **Step 5: Commit**

~~~bash
git add src/contracts/storage.ts src/contracts/index.ts src/context-compressor/types.ts test/l0-contracts.test.ts
git commit -m "feat: define l0 evidence ports"
~~~

### Task 2: Implement local BlobStore and SQLite Manifest control plane

**Files:**
- Modify: src/infrastructure/sqlite/migrations.ts, src/infrastructure/sqlite/persistence-bundle.ts, src/infrastructure/sqlite/index.ts
- Create: src/infrastructure/blob/local-evidence-blob-store.ts
- Create: src/infrastructure/sqlite/blob-manifest-store.ts
- Create: test/local-evidence-blob-store.test.ts

**Interfaces:**
- Consumes Task 1 ports and existing SqliteDatabase.
- Produces atomic temporary-to-final gzip chunk publication, per-chunk SHA-256, and visible Manifest states.

- [ ] **Step 1: Write failing lifecycle tests**

~~~ts
it('writes a gzip chunk atomically and reads only the committed chunk', async () => {
  const writer = await blobStore.begin(beginInput);
  await writer.write(new TextEncoder().encode('first\n'));
  const descriptor = await writer.commit();
  expect(descriptor.chunks).toHaveLength(1);
  expect(await gunzip(await collect(blobStore.readChunk(descriptor.chunks[0]!)))).toBe('first\n');
  expect(await temporaryFiles(root)).toEqual([]);
});

it('keeps pending and failed manifests invisible', async () => {
  await manifests.createPending(pendingInput);
  expect(await manifests.getVisible('evidence-1')).toBeNull();
  await manifests.markFailed({ evidenceId: 'evidence-1', reasonCode: 'SOURCE_FAILED' });
  expect(await manifests.getVisible('evidence-1')).toBeNull();
});
~~~

- [ ] **Step 2: Run RED verification**

Run: pnpm vitest run test/local-evidence-blob-store.test.ts

Expected: FAIL because the Blob implementation and migration do not exist.

- [ ] **Step 3: Implement the data plane**

Append one SQLite migration with the exact Manifest/chunk columns and state checks from the ELK Blob spec. The local store accepts an injected absolute rootPath, rejects path traversal, writes gzip to a unique sibling temporary file, renames only after close, and returns opaque generated keys. The writer must be idempotent after commit/abort and bound each individual write to the configured chunk target; it must never buffer the complete capture.

- [ ] **Step 4: Run GREEN verification**

Run: pnpm vitest run test/local-evidence-blob-store.test.ts test/sqlite-durable-state.test.ts

Expected: gzip readback, checksum mismatch, abort cleanup, Manifest visibility, duplicate identity and migration reopen tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add src/infrastructure/blob src/infrastructure/sqlite test/local-evidence-blob-store.test.ts
git commit -m "feat: add local evidence blob storage"
~~~

### Task 3: Implement StreamingEvidenceRecorder with budgets and deterministic summary

**Files:**
- Create: src/application/streaming-evidence-recorder.ts
- Create: test/streaming-evidence-recorder.test.ts
- Create: test/fixtures/generated-log-pages.ts

**Interfaces:**
- Consumes Task 1 ports and Task 2 Blob/Manifest implementations through injection.
- Produces EvidenceCaptureResult with a committed/partial manifest, bounded EvidenceSummary, deterministic coverage and missing-evidence codes.

- [ ] **Step 1: Write failing streaming tests**

~~~ts
it('captures 64 MiB of generated records without putting the marker in the summary', async () => {
  const result = await recorder.capture({
    ...request,
    pages: generatedLogPages({ totalBytes: 64 * 1024 * 1024 }),
  });
  expect(result.manifest.sourceBytes).toBe(64 * 1024 * 1024);
  expect(JSON.stringify(result.summary)).not.toContain('raw-log-marker');
  expect(result.manifest.chunkCount).toBeGreaterThan(1);
});

it('commits partial evidence at a byte budget with deterministic missing evidence', async () => {
  const result = await recorder.capture({
    ...request,
    budget: { ...budget, maxSourceBytes: 1024 },
  });
  expect(result).toMatchObject({
    truncated: true,
    missingEvidence: ['ELK_CAPTURE_BYTE_BUDGET_EXCEEDED'],
  });
  expect(result.manifest.state).toBe('partial');
});
~~~

- [ ] **Step 2: Run RED verification**

Run: pnpm vitest run test/streaming-evidence-recorder.test.ts

Expected: FAIL because no page ingestion or streaming recorder exists.

- [ ] **Step 3: Implement bounded ingestion**

Validate IDs, range, budgets and source. Create a pending Manifest before consuming pages. Normalize/redact each record, encode one NDJSON chunk at a time, await Blob writer completion before requesting the next page, record each committed chunk and cursor, then commit/read back the Manifest. Count levels/services/exception signatures and select at most maxSamples redacted samples; trim deterministic arrays until the summary is within maxModelSummaryBytes. On byte, record or duration limits commit partial; on source/blob/hash failure mark failed unless a validated partial already exists. Abort closes the writer and never returns an evidence reference.

- [ ] **Step 4: Run GREEN verification**

Run: pnpm vitest run test/streaming-evidence-recorder.test.ts

Expected: 64 MiB generated capture, one-page backpressure, byte/record/time budgets, redaction, Abort, stable hash and no-raw-summary tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add src/application/streaming-evidence-recorder.ts test/fixtures/generated-log-pages.ts test/streaming-evidence-recorder.test.ts
git commit -m "feat: stream large evidence captures"
~~~

### Task 4: Implement L0 ToolResultCompactor and integrate the model view boundary

**Files:**
- Create: src/context-compressor/tool-result-compactor.ts
- Modify: src/context-compressor/rule-based-compressor.ts, src/context-compressor/types.ts
- Create: test/tool-result-compactor.test.ts

**Interfaces:**
- Consumes ToolExecutionResult, existing evidence IDs and optional bounded evidence summaries.
- Produces a model-view ToolExecutionResult whose serialized response is at most 16 KiB by default; it never creates an EvidenceRecord or fabricates an evidence ID.

- [ ] **Step 1: Write failing compactor tests**

~~~ts
it('keeps evidence references and replaces an oversized response with a bounded summary', () => {
  const compacted = compactor.compact(largeResultWithEvidence);
  expect(compacted.decision.level).toBe('L0');
  expect(compacted.result.response?.evidenceIds).toEqual(['evidence-1']);
  expect(JSON.stringify(compacted.result.response)).not.toContain('raw-log-marker');
  expect(Buffer.byteLength(JSON.stringify(compacted.result.response), 'utf8')).toBeLessThanOrEqual(16 * 1024);
});

it('fails closed when an oversized result has no committed evidence reference', () => {
  expect(() => compactor.compact(largeResultWithoutEvidence)).toThrowError(expect.objectContaining({
    code: 'BUDGET_EXCEEDED',
  }));
});
~~~

- [ ] **Step 2: Run RED verification**

Run: pnpm vitest run test/tool-result-compactor.test.ts

Expected: FAIL because the L0 compactor and stable budget error do not exist.

- [ ] **Step 3: Implement the minimal model-view transformer**

Measure UTF-8 bytes, preserve status/IDs/error code/evidence IDs/evidence_ref blocks, and replace only oversized text/json/artifact content with a deterministic l0_compacted JSON block containing byte count and evidence IDs. When no evidence ID is present, throw a structured BUDGET_EXCEEDED error with details.category = tool_result_too_large. Do not mutate the durable result in place. Make RuleBasedContextCompressor.pruneToolResult() delegate to this port while retaining the existing public ContextCompressor interface.

- [ ] **Step 4: Run GREEN verification**

Run: pnpm vitest run test/tool-result-compactor.test.ts test/evidence-recorder.test.ts test/settlement-mcp.test.ts

Expected: L0 compaction is bounded and old small metric evidence behavior is unchanged.

- [ ] **Step 5: Commit**

~~~bash
git add src/context-compressor test/tool-result-compactor.test.ts
git commit -m "feat: bound tool results at l0"
~~~

### Task 5: Wire optional L0 ports into SQLite bootstrap and verify public boundaries

**Files:**
- Modify: src/application/create-runtime.ts, src/infrastructure/sqlite/persistence-bundle.ts, src/index.ts
- Create: test/l0-runtime-boundary.test.ts
- Modify: docs/implementation-status.md if present, otherwise create the status entry under docs/

**Interfaces:**
- Consumes Tasks 1–4.
- Produces optional runtime properties for evidenceBlobs, evidenceManifests, streamingEvidenceRecorder and toolResultCompactor; default metrics runtime remains compatible.

- [ ] **Step 1: Write failing bootstrap/boundary tests**

~~~ts
it('exposes injected L0 ports without making Harness depend on a Blob implementation', async () => {
  const runtime = createAgentRuntime({ model, workspaceRoots: [], l0: { blobStore, manifests } });
  expect(runtime.toolResultCompactor).toBeDefined();
  expect(runtime.streamingEvidenceRecorder).toBeDefined();
});

it('does not expose storage keys or raw markers through the model-facing result', () => {
  const output = compactLargeResult();
  expect(JSON.stringify(output)).not.toContain('storageKey');
  expect(JSON.stringify(output)).not.toContain('raw-log-marker');
});
~~~

- [ ] **Step 2: Run RED verification**

Run: pnpm vitest run test/l0-runtime-boundary.test.ts

Expected: FAIL because the optional L0 composition boundary is not exposed.

- [ ] **Step 3: Add constructor injection only**

Do not instantiate BlobStore, SQLite or filesystem objects in Agent Harness. For sqlitePath, create the local Blob root from an explicit option only; do not derive it from CWD. Keep existing EvidenceStore path unchanged. Export the new application/infrastructure types from the package barrel.

- [ ] **Step 4: Run GREEN verification**

Run: pnpm vitest run test/l0-runtime-boundary.test.ts test/runtime-events-v2.test.ts test/evidence-recorder.test.ts

Expected: runtime composition works and existing Event/Message contracts remain unchanged.

- [ ] **Step 5: Commit**

~~~bash
git add src/application/create-runtime.ts src/infrastructure/sqlite/persistence-bundle.ts src/index.ts test/l0-runtime-boundary.test.ts docs
git commit -m "feat: wire l0 evidence ports"
~~~

## Plan self-review

| Spec requirement | Planned task |
|---|---|
| Additive Blob/Manifest/Recorder ports without changing legacy EvidenceStore | 1–2 |
| Atomic gzip chunks, per-chunk hash and SQLite visibility states | 2 |
| One-page backpressure, 64 MiB fixture, partial budget semantics | 3 |
| Deterministic redaction, aggregation, samples and summary cap | 3 |
| ToolResult L0 cap, evidence reference preservation and fail-closed overflow | 4 |
| Optional constructor injection and no core infrastructure dependency | 5 |
| No raw evidence in model/public boundaries | 3–5 |
| L1/L2, ELK MCP paging, Logs Subagent and production object storage | intentionally excluded; remain in later increments |

No placeholders remain; every task has concrete files, interfaces, tests, commands and commit boundaries.
