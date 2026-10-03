# Logs Web Elasticsearch Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过真实 Elasticsearch 和只读 MCP，把已有 Logs Subagent 接入 Agent Web，完成摘要/引用、失败降级、大证据和持久化验收。

**Architecture:** 复用现有 Harness、Logs 普通工具、来源 ToolAdapter、V2 数据通道及 SQLite/Blob 数据面。新增 Elasticsearch/PIT 适配器和隔离实验室，在 bootstrap 组装；主 Agent 不直接访问 Elasticsearch。浏览器保留摘要和引用，不开放原始日志。

**Tech Stack:** TypeScript、Node.js 20、pnpm、现有 MCP SDK/Zod 3/Vitest/Playwright、SQLite、本地 gzip NDJSON Blob、Docker Compose、Elasticsearch 8.19.12、现有 Prometheus 镜像。

**Spec:** [2026-10-03-logs-web-elasticsearch-integration-design.md](../specs/2026-10-03-logs-web-elasticsearch-integration-design.md)

状态：待用户审核。当前仅新增文档，下面的任务都未实施；用户确认后开始编码。

## Global Constraints

- TypeScript、Node.js 20、pnpm；不升级 Node、pnpm 或现有 SDK 作为本次集成的隐含前提。
- `profileId=simulation`、`service=checkout`、查询窗口 300 秒；不修改 `group-buy-market`；不注册 Bash、任意 HTTP/SQL/DSL 或业务写工具。
- 浏览器证据页面始终只展示摘要、状态、引用、覆盖度和哈希；`retrievable=false` 不改为原文下载。
- 一次采集 64 MiB、50,000 条、60 秒；每页最多 512 KiB；模型 ToolResult 最多 16 KiB，最多 3 个脱敏样本。
- 不在每页重置期限，不叠乘重试；已有父/子 Tool-call 和 network ledger 继续共享。
- 不修改 V1/V2 公共事件、消息块、ToolResponse 或 SQLite Schema，不需要持久化迁移。
- 默认测试不调用付费模型；最后真实烟测需额外授权，最多 10 次模型 HTTP 请求、每次输出上限 512 tokens。
- 无关未跟踪文件 `docs/superpowers/plans/2026-10-01-agent-web.md` 保留，不使用 `git add .`。

## 执行前检查与依赖顺序

在 `D:\agentops\.worktrees\event-message-v2` 执行；先核对 `git status --short`、当前分支和根/子目录 AGENTS.md。基线 `4607856` 仅用于说明本计划编写时的状态，不允许 reset 用户新提交。

阅读 Spec、`01-product-scope-and-roadmap.md`、既有 Source Subagent/ELK 大证据/Agent Web Metrics Spec。产品路线中的“真实业务最终目标”不等于本轮可以写业务项目；若需规范澄清只作相容的文字说明。

| 任务 | 前置 | 可独立审查的交付 |
|---|---|---|
| 1 协议/Scope | 无 | 严格日志协议与实验 Profile |
| 2 ES/PIT | 1 | 真实分页和有界传输 |
| 3 MCP/预算 | 1、2 | 可调用的只读日志数据源 |
| 4 Logs Lab | 1、2、3 | 真实后端可重复场景 |
| 5 确定性 Logs 报告 | 1 | 不被模型数字覆盖的来源事实 |
| 6 Web 组装 | 3、5 | 父子共享持久化与工具隔离 |
| 7 大数据/恢复验收 | 4、6 | 部分成功与重启的确定性证据 |
| 8 浏览器/交付 | 7 | 浏览器验收和运行手册 |

1 完成后，5 可以与 2–4 分别开发，但只有不同文件且审查通过才并行；6 等其依赖完成。不要同时派两个执行者修改 `logs-subagent.ts` 或公共分页实现。

所有任务采用：测试先红 → 最小实现 → 定向绿 → Spec/质量审查 → 小提交。以下代码块给出关键测试/算法，配套矩阵中的每项都必须有确定性断言。

Windows 若 `pnpm` 不在 PATH，定向测试可运行 `& .\node_modules\.bin\vitest.cmd run <test>`；根脚本含嵌套 pnpm 时，先解决 shim，不把 `corepack pnpm@10` 能运行误认为嵌套命令已可用。

---

### Task 1: 日志协议和实验 Scope

**Files:**

- Create: `src/mcp/logs-protocol.ts`
- Create: `src/profiles/logs.ts`
- Modify: `src/mcp/index.ts`、`src/profiles/index.ts`
- Test: `test/logs-protocol.test.ts`、`test/logs-profile.test.ts`

**Interfaces:**

- Consumes: 既有 `AgentErrorCode`、`ElkEvidenceQuery`、`NormalizedLogRecord`；profiles 不依赖基础设施模块。
- Produces: `LogsQueryPolicy`、`logsLabQueryPolicy`、`validateLogsScope(input: {service:string;start:string;end:string}, policy: LogsQueryPolicy, nowMs:number): void`。
- Produces: `logsSearchPageInput`/`logsCloseSnapshotInput` Zod strict Schema，`LogsSearchPageInput = z.infer<typeof logsSearchPageInput>`、`LogsPageWireResult`。
- Produces: `LogsPageBackend`，方法 `searchPage(input:LogsSearchPageInput, signal:AbortSignal):Promise<LogsPageWireResult>`、`closeSnapshot(input:{sourceSnapshotId:string}, signal:AbortSignal):Promise<void>`、`close():Promise<void>`。

- [ ] **Step 1: 写严格 Schema 和越权测试。**

