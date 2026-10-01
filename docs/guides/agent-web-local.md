# Agent Web 本地工作台

Agent Web 是个人开发验证用的本地浏览器界面。它通过 HTTP 查询/命令和 Public V2 SSE 访问 Agent，不接触模型密钥、MCP 凭据、原始日志或 `AgentContext`。模拟器管理页面仍是独立入口，本页面不提供模拟器控制。

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
- 证据区域只展示摘要和元数据，原始 Prometheus、ELK、Trace、ToolResponse 不进入浏览器。
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

## 当前验证状态（2026-10-02）

- `pnpm typecheck`、`pnpm build`、`pnpm web:typecheck`、`pnpm web:build`：通过。
- `pnpm test`：112 个测试文件通过、2 个显式 opt-in 真实 Prometheus 文件跳过；613 个测试通过、3 个跳过。
- `pnpm e2e`：固定工具项目 4/4 通过；默认流程未连接 Docker、Prometheus 或外部凭据。
- `pnpm lint`：新增的真实指标 E2E fixture 已纳入脚本忽略边界；当前仍有一个未被本增量修改的既有错误：`src/application/create-runtime.ts:322` 的 `@typescript-eslint/unbound-method`。
- 真实 Prometheus Web 验收尚未运行：`127.0.0.1:19090` 当前没有监听服务。具备本地 Prometheus 后，显式执行 `AGENTOPS_REAL_PROMETHEUS_WEB=1` 的 Vitest 与 Playwright 命令，并单独记录结果。
- 本次实现仍只验证 `simulation` Profile；没有连接 `D:\xfg\group-buy-market`、生产 Prometheus、真实模型或 ELK。
