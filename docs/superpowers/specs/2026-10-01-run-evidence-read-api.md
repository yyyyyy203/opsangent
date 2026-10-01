# Run / Evidence 只读查询 API

## 目标

为 Agent Web 提供可分页、可恢复、可审计的 Run 与 Evidence 查询能力。查询层只返回公开读模型，不直接序列化 `AgentContext`、`EvidenceRecord.raw`、Blob storage key、工具原始响应或内部凭据。

本增量不修改 Agent Harness 的主循环，不新增 Event/Message 类型，也不开放动作执行接口。

## 分层

```text
HTTP/SSE
  -> InspectionQueryService（contracts 只读接口）
      -> InMemoryInspectionQueryService（默认运行时/测试）
      -> SqliteInspectionQueryService（SQLite 生产边界）
          -> checkpoint、event、evidence、manifest 端口/控制面
```

SQLite 查询 Evidence 列表时只选择摘要列，不选择 `evidence_records.raw_json`。大证据只允许 `committed` 或 `partial` Manifest 进入公开列表；`pending`、`failed`、`deleting` 不可见。

## HTTP 契约

- `GET /runs?profileId=&status=&cursor=&limit=`：返回 Run 摘要分页。
- `GET /runs/:runId`：返回状态、阶段、版本、证据引用、缺失证据、失败摘要和 Subagent 父子关系。
- `GET /runs/:runId/evidence?cursor=&limit=`：返回 inline evidence 与可见 Manifest 的统一分页目录。
- `GET /runs/:runId/evidence/:evidenceId`：返回安全证据元数据；跨 Run 或不可见证据返回 404。
- `GET /runs/:runId/events`：继续使用 V2 Public Event SSE；重连游标在发送响应头前校验。durable catch-up 必须按批产出，不能在首帧前将整个 Run 事件历史聚合到内存；有重连游标且存在公开消息时，先发送安全消息快照，保证 transient delta 过期后 UI 可恢复。

分页使用不透明的 keyset cursor，Run 按 `updatedAt/runId` 倒序，Evidence 按 `capturedAt/evidenceId` 正序；默认 50 条，最大 100 条。列表实现每次仅请求各来源当前页；Manifest 内部自行保留一条探测记录，调用方不得将 `limit + 1` 传入 Manifest 公开接口。

## 公开边界

- 消息快照删除 `metadata`、`raw_tool_call`、artifact/image URI 和 ToolResult.response，仅保留状态、错误码、工具身份、evidenceId 和用户可见文本。
- Evidence 只返回摘要、覆盖率、时间范围、大小、状态和哈希；原始日志、Prometheus 响应、trace 内容不经该 API返回。
- 摘要字符串和 JSON 递归执行长度、深度、数组数量和敏感字段限制；Token、Cookie、密码、storage key、内部地址被过滤或替换。
- HTTP 默认继续监听 loopback。部署到远程地址时必须配置 `allowedOrigins` 并在宿主层增加认证授权；未配置查询服务时查询接口返回 503。

## 验收

- 内存与 SQLite 查询都覆盖分页、同时间戳稳定游标、重启恢复和跨 Run 隔离；内存实现不得为一个公开页面加载全量 evidence。
- `pending` Manifest 不可见，`committed` Manifest 可见。
- `limit=100` 与 Manifest 联合目录可用；超过首个事件批次的 `SUBAGENT_STARTED` 仍能解析父子 Run 关系。
- SSE 快照不包含原始 ToolResponse、参数 Token 或内部地址。
- 全量 `lint`、`typecheck`、`test`、`build` 和 `git diff --check` 通过后，才进入 Agent Web 页面实现。