```ts
it('rejects model supplied indices and query DSL', () => {
  expect(logsSearchPageInput.safeParse({
    service: 'checkout', start: '2026-10-03T00:00:00Z',
    end: '2026-10-03T00:05:00Z', index: '*', query: { match_all: {} },
  }).success).toBe(false);
});
it('rejects stale scopes instead of accepting fake healthy data', () => {
  expect(() => validateLogsScope({
    service: 'checkout', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:05:00Z',
  }, logsLabQueryPolicy, Date.parse('2026-10-03T00:07:01Z'))).toThrow();
});
```

加边界：无时区/非法日历日期、start≥end、窗口非 300 秒、未来超过 30 秒、非 checkout、cursor/snapshot 仅一项、空 requestId、超长 contains/traceId、未知结果字段。

- [ ] **Step 2: 跑红。** `pnpm exec vitest run test/logs-protocol.test.ts test/logs-profile.test.ts`；预期因新导出不存在失败。

- [ ] **Step 3: 定义最小接口和校验。**

```ts
export interface LogsQueryPolicy {
  service: 'checkout'; windowSeconds: 300;
  maxWindowSkewSeconds: 120; maxFutureSkewSeconds: 30;
}
export const logsLabQueryPolicy: Readonly<LogsQueryPolicy> = Object.freeze({
  service: 'checkout', windowSeconds: 300,
  maxWindowSkewSeconds: 120, maxFutureSkewSeconds: 30,
});
```

协议输入字段：service/start/end；可选 level/traceId/contains/cursor/sourceSnapshotId/requestId。普通字符串最多 256 字符，contains 最多 1,024 字符；游标最多 4 KiB。日期严格校验日历与时区，不能仅靠 Date.parse 自动修正日期。

结果判别联合：`{status:'available',records,sourceSnapshotId,nextCursor?}` 或 `{status:'source_error',code,reason?}`。code 限现有 INVALID_INPUT/POLICY_DENIED/UNAVAILABLE/MCP_AUTH_ERROR/MCP_NETWORK_ERROR/MCP_TIMEOUT/MCP_RATE_LIMITED/MCP_SERVER_ERROR/MCP_PROTOCOL_ERROR/ABORTED/BUDGET_EXCEEDED；reason 限 `snapshot_expired|cursor_invalid|scope_denied|response_too_large|source_unavailable`。不返回异常原文。首次新服务器查询要求 requestId；游标请求必须有 sourceSnapshotId。

- [ ] **Step 4: 跑绿并 typecheck。** 同 Step 2，加 `pnpm typecheck`。期望所有新 Scope 边界通过，既有协议导出保持不变。
- [ ] **Step 5: 审查后小提交。** 只 add 本任务 6 个文件；`git commit -m "feat(logs): define bounded readonly page protocol and scope"`。

### Task 2: 有界 ES HTTP 与 PIT 分页

**Files:**

- Create: `src/infrastructure/elk/elasticsearch-http.ts`
- Create: `src/infrastructure/elk/elasticsearch-log-source.ts`
- Create: `src/infrastructure/elk/log-snapshot-registry.ts`
- Create: `src/contracts/log-redaction.ts`
- Modify: `src/contracts/index.ts`、`src/application/streaming-evidence-recorder.ts`（只提取现有纯脱敏函数，不改变策略）
- Modify: `src/infrastructure/elk/index.ts`
- Test: `test/elasticsearch-http.test.ts`、`test/elasticsearch-log-source.test.ts`、`test/log-snapshot-registry.test.ts`、`test/log-redaction.test.ts`

**Interfaces:**

- Consumes: Task 1 `LogsPageBackend`、`LogsSearchPageInput`、`LogsPageWireResult`、`logsLabQueryPolicy`。
- Produces: `ElasticsearchHttp` 构造参数 `{url:string;fetch?:typeof globalThis.fetch;maxResponseBytes?:number}`；`request(path:string, body:unknown, options:{method:'POST'|'DELETE'|'PUT';signal:AbortSignal}):Promise<unknown>`。
- Produces: `createElasticsearchLogSource(options:{url:string;index:string;cursorSecret:string;fetch?:typeof globalThis.fetch;now?:()=>number;id?:()=>string;maxSessions?:number;pageSize?:number;onCleanupFailure:(failure:{code:AgentErrorCode;sourceSnapshotId?:string})=>void}):LogsPageBackend`。清理报告只暴露稳定错误码与逻辑快照 ID。
- Produces: `redactLogRecord(record:NormalizedLogRecord):NormalizedLogRecord`，无基础设施依赖的纯函数；从 Recorder 原 defaultRedactor/redactFields/redactValue/redactText 提取，行为与 redaction/v1 相同，新导出是相容增量。
- Registry 为适配器私有；不得从 contracts 或 agent 引用具体类。

- [ ] **Step 1: 写 HTTP 边界、轮换 PIT 和过期测试。** 假 fetch 由 Vitest `vi.fn<typeof fetch>()` 构造 Response 队列；不启动 Docker。

```ts
it('keeps logical snapshot stable when Elasticsearch rotates PIT', async () => {
  const fetcher = vi.fn<typeof fetch>();
  fetcher.mockResolvedValueOnce(Response.json({ id: 'pit-1' }));
  fetcher.mockResolvedValueOnce(Response.json({
    pit_id: 'pit-2', hits: { hits: [{ _source: {
      timestamp: '2026-10-03T00:04:59Z', service: 'checkout', level: 'ERROR',
      message: 'timeout', exception: 'SQLTimeoutException',
    }, sort: ['2026-10-03T00:04:59Z', 1] }] },
  }));
  const source = createElasticsearchLogSource({
    url: 'http://127.0.0.1:19200', index: 'agentops-lab-logs-test',
    cursorSecret: '0123456789abcdef0123456789abcdef', fetch: fetcher,
    now: () => Date.parse('2026-10-03T00:05:00Z'), id: () => 'snapshot-test', pageSize: 1,
  });
  const page = await source.searchPage({ service: 'checkout',
    start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:05:00Z', requestId: 'capture-1',
  }, new AbortController().signal);
  expect(page.status).toBe('available');
  if (page.status === 'available') expect(page.sourceSnapshotId).toBe('snapshot-test');
  expect(JSON.stringify(page)).not.toContain('pit-');
});
```

