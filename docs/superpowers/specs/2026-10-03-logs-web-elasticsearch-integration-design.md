# Logs Subagent → Elasticsearch → Agent Web 集成设计

状态：待用户审核；本文件不代表已实现或已经验收。日期：2026-10-03。

## 1. 目标与基线

在已验收的 Metrics Web 闭环旁，补一条日志取证链路：模拟器生成日志，真实 Elasticsearch 存储，只读 MCP 分页查询，Logs Subagent 调用普通日志工具，主 Agent 汇总来源报告，Agent Web 展示摘要和证据引用。

代码核对基线：`codex/event-message-v2`，`4607856`。已有能力直接复用，不另建 Agent 循环：

- `src/bootstrap/logs-subagent.ts`：子 Agent Tool 适配、共享 Harness、来源报告。
- `src/bootstrap/log-evidence-tools.ts`：采集、检索、聚合、片段读取四个普通工具。
- `src/infrastructure/elk/paged-evidence-source.ts`：分页、游标重复检测、来源快照一致性及重试装饰器。
- `src/application/streaming-evidence-recorder.ts`：脱敏、gzip NDJSON Blob、Manifest 和部分采集。
- `LocalEvidenceReader`、SQLite 单一所有者、父 Run 后代证据列表、持久化用量统计。

当前缺口：没有真实 Elasticsearch 查询实现和日志 MCP Server；Web 没有开启日志 Blob 数据通道；实验室只提供 Prometheus；通用 Logs 来源报告尚未把数值事实收敛为确定性输出。

## 2. 范围和非目标

本次实现正常、结算失败、低样本三个可重复实验场景，以及日志源离线、分页失败、取消、预算耗尽、大证据与完成后重启验收。

固定边界：TypeScript、Node.js 20、pnpm；`profileId=simulation`、`service=checkout`、查询窗口 300 秒；不修改 `group-buy-market`；不注册 Bash、任意 HTTP/SQL/DSL 或业务写工具。

本轮不接 Logstash/Kibana、Tempo、真实业务日志、生产鉴权平台、自动降级/熔断、正式经验晋级，也不承诺确定的 MySQL 根因。日志中的 SQL 超时属于事实；它解释业务失败仍是根因候选，需要 Trace 等后续证据。

浏览器证据页面始终只展示摘要、状态、引用、覆盖度和哈希；`retrievable=false` 不改为原文下载。子 Agent 的本地证据工具可在权限范围内读取脱敏、限量的片段，这是不同于公开证据 API 的内部通道。

## 3. 方案选择

| 方案 | 结果与代价 |
|---|---|
| 仅注入假 ELK Client | 便宜但不能验证真实查询、分页与 MCP；不作为本轮验收 |
| 真实 Elasticsearch + 现有 MCP/Logs Subagent | 推荐；覆盖缺口，复用已有执行、压缩、恢复和审计机制 |
| 完整 ELK + Trace + 业务项目接入 | 涉及多个独立子系统，超出本次迭代 |

依赖方向保持不变：具体 Elasticsearch、MCP、文件存储都在基础设施与 bootstrap；Agent 核心仅消费已有接口。

## 4. 运行链路与工具可见性

```text
Logs Lab 的固定场景
 ├─ 指标 exposition → Prometheus → Metrics MCP → metrics_subagent
 └─ 有界 Bulk 写入 → Elasticsearch → Logs MCP → logs_subagent
                                                    ├─ logs.capture
                                                    ├─ logs.search_evidence
                                                    ├─ logs.aggregate_evidence
                                                    ├─ logs.read_evidence_slice
                                                    └─ source_report
主 Agent → 来源报告 + evidenceId → 现有 V2 Store/Projector → Agent Web
                                   └─ SQLite Manifest + 本地脱敏 Blob
```

主 Agent 的工具快照只有 `metrics_subagent`、`logs_subagent`；普通日志工具不暴露给父 Agent。框架仍按既有并发声明和预算调度，不强行将两个子 Agent 标为并发安全。日志采集继续 `verify_before_retry`、非并发安全。

首轮 Logs 调用不传跨来源 `evidenceIds`；指标证据不属于日志证据。保留既有父 Run 日志提示的归属检查，不为了本次集成放宽跨 Run 读取。

## 5. Elasticsearch 与分页协议

本地后端固定镜像 `docker.elastic.co/elasticsearch/elasticsearch:8.19.12`，单节点，512 MiB JVM heap，端口仅发布在 `127.0.0.1:19200`。关闭鉴权仅限这个隔离实验室，不可照搬到生产。

采用 Node 原生 `fetch`，不新增 Elasticsearch SDK。服务端配置唯一索引；模型只提供结构化服务、时间和有限过滤字段，不能指定 URL、索引、字段路径、排序或 DSL。

