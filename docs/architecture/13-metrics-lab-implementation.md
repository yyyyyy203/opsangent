# 指标实验链路：当前实现与复验

## 已实现边界

SettlementSimulator → 只读 HTTP /metrics → 真实 Prometheus → PrometheusSettlementSource → 确定性 Profile 判定。

本页记录直接抓取与查询增量。后续已接通 MCP → Harness → EvidenceStore，详见 [MCP 与证据闭环](./14-settlement-mcp-evidence.md)；该页给出最新验证范围，仍不代表完整产品 V1。

快照使用 gauge 描述 300 秒窗口，不使用 counter increase 推算。场景为 100/15、100/0、10/8；低样本不判健康。模拟器 HTTP 仅允许 GET /metrics，其他路径返回 404、写方法返回 405。场景选择仅由宿主调用，不暴露给模型；独立管理 API 已实现为 loopback-only 管理服务，Simulator Web 尚未实现。

查询适配器是实验 Profile 专用实现，固定 checkout/simulation 和三种指标名，模型不能传 PromQL、时间或 URL。未来业务 counter Profile 需要单独实现，不能直接套用本快照算法。URL 由组装层配置，只允许无凭据、无查询串的 HTTP(S) 根地址，不跟随重定向。

## 查询校验

- 同一次 instant query、同一 evaluation time 获取四条序列。
- 校验 JSON envelope、vector 类型、scope、数值、安全整数、时间窗口及 exporter 标签一致性。
- 重复序列、不同 exporter、缺失序列和 warnings 不产生正常判定。
- 快照窗口必须正好 300 秒，结束时间不得在未来，最大年龄 120 秒；样本时间最大年龄 30 秒。
- HTTP 查询超时参数 5 秒，传输 AbortSignal 超时 6 秒，响应最多 64 KiB，支持父级取消。
- 不在 Profile 查询适配器内部自动重试；MCP 封装复用已有统一可靠性执行器，避免嵌套重试放大。
- 仅返回指标事实，不声称已确定 MySQL 根因。网络失败不被伪装成无数据或健康。

## Windows / Docker Desktop 复验

在 D:\agentops 的 PowerShell 执行：

```powershell
docker compose -p agentops-metrics -f infrastructure/metrics-lab/compose.yaml up -d
$env:AGENTOPS_REAL_PROMETHEUS = '1'
pnpm test
Remove-Item Env:AGENTOPS_REAL_PROMETHEUS
docker compose -p agentops-metrics -f infrastructure/metrics-lab/compose.yaml stop
```

也可使用项目脚本：pnpm lab:backend:up 启动 Prometheus，pnpm lab:start 启动本地指标、管理与 MCP 服务，结束后执行 pnpm lab:backend:stop。lab:start 会在标准输出写一行 JSON，包含三个本地 URL。默认端口依次为 19108、19109、19110。

普通 pnpm test 默认跳过真实后端验收。启用环境变量时，test/real-prometheus.test.ts 自动启动并最终关闭模拟器，轮流生成三种场景，等待真实抓取，使用查询适配器和 Profile 做确定性断言。

Prometheus 使用 prom/prometheus:v3.5.0，HTTP 仅映射到 127.0.0.1:19090；模拟器临时监听 0.0.0.0:19108，以允许 Docker Desktop 通过 host.docker.internal 抓取。该端口只包含模拟指标，但仍会对可达的局域网开放，请只在本地开发环境运行。管理接口仅监听 127.0.0.1，没有生产遥测或业务写操作。

## 验证记录

2026-09-09：默认质量门 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过；全量测试为 44 个测试文件通过、1 个真实 Prometheus 测试文件按默认配置跳过，222 项测试通过、1 项跳过。默认验证未连接真实 Prometheus，真实后端验收需显式设置 `AGENTOPS_REAL_PROMETHEUS=1` 并具备 Docker；未连接真实业务系统或真实模型。

## 下一步

MCP 服务、Manifest Tool、原文保存与 Harness 取证联调已在下一增量完成，见第 14 篇；独立管理 API 和统一 Metrics Lab 启动入口也已完成。来源 Subagent 自治、真实模型、持久化 EvidenceStore/Checkpoint、Simulator Web、Agent Web 与更多遥测后端仍待实施。