矩阵：交错会话、相同游标重试、首次查询重试、cursor 跨查询/篡改、PIT 404、16 会话上限、过期清理、HTTP 重定向、无 body、分片累计超 1 MiB、单条超 8 KiB、无 sort、非法 _source、敏感字段脱敏、Abort、5xx 与鉴权的结构化映射。

- [ ] **Step 2: 跑红。** `pnpm exec vitest run test/elasticsearch-http.test.ts test/elasticsearch-log-source.test.ts test/log-snapshot-registry.test.ts test/log-redaction.test.ts`；预期新模块不存在。

- [ ] **Step 3: 最小实现传输和分页状态机。**

```ts
const body = {
  size: pageSize,
  pit: { id: session.pitId, keep_alive: '2m' },
  sort: [{ timestamp: 'asc' }, { _shard_doc: 'asc' }],
  query: { bool: { filter: [
    { term: { service: query.service } },
    { range: { timestamp: { gte: query.start, lt: query.end } } },
  ] } },
  track_total_hits: false,
  ...(searchAfter === undefined ? {} : { search_after: searchAfter }),
};
```

optional filters 只翻译为固定 term/match_phrase，不接收 DSL。HTTP 用 getReader 累计字节、超限 cancel，完整有界 JSON 再解析；关闭自动重定向。open PIT 用宿主唯一 index，search 用 `/_search`，close 用 `DELETE /_pit`。更新最新 pit_id，逻辑 snapshotId 不变；规范化 timestamp/service/level/message/exception/traceId，并在返回 MCP 前调用纯函数 redactLogRecord；Recorder 默认也调用同一函数。纯函数测试覆盖嵌套 fields、Bearer/sk- 文本、非敏感保留和重复调用幂等。不在适配器复制第二套规则，也不让基础设施导入 application。

Registry 由实例拥有，注入时钟/ID；串行化同一 session 页查询，维护固定查询摘要、初始请求 ID、最新 PIT、第一页/最近页有界缓存。游标 HMAC 比较使用 timingSafeEqual；若重试返回同页则不能前移 cursor。超期返回 UNAVAILABLE，不开新 PIT 拼接。首次查无记录仍返回 available 空页，由上层解释为无证据而不是健康。

- [ ] **Step 4: 定向跑绿，审查缓存和释放。** Step 2 命令，加 `pnpm exec vitest run test/streaming-evidence-recorder.test.ts`；确认任何单次错误都不会暴露 ES body、索引、PIT ID 或凭据。
- [ ] **Step 5: 小提交。** 只 add 本任务明确路径；`git commit -m "feat(elk): implement bounded PIT log pagination"`。

### Task 3: 只读 MCP、lazy 接入与预算贯穿

**Files:**

- Create: `src/infrastructure/mcp/logs-server.ts`
- Create: `src/bootstrap/lazy-elk-evidence-source.ts`
- Modify: `src/infrastructure/mcp/index.ts`、`src/infrastructure/elk/paged-evidence-source.ts`、`src/bootstrap/log-evidence-tools.ts`
- Test: `test/logs-mcp-server.test.ts`、`test/lazy-elk-evidence-source.test.ts`
- Extend: `test/paged-evidence-source.test.ts`、`test/log-evidence-tools.test.ts`

**Interfaces:**

- Consumes: Task 1 `LogsPageBackend`；既有 `McpConnection`、`ResilientExecutor`、`SourceCircuitBreaker`、`RuntimeToolPorts`。
- Produces: `startLogsMcpServer(source:LogsPageBackend, options:{host?:string;port?:number;maxBodyBytes?:number}):Promise<{url:string;close():Promise<void>}>`。
- Produces: `createLazyElkEvidenceSource(options:{mcpUrl:string;executor:ResilientExecutor;now:()=>number;registerShutdownHook:(callback:()=>Promise<void>)=>void}):LogEvidencePageSource`。
- Additive `ElkPageRequestOptions`：`{signal?:AbortSignal;deadline?:number;networkAttemptBudget?:{remaining:number};requestId?:string}`；扩展既有 `pages` 参数，`ElkPageClient.fetchPage` 增加同名可选字段。
- Additive `LogEvidenceToolOptions.clock?:Clock`，缺省 systemClock；Web 注入已有 ports.clock，采集的绝对期限为 min(父期限，开始时刻+budget.maxDurationMs)。
- Additive `ElkPageClient.closeSnapshot?(input:{sourceSnapshotId:string;signal:AbortSignal}):Promise<void>`；旧注入式 Client 不实现也能工作。

- [ ] **Step 1: 写预算、协议错误与 finally 释放测试。**

```ts
it('forwards the same deadline and ledger through every page', async () => {
  const calls: unknown[] = [];
  const ledger = { remaining: 8 };
  const client: ElkPageClient = { fetchPage: async (input) => {
    calls.push(input);
    return { records: [], sourceSnapshotId: 's1',
      ...(input.cursor === undefined ? { nextCursor: 'c1' } : {}) };
  } };
  for await (const page of new PagedEvidenceSource(client).pages({
    service: 'checkout', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:05:00Z',
  }, { deadline: 9000, networkAttemptBudget: ledger, requestId: 'r1' })) void page;
  expect(calls).toHaveLength(2);
  for (const input of calls) expect(input).toMatchObject({
    deadline: 9000, networkAttemptBudget: ledger, requestId: 'r1',
  });
});
```

再测 closeSnapshot 在 EOF、break、Abort 各一次；清理失败不覆盖原错误；过期 UNAVAILABLE 不重试；5xx 最多 3 次实际页调用；ledger 为 0 无网络请求；仅固定两个工具，Origin/Host/GET/未知工具/超体积被拒绝。

