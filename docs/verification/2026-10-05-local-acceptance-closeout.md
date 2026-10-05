# 2026-10-05 本机验收收口记录

## 结论

本轮已验证默认质量门、浏览器 E2E，以及本机 Prometheus 和 Elasticsearch 测试后端的真实传输/应用链路。所有后端数据均为本机模拟或验收数据；没有连接 `group-buy-market`、公司 ELK、生产 Prometheus，也没有执行生产动作。

## 质量门

| 检查 | 结果 |
| --- | --- |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 145 个测试文件通过、3 个 opt-in 文件跳过；942 项通过、7 项跳过 |
| `pnpm build` | 通过 |
| `pnpm web:typecheck` | 通过 |
| `pnpm web:build` | 通过 |
| 默认浏览器 E2E | 4/4 通过 |
| `git diff --check` | 通过 |

质量门在隔离验证目录中使用 Node 24 及其已安装依赖运行。正式工作树中参与实现和测试的文件逐一与该验证目录做了 SHA-256 核对，结果全部一致。

## 本机后端验收

### Prometheus → MCP → Metrics Subagent

使用本机 Prometheus 抓取测试 Exporter，并经 MCP HTTP 进入 Metrics Subagent。opt-in 测试 **1/1 通过**，覆盖结算失败率升高、正常和低样本场景；阈值、样本状态和数值结论由确定性代码计算。

### Elasticsearch/Prometheus → Logs Web

使用本机 Elasticsearch + Prometheus Logs 测试栈运行 Playwright：`pnpm logs:e2e`，**3/3 通过**。覆盖有界日志取证与指标证据、断线重连/服务重启不重复采集、Logs 不可用时保留 Metrics 并显式降级，以及取消/Checkpoint。

这只证明本机测试栈中的服务协议、MCP、Subagent、证据持久化和 Web 恢复链路工作，不证明生产 Elasticsearch 集群、企业身份认证、线上数据质量或生产容量已验收。

## 本轮修复

- 统一 SQLite 与内存 Run/Evidence 分页的二进制排序和游标校验，避免跨实现分页不一致。
- 按公开消息页 `{ message, version, truncated }` 校验消息包络、消息 `runId`，并对每类 SSE payload 执行严格 Schema 校验。
- 对 Evidence 列表/详情启用严格公共 DTO 与分页包络白名单；metric/log 摘要分别验证字段和值，拒绝 `summary.content`、`summary.samples` 等未识别字段；详情 DTO 与本地快照逐字段结构化比较，确保状态、时间窗、哈希和计数无漂移。
- 扩展公共与 LangSmith 出站隐私审计，检查字段名和值，拦截凭据、私有路径、内部地址及 `file://` URI；严格校验 `run_type`，同时接受符合边界规则的 Unicode session name。
- 修复 Durable Harness 在提交结果时脱离共享预算账本，以及从旧快照恢复预算、导致并行子执行预算被回补的风险。

Evidence 页面继续仅暴露摘要和引用，不向 UI 或 LangSmith 导出原始数据正文。

## 未完成项与下一步

- 本轮没有配置 `AGENTOPS_MODEL_API_KEY` 和 `LANGSMITH_API_KEY`，真实模型/LangSmith 联合烟测在 preflight 阶段以缺少配置结束；没有发起模型请求、消耗模型额度或查询 LangSmith。按[联合验收指南](../guides/real-model-langsmith-acceptance.md)在本机服务进程安全配置凭据后，再执行单次有界烟测并人工审核报告；不要把密钥提交进仓库或贴入聊天。
- 未连接 `D:\xfg\group-buy-market` 的真实 Prometheus 业务指标，也未接入其 ELK/Trace；现有测试数据不能替代业务 Profile、指标/阈值和告警语义验收。
- 未验证托管 CI、生产部署、生产身份认证/密钥轮换/留存策略、容量与故障演练；真实写动作仍不在本轮范围。

因此本轮状态是“本机模拟后端端到端验收通过，在线模型/LangSmith 与生产数据闭环待验”，不能称为生产环境验收完成。