分页使用 PIT + `search_after`，排序为 `timestamp`、`_shard_doc`。ES 每次返回的新 PIT ID 只保留在适配器内部；对外 `sourceSnapshotId` 是稳定的逻辑 ID，不能使用会轮换的 PIT ID。此选择依据 [Elastic 分页文档](https://www.elastic.co/guide/en/elasticsearch/reference/8.19/paginate-search-results.html) 和 [PIT 文档](https://www.elastic.co/guide/en/elasticsearch/reference/8.19/point-in-time-api.html)。

MCP 提供两个固定协议操作，不注册为主 Agent 工具：

- `logs.search_page`：严格 Schema，返回有界 `records`、稳定 `sourceSnapshotId`、可选 `nextCursor`，或结构化 `source_error`。
- `logs.close_snapshot`：仅关闭查询资源；不修改业务索引，结果不含 PIT ID。

游标必须绑定逻辑快照、查询摘要和 `search_after`，使用 HMAC 防篡改；不包含明文索引或 PIT。相同采集请求 ID 的第一页重试、相同游标的末页重试返回同一页，不重新开 PIT。每个会话至多缓存第一页和最近一页，不保存整次结果。

PIT 过期、服务重启丢失会话、游标篡改、跨查询游标和重复游标都不能静默重新打开快照继续拼接。过期返回非重试型 `UNAVAILABLE`；已提交页可以形成 partial，未提交任何页则 unavailable。

EOF、预算截断、消费者提前关闭、Abort 时均尝试关闭 PIT。清理使用独立 1 秒期限、无重试；失败记录安全错误码且依靠 PIT 的 2 分钟 TTL 回收，不覆盖原始错误。实验室关闭也释放它拥有的查询资源。

日志源构造时必须注入清理失败报告回调；回调只接收稳定 `AgentErrorCode` 和可选逻辑 `sourceSnapshotId`，不得收到 PIT ID、索引名或服务端响应体。报告回调自身失败不得覆盖原查询/取消结果。活跃 PIT 限制为 16；为支持请求重放，已关闭快照可短期保留第一页和最近页缓存，但总缓存快照也必须有界，淘汰后同一 requestId 只能安全返回 unavailable，不能重新打开新 PIT。

## 6. 有界数据和预算

| 层 | 限制 |
|---|---|
| Elasticsearch 一页 | 32 条；单条规范化记录最多 8 KiB |
| ES HTTP 响应 | 最多 1 MiB；读取过程中计数，超限取消 body |
| 规范化 EvidenceSourcePage | 最多 512 KiB |
| 活跃 PIT 会话 | 最多 16；每个缓存最多 2 页 |
| 一次采集 | 64 MiB、50,000 条、60 秒，取首先命中的限制 |
| Blob 分块 | 复用现有 4 MiB 目标；读取解压上限 8 MiB |
| 模型 ToolResult | 最多 16 KiB，最多 3 个脱敏样本 |
| 检索/片段 | 每次最多 20 条，单字段沿用 1,024 字符限制 |

禁止 `response.json()` 无界读取、全量日志拼接、全量 Bulk 数组或将 Blob 原文塞入 SSE。采集、入库及读取均按页/块流动。

`ToolCallOptions.deadline` 和共享 `networkAttemptBudget` 必须传到采集源。连接、发现、每次 MCP 页请求消耗同一 ledger；不能在每页重置期限，也不能在多个装饰层叠乘重试。ES Server 对单次请求只执行一次；客户端复用 `ResilientExecutor`，瞬态失败最多重试 2 次。

50 MiB 测试采用无模型的确定性数据管线，并显式注入 1,024 次网络请求预算。默认 Agent 的较小网络预算必须仍然生效；大数据需要更多页时返回 partial，不擅自扩大所有生产 Run 的预算。真实模型不是“大数据处理器”。

空日志不是健康结论；当前 Recorder 无记录时不创建可见 committed Manifest。Abort 不把中断内容包装成完整证据。`coverage` 沿用现有定义，不等同于“因果链完整率”。

## 7. 固定场景实验室

新增独立 Compose 项目 `agentops-logs`，不改现有 `agentops-metrics` 服务：

| 服务 | 地址 |
|---|---|
| Elasticsearch | `127.0.0.1:19200` |
| 专用 Prometheus | `127.0.0.1:19290` |
| 模拟指标 exporter | 宿主端口 19208，供 Docker 抓取 |
| 实验状态 HTTP | `127.0.0.1:19209`，只读 |
| Metrics MCP | `127.0.0.1:19210/mcp` |
| Logs MCP | `127.0.0.1:19211/mcp` |

每次启动确定一个不可变场景与一个共享模拟快照；日志和指标使用同一快照时间及测试 traceId。创建新的 `agentops-lab-logs-<snapshotId>` 索引，只写该次实验索引，不清空任何现有索引。Bulk 总包不超过 512 KiB，逐项检查错误，显式 refresh 并核对 count 后才输出 ready。[Bulk 文档](https://www.elastic.co/guide/en/elasticsearch/reference/8.19/docs-bulk.html)；[固定镜像记录](https://www.docker.elastic.co/r/elasticsearch/elasticsearch:8.19.12)。

- normal：100 次成功、0 次失败；100 条普通日志。
- settlement_failure：85 次成功、15 次失败；100 条日志，其中 15 条 `SQLTimeoutException`。
- low_sample：2 次成功、8 次失败；10 条日志，其中 8 条 SQL 超时；指标结论仍为 insufficient_data。

SQL 超时日志集中在快照结束前 30 秒，确保首次最新窗口可查到；完整时间与来源仍记入证据。指标后端已有 120 秒快照新鲜度限制，不修改此安全语义。ready 后须在有效期内开始实验；过期返回 stale/unavailable，重启自己拥有的 Lab 生成新场景，不伪造时钟。

此轮不做热切换。只读状态 API 明确返回场景、snapshotId、有效期与 readiness，拒绝切换请求。既有 Metrics Simulator 的管理接口保持不变。后续 Simulator Web 多来源原子切换另立 Spec。

## 8. 来源事实与诊断语义

为 Web 日志模式注入 `LogsSourceReportCollector`，复用 `SourceReportCollector` 接口和现有引用校验：

- 计数、等级分布、异常分布、traceId 来自实际 capture/aggregate 结果，不采用模型在 source_report 中编造的数字。
- 事实用 `observation`；“SQL 超时可能影响结算”为 `inference`，不能宣称已确认数据库根因。
- 未取到日志为 unavailable；部分采集、未提交 source_report、窗口不匹配为 partial。
- 无 Trace 工具时不能宣称完整链路已验证；缺失证据和来源状态保留在父 Run。
- Metrics 与 Logs 只在共同服务和重叠窗口下描述关联，不把日志条数当作结算请求分母。

不新增跨来源确定因果工具；正式 Trace 关联和根因规则属于下一迭代。

## 9. Web 组装、持久化与兼容

`AgentWebRuntimeOptions` 增加可选 `logs` 配置：simulation、MCP URL、可选 childModel、必需稳定 `cursorSecret`。已有 metrics-only 启动和工具快照保持不变。logs 模式要求同时配置 metrics；缺项启动失败，不以假日志客户端替代。

Web 在创建 Runtime 时传入 `evidenceBlobRootPath=<dataDirectory>/evidence-blobs`。`createLogsWebSource` 使用现有 `RuntimeToolPorts.evidenceBlobs/evidenceManifests/streamingEvidenceRecorder`，缺失即 fail closed；不能另建 SQLite 或另起 Recorder。

共享子 Agent Factory 沿用同一模型抽象、Checkpoint、EvidenceStore、V2 Publisher/Store 和时钟/ID 注入。内部 `LocalEvidenceReader.cursorSecret` 从 `AGENTOPS_EVIDENCE_CURSOR_SECRET` 配置，至少 32 UTF-8 字节且重启保持一致；不得写入 DTO、SSE、日志或模型。

新增协议和可选接口字段不修改 V1/V2 公共事件、消息块、ToolResponse 或 SQLite Schema，不需要持久化迁移。PIT ID 与远端分页会话仅存在于日志 MCP 内部；Manifest 保存逻辑快照 ID、证据引用及既有恢复元数据。

验收承诺是完成后 Run、证据与用量在重启后保持可查，且本地 Blob 读取不依赖在线 Elasticsearch。进行中的 PIT 会话跨日志 MCP 重启不保证恢复；必须明确失败，不能新旧拼接。已有 captureKey/Checkpoint 语义不变，重复恢复不能生成第二份可见证据；发现捕获 ID 回放不一致时在原执行单元修复并补测试。

## 10. 验收与费用

默认单元测试全部使用假传输/脚本模型，不需要 Docker、API Key 或付费模型。真实后端测试 opt-in、独立端口、只管理自己创建的资源。

验收断言覆盖：父子 Run 关系，两来源引用归属，日志事实，低样本，日志失联不拖垮指标，PIT 过期/页重试一致性，50 MiB 有界采集，预算 partial，Abort，完成后重启和无原文泄露。

最后可选一次人工授权的真实模型烟测：一个父 Run、最多一个 Metrics 子 Run 和一个 Logs 子 Run，最多 10 次模型 HTTP 请求、每次输出上限 512 tokens；额外请求必须在发送前拒绝，并记录实际 usage。跨子 Run 的计数器要由测试包装器共享，不能只靠提示词承诺。未获授权或达到上限立即停止；不自动重复付费测试，也不估算未核实的人民币花费。

## 11. 执行门槛与交付

配套计划：`../plans/2026-10-03-logs-web-elasticsearch-integration.md`。两份文档均为待审核稿。

用户确认本轮范围、固定场景限制、摘要页面和费用上限后，按依赖顺序逐任务 TDD 实施；每任务做 Spec 与代码质量审查。完成四个质量门和 Web 检查后再提交验收结论；是否 push 由用户授权。不得把本轮日志接入完成称为整个项目“可上线”。