- [ ] **Step 2: 跑红。** `pnpm exec vitest run test/logs-mcp-server.test.ts test/lazy-elk-evidence-source.test.ts test/paged-evidence-source.test.ts test/log-evidence-tools.test.ts`；预期新方法与预算断言失败。

- [ ] **Step 3: 组装与最小兼容改动。** MCP Server 复用 settlement-server 的 stateless transport/loopback/Host/Origin/Abort 模式，返回一个 structuredContent，不接收远端任意工具。同步验证固定 schema 和 readonly 标记后才绑定。

```ts
const captureKey = `log:${callOptions.runId}:${callOptions.toolCallId}:${queryDigest}`;
const startedAt = (options.clock ?? systemClock).now().getTime();
const deadline = Math.min(callOptions.deadline ?? Number.POSITIVE_INFINITY,
  startedAt + options.budget.maxDurationMs);
const pages = options.source.pages(query, {
  signal: callOptions.signal,
  deadline,
  ...(callOptions.networkAttemptBudget === undefined ? {} : {
    networkAttemptBudget: callOptions.networkAttemptBudget,
  }),
  requestId: captureKey,
});
```

captureKey 同时传 Recorder；不可生成另一套采集 ID。时间值由注入 Clock 读取。直接调用 source.pages 而缺 deadline 时，只在该次 iterator 入口计算默认 60 秒，不在 fetchPage 重新生成。ResilientElkPageClient 优先用 input deadline/ledger；旧调用没有字段时维持旧默认行为。

lazy source 分别为 connect、listTools、每次页调用使用同一 executor/ledger；一次实际网络调用只计一次，不将整个 lazy.pages 再包一层 retry。静态工具 Schema 不因后端失联改变；调用时 unavailable。McpElkPageClient 增加新判别结果解析，并兼容既有不含 status 的注入式页结果。

iterate 的 try/finally 调 closeSnapshot：独立 1 秒 AbortSignal、无 retry，不使用已中断 parent signal，注册 shutdown 关闭 connection。保留原 snapshot mismatch/repeated cursor 校验。

- [ ] **Step 4: 跑绿及既有 MCP 回归。** Step 2，加 `pnpm exec vitest run test/mcp-http.test.ts test/mcp-resilience.test.ts test/lazy-settlement-tool.test.ts`。
- [ ] **Step 5: 小提交。** 只 add 本任务明确路径；`git commit -m "feat(mcp): connect readonly logs with shared paging budgets"`。

### Task 4: 隔离 Logs Lab 与流式种数

**Files:**

- Create: `infrastructure/logs-lab/compose.yaml`、`infrastructure/logs-lab/prometheus.yaml`
- Create: `src/infrastructure/simulator/log-fixtures.ts`、`src/infrastructure/simulator/logs-lab-status-server.ts`
- Create: `src/infrastructure/elk/log-fixture-writer.ts`、`src/bootstrap/logs-lab.ts`、`apps/logs-lab/index.mjs`
- Modify: `src/infrastructure/simulator/settlement-simulator.ts`、`src/bootstrap/index.ts`、`package.json`
- Test: `test/log-fixtures.test.ts`、`test/log-fixture-writer.test.ts`、`test/logs-lab.test.ts`

**Interfaces:**

- Consumes: Task 2 source，Task 3 Logs MCP；既有 SettlementSimulator、PrometheusSettlementSource、SimulatorMetricsServer、Settlement MCP。
- Produces: `SettlementSimulator.currentSnapshot(): Readonly<{start:number;end:number;success:number;failure:number}>`，返回副本，秒级时间不变。
- Produces: `generateScenarioLogs(snapshot:{start:number;end:number;success:number;failure:number}, scenario:SettlementScenario):AsyncIterable<NormalizedLogRecord>`。
- Produces: `writeLogFixture(options:{url:string;index:string;records:AsyncIterable<NormalizedLogRecord>;signal:AbortSignal;fetch?:typeof globalThis.fetch}):Promise<{recordCount:number}>`。
- Produces: `startLogsLab(options:{elasticsearchUrl:string;prometheusUrl:string;initialScenario?:SettlementScenario;cursorSecret:string;now?:()=>number;id?:()=>string;metricsPort?:number;statusPort?:number;metricsMcpPort?:number;logsMcpPort?:number}):Promise<{metricsMcpUrl:string;logsMcpUrl:string;statusUrl:string;close():Promise<void>}>`。

- [ ] **Step 1: 写场景一致性和部分启动清理测试。**

```ts
it('uses one snapshot for counters and SQL timeout logs', async () => {
  const simulator = new SettlementSimulator(() => 1790985900000);
  simulator.select('settlement_failure');
  const snapshot = simulator.currentSnapshot();
  const records: NormalizedLogRecord[] = [];
  for await (const record of generateScenarioLogs(snapshot, 'settlement_failure')) records.push(record);
  expect(records).toHaveLength(snapshot.success + snapshot.failure);
  expect(records.filter((record) => record.exception === 'SQLTimeoutException')).toHaveLength(15);
  expect(records.every((record) => Date.parse(record.timestamp) < snapshot.end * 1000)).toBe(true);
});
```

补 normal/low_sample，Bulk HTTP 200 含 item error 必须失败，512 KiB 包限、最后换行、refresh/count 不匹配、只写本次 index；启动失败只关闭已创建服务，状态接口不准切换，过期状态不显示 ready。

- [ ] **Step 2: 跑红。** `pnpm exec vitest run test/log-fixtures.test.ts test/log-fixture-writer.test.ts test/logs-lab.test.ts`；新模块/方法不存在。

