# Agent Web 本地工作台

Agent Web 是个人开发验证用的本地浏览器界面。它通过 HTTP 查询/命令和 Public V2 SSE 访问 Agent，不接触模型密钥、MCP 凭据、原始日志或 `AgentContext`。模拟器管理页面仍是独立入口，本页面不提供模拟器控制。

需要同时验证 Elasticsearch 日志与 Prometheus 指标时，请使用独立的 [Logs Web 本地验收指南](logs-web-elasticsearch-local.md)。该流程需显式设置 `AGENTOPS_REAL_LOGS_WEB=1`，浏览器验收使用脚本模型，与本文的 Metrics-only 流程分开启动。

## 启动

在仓库根目录安装依赖：

```powershell
pnpm install
```

启动顺序固定为：Prometheus Compose → Metrics Lab/MCP → Agent Web 宿主 → Agent Web 页面。

在第一个终端启动本地 Prometheus：

```powershell
pnpm lab:backend:up
```

在第二个终端启动 Metrics Lab 和只读 MCP：

```powershell
pnpm lab:start
```

在第三个终端启动本地 Agent 宿主。必须显式配置数据目录、工作区根目录、`simulation` Profile 和 MCP 地址；宿主默认只监听 `127.0.0.1`，第一阶段只允许只读工具和 Dry Run：

```powershell
$env:AGENTOPS_DATA_DIR = 'D:\agentops-data'
$env:AGENTOPS_WORKSPACE_ROOTS = 'D:\xfg\group-buy-market'
$env:AGENTOPS_HOST = '127.0.0.1'
$env:AGENTOPS_PORT = '4100'
$env:AGENTOPS_MODEL_BASE_URL = 'https://your-openai-compatible-endpoint/v1'
$env:AGENTOPS_MODEL_API_KEY = '只保存在服务端环境变量'
$env:AGENTOPS_MODEL = 'deepseek-chat'
$env:AGENTOPS_WEB_PROFILE = 'simulation'
$env:AGENTOPS_METRICS_MCP_URL = 'http://127.0.0.1:19110/mcp'
pnpm web:server
```

模型配置不完整时宿主会明确失败，不会用假模型替代真实模型。终端输出只包含本地 URL，不打印 API Key。

在第四个终端启动浏览器页面：

```powershell
$env:VITE_AGENT_API_URL = 'http://127.0.0.1:4100'
pnpm web:dev
```

用浏览器打开 `http://127.0.0.1:5173`。如果 Agent 使用了不同端口，修改 `VITE_AGENT_API_URL`；页面构建时不把该变量与服务端模型密钥混用。

`simulation` 使用本地 Prometheus lab 产生的模拟遥测数据，不代表生产数据；`group-buy-market` 当前仍未接入 Prometheus、ELK 或 Trace。Agent Web 不会自动启动 Docker、模拟器或 Prometheus，也不提供模拟器写控制。

## 页面行为

- 左侧显示公开 Run 历史；中间提交 Profile 和巡检问题，展示公开消息块。
- SSE 只作为进度/失效通知，消息正文以分页公开快照为准；浏览器会合并相同 `messageId`，旧 `version` 不得覆盖新内容。
- 父 Run 的证据区域汇总子 Run 树的摘要与引用，保留证据所属 `runId`，最多查询 100 个 Run、展示 500 条证据；分页失败或触及上限时提示不完整，并保留已取得的证据。原始 Prometheus、ELK、Trace、ToolResponse 不进入浏览器；`retrievable=false` 不是下载失败提示。
- 模型用量分别展示本 Run、子 Run 合计与整棵调用树的输入、输出及缓存输入 token。数据来源为持久化模型调用完成事件，缺失或失败记录标记为不完整；不把 token 数当成账单金额。
- Run 状态为“运行中”时可请求取消当前 Agent Web 宿主进程内的活跃 Run；页面显示取消进行中，收到终态快照后显示“已取消”。暂停、等待确认和终态 Run 不提供取消按钮；取消通过 AbortSignal 协作停止，不会回滚已经完成的工具副作用。宿主重启后没有活跃执行器可供取消。
- HIGH/CRITICAL 或工具声明需要确认时，批准/拒绝只作用于当前 `toolCallId + expectedRevision`。任何确认结果都不会自动恢复，必须点击“继续调查”；冲突不会自动重发。
- 断线、SSE 背压或游标失效时页面提示重新同步，不伪造完整诊断。刷新页面不会自动 resume。
- 当前宿主为单进程本地 MVP；协调器和消息游标不是分布式锁/跨进程认证方案，不得直接公网暴露。

## 停止与数据

按 `Ctrl+C` 停止宿主和页面开发服务器。SQLite 文件位于 `AGENTOPS_DATA_DIR\agent.sqlite`，删除或迁移前先停止宿主并备份。页面不会删除历史 Run。

## 验证

纯状态/API 测试、前端类型检查和构建：

```powershell
pnpm test -- test/web-run-view.test.ts test/web-api-client.test.ts
pnpm web:typecheck
pnpm web:build
```

