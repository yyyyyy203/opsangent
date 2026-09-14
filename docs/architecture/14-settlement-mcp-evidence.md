# 结算指标 MCP 与证据闭环

## 当前链路

SettlementSimulator → 只读 /metrics → 真实 Prometheus → PrometheusSettlementSource → 官方 SDK 本地 MCP 服务 → HttpMcpConnection → Manifest/可靠性执行器 → metrics.settlement Tool → Harness/Pipeline → EvidenceStore（内存或 SQLite）。日志领域另有注入式分页源 → `logs.capture` → StreamingEvidenceRecorder → SQLite Manifest + 本地 gzip BlobStore → `logs.search_evidence`/`logs.aggregate_evidence`/`logs.read_evidence_slice`。

主 Agent 使用统一 tool_call，无专门的指标执行分支。诊断模型可接 OpenAI-compatible 适配器，测试仍使用 ScriptedModel；指标证据可由 SQLite EvidenceStore 持久化，日志大证据使用 Manifest/Blob 数据面。2026-09-14 已通过本地指标与日志证据的 runtime 重启验收；验证不代表已接入真实模型凭据、真实 ELK/Tempo、来源 Subagent 或真实业务系统。

## 模块入口与替换边界

- startSettlementMcpServer(source, { port })：注入 query(signal) 来源接口，使用官方 SDK 的无状态 Streamable HTTP，每个 POST 独立 transport。
- bindSettlementEvidenceTool({ connection, evidence, executor, signal, id?, now? })：组装本地 Manifest、来源错误映射、摘要计算和证据保存；返回标准 Tool。
- createLogEvidenceTools({ source, recorder, manifests, reader, budget, id? })：组装分页日志采集、Manifest/Blob 证据保存和有界二次读取 Tools；source、reader 和 recorder 均由 bootstrap 注入，工具本身不依赖具体 ELK SDK。
- createInspectionRuntime：已有只读组装入口，注册上述 Tool，由原 Harness、Guard、Hook、Runner 执行。

远程工具 get_settlement_snapshot 只接受严格的 { service: 'checkout' }。本地工具名称 metrics.settlement，拒绝额外参数和其他服务。阈值 5%、最小样本 20 属于本地 settlement Profile，远程返回结果不能修改它们。

## 返回与证据

远程结果为 available / unavailable / source_error 判别联合，本地必须 Schema 校验，不把文本当有效指标。可用结果再次验证窗口、计数与原文存在性。

成功时先调用 EvidenceStore.save，保存 runId、原始响应、采集时间和结构化摘要，再返回摘要、evidence_ref 块及 evidenceIds；SQLite 模式下进程重启后仍可回查。日志 capture 先写 Blob chunk 和 Manifest，只有 Manifest 进入 committed/partial 可见状态后才发布 `EVIDENCE_COLLECTED` 和返回 evidence reference；原始内容不进入模型消息，二次读取通过当前 Run 绑定的 evidenceId 和有界 cursor 完成。摘要明确缺少 logs/traces，不能据此声称 MySQL 根因已确认。

unavailable 返回 insufficient_data 和缺失证据，无虚构引用。保存失败返回 STORAGE_ERROR，不返回成功结果或不可回查的引用。内存模式只适合测试；SQLite 模式支持指标证据、Checkpoint、Event/Message 和日志 Manifest 的进程重启回查，本地 Blob 根目录必须显式配置，生产对象存储/KMS 和保留清理仍未接入。

## 重试、安全与限制

来源错误先转成有限白名单的 source_error，再在已有客户端 ResilientExecutor 内转成 SourceFailure。因此重试、熔断、父 Run 截止、共享网络尝试预算仍只有一个控制点。MCP 服务端不重试。

503 等 5xx 可重试；401/403 不重试。超时和网络错误使用标准错误码。当前 Prometheus 429 尚未透传 Retry-After，保守映射为非重试协议错误，不能宣称已经覆盖该来源的完整限流退避。错误文案不携带上游响应体或底层存储细节。

服务仅监听 127.0.0.1，验证 Host，拒绝带 Origin 的浏览器请求；只接受 POST /mcp，其他路径/方法拒绝。请求体最多 32 KiB，配置请求超时，限制活跃 MCP transport 数量。关闭时取消活跃来源请求和连接。它是本机单用户实验服务，不是可直接公开部署的多租户认证网关。

## 本轮兼容性修复

集成测试发现 SourceFailure 作为 Error 实例经过 structuredClone 后会丢失 code/retryable。toAgentError 现在复制公共字段为普通对象，避免 Checkpoint 与模型结果丢失错误码。字段及错误语义不变，不涉及 Schema 迁移；新增专门的克隆回归测试。

## 验收

复用 [实验运行命令](./13-metrics-lab-implementation.md)。启用 AGENTOPS_REAL_PROMETHEUS=1 后，真实后端测试已扩展为对三个场景分别执行 MCP HTTP、Harness 工具调用与 evidenceId 回查，不仅直接调用查询适配器。

2026-09-09：默认质量门 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 均通过；全量测试为 44 个测试文件通过、1 个真实 Prometheus 测试文件按默认配置跳过，222 项测试通过、1 项跳过。真实后端测试需显式启用；本页保留的三个场景链路是确定性集成验收，不代表已连接线上业务系统。

后续增量已加入独立实验管理 API、统一 Metrics Lab 启动入口、Event/Message V2 SQLite 事件消息存储以及有界日志 Blob/Manifest 取证。Simulator Web 页面尚未实现；下一步为真实 ELK/Trace 连接、指标/日志来源 Subagent 自治、生产 Blob 后端与完整前端。无业务写动作、无真实业务仓库修改。