- [ ] **Step 3: 最小实现。** 创建唯一 `agentops-lab-logs-<snapshotId>`，keyword service/level/exception/traceId、date timestamp、text message；不创建任意模板或修改已有索引。

```ts
const threshold = 512 * 1024;
let lines: string[] = [];
let bytes = 0;
for await (const record of records) {
  const item = JSON.stringify({ index: { _index: index } }) + '\n'
    + JSON.stringify(record) + '\n';
  const size = Buffer.byteLength(item);
  if (size > threshold) throw new Error('FIXTURE_RECORD_TOO_LARGE');
  if (bytes + size > threshold) {
    await postBulk(lines.join(''), signal);
    lines = []; bytes = 0;
  }
  lines.push(item); bytes += size;
}
if (lines.length > 0) await postBulk(lines.join(''), signal);
```

`postBulk(body:string, signal:AbortSignal):Promise<void>` 是 writer 内部有界 HTTP helper，检查 errors 和逐项 status；种数结束 refresh/count，数量一致才开 MCP/ready。只有 fixture writer 有实验索引写能力，Agent 注册表不包含它。

Compose 固定 ES 8.19.12、512 MiB heap，专用 Prometheus 复用已有 v3.5.0 镜像；127.0.0.1 发布 19200/19290。其余端口按 Spec。Exporter 因 Docker 访问需可达 host.docker.internal，不把此例外扩散到 MCP/Web。检查 Windows 防火墙；不自动添加全网入站规则。

CLI 读取 AGENTOPS_LOGS_LAB_SCENARIO/ELASTICSEARCH_URL/LOGS_LAB_PROMETHEUS_URL/LOGS_LAB_CURSOR_SECRET，secret 至少 32 字节；只打印安全 URL、scenario、有效期，不打印 secret/index。SIGINT 关闭自己服务，不删除 Docker 卷或任何业务索引。脚本名 `logs:backend:up`、`logs:backend:stop`、`logs:lab`。

- [ ] **Step 4: 跑绿与配置检查。** Step 2，加 `docker compose -p agentops-logs -f infrastructure/logs-lab/compose.yaml config --quiet`；只校验，不在本任务擅自启动用户 Docker。
- [ ] **Step 5: 小提交。** 只 add 本任务文件；`git commit -m "feat(lab): add immutable Elasticsearch log scenarios"`。

### Task 5: 确定性的 Logs 来源报告

**Files:**

- Create: `src/application/logs-source-report-collector.ts`
- Modify: `src/bootstrap/logs-subagent.ts`
- Test: `test/logs-source-report-collector.test.ts`
- Extend: `test/logs-subagent-runtime.test.ts`

**Interfaces:**

- Consumes: 既有 `SourceReportCollector`/`SourceReportCandidate`/`SourceReportFinalizeInput`、`SourceSubagentRequest`、`SourceSubagentResult`、capture/aggregate 的实际 ToolResponse。
- Produces: `LogsSourceReportCollector(options:{request:SourceSubagentRequest}) implements SourceReportCollector`。
- Additive `LogsSubagentOptions.validateRequest?:SourceSubagentDescriptor['validateRequest']` 和 `collector?:(input:{request:SourceSubagentRequest})=>SourceReportCollector`；未注入时保持现有 generic collector 行为。

- [ ] **Step 1: 写模型伪造事实与错误引用测试。**

```ts
it('does not accept model text as authoritative log counts', () => {
  const collector = new LogsSourceReportCollector({ request: {
    profileId: 'simulation', service: 'checkout', start: '2026-10-03T00:00:00Z',
    end: '2026-10-03T00:05:00Z', question: 'inspect logs', evidenceIds: [],
  } });
  collector.observeToolResult('logs.capture', { blocks: [{ type: 'json', value: {
    evidenceId: 'log-e1', status: 'committed', recordCount: 100, coverage: 1,
    missingEvidence: [], levels: [{ value: 'ERROR', count: 15 }, { value: 'INFO', count: 85 }],
    services: [{ value: 'checkout', count: 100 }], sourceBytes: 40960, truncated: false,
    exceptionSignatures: [{ value: 'SQLTimeoutException', count: 15 }], traceIds: ['t1'],
  } }], evidenceIds: ['log-e1'] });
  collector.acceptReport({ summary: '999 errors, root cause confirmed',
    findings: [{ kind: 'inference', statement: 'database caused failure', evidenceIds: ['log-e1'] }],
    businessTraceIds: ['t1'], missingEvidence: [],
  });
  const result = collector.finalize({ source: 'logs', startedAt: 1, finishedAt: 2,
    parentRunId: 'p1', childRunId: 'c1' });
  expect(result.summary).toContain('100');
  expect(result.summary).not.toContain('999');
  expect(result.summary).not.toContain('confirmed');
});
```

加 source_report 未提交→partial、无 capture→unavailable、partial 不被报告覆盖、伪造引用/traceId 拒绝、多个快照不能合并成完整、聚合结果仅能引用观察过的证据。

- [ ] **Step 2: 跑红。** `pnpm exec vitest run test/logs-source-report-collector.test.ts test/logs-subagent-runtime.test.ts`。

- [ ] **Step 3: 最小报告实现。** 使用 DefaultSourceReportCollector 处理引用/coverage/partial；额外观察实际 capture 与 aggregate facts，以受限解析器核对安全整数、分布、引用关系。finalize summary/observation 由事实渲染，不复制候选 summary 或候选数值。

```ts
const statement = `采集到 ${recordCount} 条日志；其中 SQLTimeoutException ${sqlTimeoutCount} 条。`;
const finding: SourceFinding = {
  kind: 'observation', statement, evidenceIds: [evidenceId],
};
const candidate: SourceFinding = {
  kind: 'inference', statement: 'SQL 超时可能与结算异常有关，尚未验证完整调用链。',
  evidenceIds: [evidenceId],
};
```