真实浏览器验收使用独立的确定性 fixture，启动临时 SQLite、HTTP/SSE 宿主和 Vite 页面：

```powershell
pnpm e2e
```

fixture 不代表真实模型、Prometheus 或 ELK 已接通。真实数据源烟测必须另行配置并明确记录未验证项；当前 `D:\xfg\group-buy-market` 仍按只读目标处理。

Docker 已启动且本地 Prometheus 可访问 `http://127.0.0.1:19090/-/ready` 后，可以显式运行真实 Prometheus 验收：

```powershell
$env:AGENTOPS_REAL_PROMETHEUS_WEB = '1'
pnpm exec vitest run test/http-server.test.ts test/metrics-web-real-prometheus.test.ts
pnpm exec playwright test test/e2e/metrics-web.spec.ts --project=real-metrics
Remove-Item Env:AGENTOPS_REAL_PROMETHEUS_WEB
```

这些测试使用模拟器产生遥测、真实 Prometheus 查询和脚本模型；父 Run 记录子 Run 身份和证据引用，当前父页面也会汇总子 Run 的证据摘要。验收还检查父子 Run 的公开消息与 SSE 不泄漏原始指标。浏览器测试验证已完成 Run 的 SSE 连接在 Web 重启前存在，重启后可以重新连接并查询父子 Run 和子 Run 证据。运行中 Run 可通过显式取消命令发出 cooperative abort，并以 `RUN_CANCELLED` 与 `cancelled` checkpoint 结束；取消不会回滚已完成工具副作用。

## 历史验证记录（2026-10-02）

- `pnpm typecheck`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build`：通过。
- `pnpm test`：112 个测试文件通过、2 个显式 opt-in 真实 Prometheus 文件跳过；614 个测试通过、3 个跳过。
- `pnpm e2e`：固定工具项目 4/4 通过；默认流程未连接 Docker、Prometheus 或外部凭据。
- `pnpm lint`：通过；运行时关闭回调已通过显式包装消除 `unbound-method` 错误，真实指标 E2E fixture 保持现有脚本忽略边界。
- 真实 Prometheus Web 验收已在本机运行：API/HTTP 专项 4/4、浏览器专项 1/1 通过，覆盖正常、失败率超阈值、低样本、来源断开、父子 Run 公开数据隔离、已完成 Run 的 SSE 重连和 Web 重启后查询。数据仍来自模拟器，模型仍为脚本模型。
- 本次实现仍只验证 `simulation` Profile；没有连接 `D:\xfg\group-buy-market`、生产 Prometheus、真实模型或 ELK。

## 当前验证状态（2026-10-03）

- 最终质量门通过：lint、核心类型检查/构建、Web 类型检查/构建。由于本机缺少可用 `pnpm` shim，本轮通过 `node_modules/.bin` 等价执行项目脚本，未修改包管理器配置。
- 默认 Vitest：113 个测试文件通过、2 个 opt-in 文件跳过；628 个测试通过、3 个跳过。此次没有启动 opt-in 测试自己的固定端口实验栈，避免与现有实验服务冲突。
- 独立审查发现并修复 4 个页面边界：旧树快照覆盖新快照、分页失败丢失已读证据、不安全 token 加总仍标记完整、树快照过期导致初始成功消息丢失。新增回归先观察失败再修复；`web-run-view` 11/11 通过，复核未再发现具体回归。
- 确定性浏览器验收 4/4 通过，覆盖批准、拒绝、显式恢复、两个 Run 隔离与重复确认冲突；不使用付费模型。
- 真实模型烟测使用 `deepseek-flash` 和隔离的临时 SQLite/Web 宿主，复用现有模拟器 → Prometheus → 只读 MCP。只发起 1 个父 Run，实际调用模型 5 次；每次输出上限 768 token。场景为 100 次结算、15 次失败、失败率 15%，超过 5% 阈值；没有把指标异常宣称为已确认根因。
- 父页面显示 1 条子 Run 证据摘要及原始 owner/reference，`retrievable=false` 符合仅摘要设计。模型返回用量、持久化 Run 详情、公开 `RUN_FINISHED` 和页面展示逐项一致：本 Run 输入 1,631 / 输出 305 / 缓存输入 640，子 Run 输入 3,060 / 输出 790 / 缓存输入 2,432；树合计输入 4,691 / 输出 1,095 / 缓存输入 3,072。缓存输入是输入 token 的子集，不额外计入总输入；本轮未核对供应商账单金额。
- 重启隔离 Web 宿主后，已完成的父子 Run、证据和用量仍可查询，浏览器重载和 SSE 回放一致，新增模型请求为 0。公开 DTO、SSE 与 DOM 未出现原始 Prometheus 序列或 API Key；未暴露单次模型审计事件。
- 本轮真实模型只覆盖 `settlement_failure`，不代表真实模型的全部故障场景或生产验收。遥测仍由模拟器生成，未接入 `group-buy-market`、ELK 或 Trace。临时验收服务已关闭；原有 Agent/Prometheus/MCP 服务未重启，原 Agent 进程不会自动加载磁盘上的新构建。