只有实际观察到 SQLTimeoutException 才生成该候选，不解释成结算失败率；其他异常返回实际有界排名。缺失 Trace 用固定 missingEvidence 项明示，不将缺 Trace 等同日志采集失败。Report 不能晋级长期经验。

- [ ] **Step 4: 跑绿和 generic Source 回归。** Step 2，加 `pnpm exec vitest run test/source-subagent-runner.test.ts test/source-report-collector.test.ts test/metrics-source-report-collector.test.ts`。
- [ ] **Step 5: 小提交。** add 本任务 4 文件；`git commit -m "feat(logs): derive source facts from observed evidence"`。

### Task 6: Web 的共享 Blob/Logs 组装

**Files:**

- Create: `src/bootstrap/logs-web-source.ts`
- Modify: `src/bootstrap/agent-web-runtime.ts`、`src/bootstrap/index.ts`、`apps/agent-server/index.mjs`
- Test: `test/logs-web-source.test.ts`、`test/logs-web-runtime.test.ts`
- Extend: `test/metrics-web-source.test.ts`、`test/agent-web-runtime.test.ts`

**Interfaces:**

- Consumes: Tasks 3/5 的 source/collector；现有 `RuntimeToolPorts`、`createSharedSourceChildAgentFactory`、`LocalEvidenceReader`、`createLogsSubagentTool`。
- Produces: `createLogsWebSource(ports:RuntimeToolPorts, options:{mcpUrl:string;model:ChatModel;cursorSecret:string}):readonly Tool[]`，仅返回一个 logs_subagent。
- Additive `AgentWebRuntimeOptions.logs?:{profileId:'simulation';mcpUrl:string;childModel?:ChatModel;cursorSecret:string}`。未配置 logs 保持 metrics-only 行为。

- [ ] **Step 1: 写缺依赖 fail closed、工具快照和共享身份测试。**

```ts
it('fails closed when the Web log data plane is absent', () => {
  const { evidenceBlobs, streamingEvidenceRecorder, ...withoutDataPlane } = ports;
  void evidenceBlobs; void streamingEvidenceRecorder;
  expect(() => createLogsWebSource(withoutDataPlane,
  { mcpUrl: 'http://127.0.0.1:19211/mcp', model,
    cursorSecret: '0123456789abcdef0123456789abcdef',
  })).toThrow(/data plane/i);
});
```

`ports` 从真实 `createInspectionRuntime({toolFactories:[capturePorts], ...runtimeOptions})` 中捕获，runtimeOptions 使用 ScriptedModel 和临时 SQLite 路径；`capturePorts` 保存注入参数并返回空数组。等待 runtime.ready 后测试，再 finally 关闭；不用 any 强转或手工伪造整个 RuntimeToolPorts。断言父模型只有 metrics_subagent/logs_subagent，子模型只有日志 4 工具+source_report，EvidenceStore/Checkpoint/V2 实例身份相同。

- [ ] **Step 2: 跑红。** `pnpm exec vitest run test/logs-web-source.test.ts test/logs-web-runtime.test.ts test/agent-web-runtime.test.ts`。

- [ ] **Step 3: 最小组装。**

```ts
const reader = new LocalEvidenceReader({
  blobStore: ports.evidenceBlobs,
  manifests: ports.evidenceManifests,
  cursorSecret: options.cursorSecret,
  maxChunkBytes: 8 * 1024 * 1024,
  maxScanRecords: 50_000,
});
const budget: EvidenceCaptureBudget = {
  maxSourceBytes: 64 * 1024 * 1024, maxRecords: 50_000,
  maxDurationMs: 60_000, maxModelSummaryBytes: 16 * 1024, maxSamples: 3,
};
```

以上先检查三个 data-plane ports 非空，TS narrowing 后构造。child factory 传相同 checkpoints/evidence/evidenceRecorder/sharedEvents/clock/ids；日志工具也注入同一 clock；注入 Task 5 collector 和 Task 1 Scope 校验，question 限 2 KiB，首轮 evidenceIds 必须为空。真实日志工具照常经过已有 Pipeline/Hook/Guard，不绕过任何执行层。

Web 仅 logs 模式增加 evidenceBlobRootPath=`join(dataDirectory,'evidence-blobs')`、logs 工具工厂、allowed_tools 文本；仍用一个 runtime.ready/SQLite owner。logs 没 metrics、非法 URL/credentials、短 cursorSecret 启动失败，错误不回显配置值。

CLI 增加可选 `AGENTOPS_LOGS_MCP_URL` 和配套 `AGENTOPS_EVIDENCE_CURSOR_SECRET`；保留现有 env 和 metrics-only 启动。prepareStart 仍同步产生服务/latest300s可信上下文，不改为事件命令总线或另一个主循环。真实来源窗口按已有元数据说明，不能宣称请求窗口与快照时间完全相等。

- [ ] **Step 4: 跑绿及公共边界回归。** Step 2，加 `pnpm exec vitest run test/metrics-web-source.test.ts test/web-query.test.ts test/web-query-sqlite.test.ts test/event-message-v2-acceptance.test.ts`。
- [ ] **Step 5: 小提交。** add 本任务明确路径；`git commit -m "feat(web): assemble shared logs subagent evidence runtime"`。

### Task 7: 大证据、恢复与真实后端验收

**Files:**

- Create: `test/logs-web-durable.test.ts`、`test/logs-web-real-elasticsearch.test.ts`、`test/logs-large-evidence-acceptance.test.ts`
- Extend: `test/fixtures/generated-log-pages.ts`、`test/log-evidence-tools.test.ts`
- Conditional focused fix only: `src/bootstrap/log-evidence-tools.ts`、`src/application/streaming-evidence-recorder.ts`，仅当下面的恢复测试证实 captureKey/ID 回放缺陷。

**Interfaces:**

- Consumes: Task 4 `startLogsLab`、Task 6 `startAgentWebRuntime`；现有 Manifest/Blob/HTTP query 接口与 scripted ChatModel。
- Produces: 无新生产接口。测试 fixture 增加 `generateLargeLogRecords(options:{count:number;paddingBytes:number;start:string;end:string}):AsyncIterable<NormalizedLogRecord>`；不预生成整个数组。

- [ ] **Step 1: 写确定性有界验收。**

```ts
expect(manifest.sourceBytes).toBeGreaterThanOrEqual(50 * 1024 * 1024);
expect(manifest.sourceBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
expect(manifest.chunks.length).toBeGreaterThan(1);
expect(manifest.chunks.every((chunk) => chunk.sourceBytes <= 4 * 1024 * 1024)).toBe(true);
expect(Buffer.byteLength(JSON.stringify(toolResponse))).toBeLessThanOrEqual(16 * 1024);
expect(JSON.stringify(publicEvidence)).not.toContain('RAW_LOG_CANARY');
expect(publicEvidence.retrievable).toBe(false);
```

fixture 流式产生 14,000 条带 4,096 字节 padding 的日志；实际字节验证 50–64 MiB，不按条数猜容量。大测试显式 ledger=1,024；另测 ledger=2 或字节预算不足→partial/明确缺失证据，不能擅自扩默认值。spy 记录页/块缓存高水位，不用不稳定的 heap delta 判通过。

恢复矩阵：关闭 ES 后本地 aggregate 仍可读；完成后重启 Web 父证据仍包含 metrics/log，usage 不变、model 调用计数不增加；使用同一 cursorSecret 的片段游标重启有效，换 secret 拒绝；另一个 Run 无法读；采集中 Abort、不完整 Blob 不可见；同 captureKey 恢复不生成重复可见证据。第一页来源失败必须保留 MCP_AUTH_ERROR/MCP_TIMEOUT 等稳定来源错误类别，不能包装成假 STORAGE_ERROR；有已提交页则走现有 partial，不能抛弃已提交证据。

- [ ] **Step 2: 跑新验收获得真实结果。** `pnpm exec vitest run test/logs-web-durable.test.ts test/logs-large-evidence-acceptance.test.ts`；既有实现若已通过某项直接记录，不为了“红”故意改坏代码。真实 ES 测试此时默认 skip。

- [ ] **Step 3: 修复只限证实的缺口。** Capture 回放必须以已有 captureKey 对应 Manifest 为权威，校验 queryDigest/run/toolCall 匹配；返回已提交的 evidenceId，而不是要求一次新生成 ID 相等。不得改 Checkpoint 语义、清空 Manifest 或重复写 committed Blob。PIT 丢失不重开拼接，pending 恢复策略沿用现有验证管线并明确 unavailable。

```ts
const visible = await manifests.getVisible(result.evidenceId);
if (visible === null || visible.captureKey !== captureKey
  || visible.runId !== callOptions.runId || visible.queryDigest !== queryDigest) {
  throw new SourceFailure('MCP_PROTOCOL_ERROR');
}
```

由 existing recorder 负责 captureKey 去重，不新增第二份幂等账本。返回 ToolResponse 的 evidence_ref/evidenceIds 必须同时使用回放的 result.evidenceId，不继续引用本次新生成的变量。来源错误通过 contracts 的结构化错误解析保留，不能让 application 导入 Elasticsearch/MCP 具体错误类。任何修复先补失败测试再改生产代码。

- [ ] **Step 4: opt-in 实际后端全链路。**

```powershell
docker compose -p agentops-logs -f infrastructure/logs-lab/compose.yaml up -d
if ($LASTEXITCODE -ne 0) { throw 'Logs backend startup failed' }
$env:AGENTOPS_REAL_LOGS_WEB = '1'
pnpm exec vitest run test/logs-web-real-elasticsearch.test.ts
Remove-Item Env:AGENTOPS_REAL_LOGS_WEB
```

此步骤要先确认 Docker 可用；只启动本次 Compose 项目。test 自己启动/关闭 LogsLab，使用脚本父/子模型；每场景重新生成新鲜快照并等待一次 Prometheus 抓取。断言服务和窗口重叠，normal、15% breach+15 SQL 超时、低样本仍不足、关闭日志 MCP 后 metrics 仍完成、PIT 过期非重试。未执行 opt-in 必须标记未验收，不能用 mock 通过代替。

- [ ] **Step 5: 小提交。** add 本任务测试及已证实的两处内必要修复；`git commit -m "test(logs): cover bounded evidence recovery and real backends"`。

### Task 8: 浏览器验收、手册与交付

**Files:**

- Create: `playwright.logs.config.ts`、`test/e2e/logs-fixture-server.mjs`、`test/e2e/logs-web.spec.ts`
- Create: `test/fixtures/bounded-smoke-fetch.ts`、`test/bounded-smoke-fetch.test.ts`
- Create: `docs/guides/logs-web-elasticsearch-local.md`
- Modify: `playwright.config.ts`、`docs/guides/agent-web-local.md`、`package.json`
- No default UI redesign; only evidence-backed defects may modify `apps/agent-web/src/` after a failing browser test identifies the exact file.

**Interfaces:**

- Consumes: Task 7 real-backend fixture 与现有父 Run evidence/usage/read APIs。
- Produces: `logs:e2e` 脚本，默认 Playwright 不运行新 opt-in spec；原 Metrics opt-in 模式继续通过。
- Produces: `createBoundedSmokeFetch(options:{fetch:typeof globalThis.fetch;limit:number;maxOutputTokens:number;onAttempt:(count:number)=>void}):typeof globalThis.fetch`，仅用于可选烟测，并注入既有 `CreateOpenAICompatibleModelOptions.fetch`。
- 新 config 的隔离 agent/web/control 端口 45200/45273/45201；Logs Lab 用 192xx，fixture 检查占用后 fail，不关闭用户进程。

- [ ] **Step 1: 写 UI 流式和证据边界测试。**

```ts
test('shows both source references without raw log payload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox').fill('检查 checkout 结算异常，并关联日志证据');
  await page.getByRole('button', { name: /发送|开始巡检/ }).click();
  await expect(page.getByText('metrics', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('log', { exact: false }).first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('RAW_LOG_CANARY');
  await expect(page.locator('body')).not.toContainText('pit-');
});
```

执行者先读现有 agent-web.spec.ts，按实际 accessibility label 精确化 locator，不能靠增加无意义文本让测试通过。断言父/两子 Run、证据弹层摘要/引用、无原文按钮、coverage/missingEvidence、取消、SSE 断线补拉、宿主重启后只读访问及累计 usage 不重复；用 API/DOM 双层验证，不仅检查自然语言。

- [ ] **Step 2: 默认测试跑红/隔离验证。** `pnpm exec playwright test --config=playwright.logs.config.ts` 在 opt-in 未设置时必须清楚跳过或提示前置条件，不能自动调用 API。真实执行设置 AGENTOPS_REAL_LOGS_WEB=1，并确认 Task 7 后端。

- [ ] **Step 3: 最小 fixture 和手册。** Fixture 只用脚本模型，通过自己的 control API 等待 ready/restart/offline，不注册测试控制接口到正式 Agent Server。旧 playwright.config.ts 增加排除 logs-web.spec.ts，避免固定工具和 real-metrics 意外执行它。

手册必须包含三终端启动、环境变量、固定场景/120 秒有效期、只读边界、日志分页预算、授权烟测上限、失败排查、只关闭自己服务的命令。配置例子：

```powershell
$env:AGENTOPS_METRICS_MCP_URL = 'http://127.0.0.1:19210/mcp'
$env:AGENTOPS_LOGS_MCP_URL = 'http://127.0.0.1:19211/mcp'
$env:AGENTOPS_EVIDENCE_CURSOR_SECRET = '待输入至少32字节并在重启后保持一致的私有值'
$env:AGENTOPS_WEB_PROFILE = 'simulation'
```

上面是位置说明，不可作为可运行 secret；正式手册用 Read-Host 安全读取并检查长度，不打印密钥。沿用已有模型配置，不在文档写实际 API Key。Lab secret 与内部 Blob cursorSecret 用不同配置，不能放 VITE_ 变量。

烟测 fetch wrapper 的红测试必须断言共享两个模型的第 11 次请求未到真实 fetch，以及发送 body 中 max_tokens=512。包装器在 `/chat/completions` 网络边界计数，包含 retry/fallback，不在外层 ChatModel 调用数上偷换概念；所有父/子模型使用同一个 wrapper 实例。读取 SDK 的有限请求 JSON，设置 max_tokens=512 并移除冲突的 max_completion_tokens，保留 stream/工具/消息及请求头，不记录 body 或 Authorization。达到请求上限返回安全 HTTP 402 source body，阻断进一步网络发送；上层 terminal 分类必须不再重试，并结束此次烟测。默认测试只调用 vi.fn fetch；手册展示 wrapper 注入方式且不提供自动付费脚本。

- [ ] **Step 4: 跑质量门和浏览器。**

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm web:typecheck
pnpm web:build
$env:AGENTOPS_REAL_LOGS_WEB = '1'
pnpm exec playwright test --config=playwright.logs.config.ts
Remove-Item Env:AGENTOPS_REAL_LOGS_WEB
```

逐项核对 exit code，上一项失败不宣称全绿。保存测试计数、父子 Run/evidenceId、usage、覆盖度、缺失证据、重启前后比较、浏览器截图；不保存原始日志/凭据。旧 fixed-tools 和 Metrics opt-in 另作回归。真实模型烟测单列“未授权/未运行”或实际次数/usage，不能自动发生。

- [ ] **Step 5: 审查并提交。** 新实现做 Spec 符合性与代码质量两轮审查；定向修复后重跑受影响质量门。`git diff --check`、`git status --short`，只 add 本任务文件；`git commit -m "test(web): close readonly Elasticsearch logs acceptance loop"`。push 不属于本计划自动权限；用户授权后核对远端分支/hash。

## Spec 覆盖检查与完成定义

| Spec 要求 | 任务/证据 |
|---|---|
| Scope、只读、无 DSL、无业务写入 | 1/3/6 schema 和注册表测试 |
| PIT、最新 ID、opaque cursor、重试一致、过期失败 | 2/3 状态机与传输测试 |
| 真实后端与固定实验场景 | 4/7 Compose 与 opt-in |
| 64 MiB/50k/60s、页块流式、模型 16 KiB | 2/3/6/7 数值/缓存高水位断言 |
| 确定性日志事实、低样本、根因只作候选 | 5/7 来源事实测试 |
| Shared Harness/SQLite/Blob、主子工具隔离 | 6 实例身份与 schema 测试 |
| partial、Abort、源离线、完成后恢复 | 3/7/8 故障注入/重启 |
| 摘要/引用页面、无原始日志与凭据 | 6/7/8 DTO/SSE/DOM 检查 |
| 所有质量门、旧 Metrics 行为不回归 | 8 完整命令结果 |
| 费用上限 | 8 文档与可选烟测共享计数器 |

每一行都要有执行记录才能标记本迭代完成。未开启真实 Elasticsearch/浏览器验收时，只能称“实现和默认测试通过”；不能称真实日志闭环通过。

后续而非本计划：Simulator Web 多来源热切换、Trace/Tempo、业务项目接入、告警/定时触发验收、生产鉴权和数据留存策略、白名单真实保护动作。
