# 本地 Logs Web 验收指南

本指南用于个人开发环境验证“模拟结算场景 → Prometheus/Elasticsearch → 只读 MCP → Agent Web”的巡检链路。它不是生产 ELK 接入说明：目标数据是本地生成的固定模拟日志和指标，页面只展示摘要与证据引用，不提供原始日志下载或写操作。

## 安全边界与预算

- Elasticsearch 和 Prometheus Compose 服务只绑定 `127.0.0.1`；不要改成公网/局域网监听，也不要把这套无认证实验栈连接到业务集群。
- `normal`、`settlement_failure`、`low_sample` 场景在启动时固定，快照约 120 秒后过期。切换场景需要停止并重新启动自己运行的 Logs Lab；已有索引不会被删除。
- Logs 工具只读。单次证据采集最多 64 MiB、50,000 条或 60 秒，先达到者生效；单页最多 512 KiB；交给模型的 ToolResult 最多 16 KiB、最多 3 条脱敏样本。触及预算时结果可能是 `partial`，不得将部分结果描述成完整取证。
- 浏览器和公开 API 只返回摘要、引用及状态。`retrievable=false` 是当前“仅摘要/引用”设计，不代表下载暂时失败。
- MCP 实验 secret 与 Agent 本地证据游标 secret 是不同用途的两个值，二者均至少 32 UTF-8 字节，并且不要放进 `VITE_` 变量、源码、截图或日志。
- 交互式 Agent Web 会使用服务端配置的模型。先使用小问题和低输出上限；真实模型费用不由本指南中的 Logs Playwright 验收产生，因为验收模型是脚本模型。

## 手动启动（三个终端）

需要 Node.js 24（`>=24.0.0 <25.0.0`）和仓库依赖已安装；Node.js 20 不再是受支持的开发或部署基线。实验栈使用固定 Elasticsearch 8.19.12 与 Prometheus 3.5.0 镜像。

先在将要运行命令的 PowerShell 中确认 `pnpm` shim 可由子进程找到：

```powershell
Get-Command pnpm -ErrorAction Stop
```

若此命令失败，先在当前用户有写权限且已加入当前 `PATH` 的目录启用/安装 pnpm shim，并重新打开或更新终端后重试。单独执行 `corepack pnpm@10` 成功，只说明当前调用能找到 Corepack；本仓库的 npm script 和 Playwright webServer 会再次执行 `pnpm`，仍要求 `Get-Command pnpm` 成功。启用 shim 不应默认要求管理员权限；先确认目标 shim 目录可写并在当前 `PATH` 中。

### 终端 1：启动隔离后端和固定场景 Logs Lab

在仓库根目录运行。场景可以是 `normal`、`settlement_failure` 或 `low_sample`；每次启动只选一个。

```powershell
Set-Location 'D:\agentops\.worktrees\event-message-v2'
pnpm logs:backend:up
if ($LASTEXITCODE -ne 0) { throw 'Logs backend startup failed.' }

$env:AGENTOPS_LOGS_LAB_SCENARIO = 'settlement_failure'
$env:AGENTOPS_ELASTICSEARCH_URL = 'http://127.0.0.1:19200'
$env:AGENTOPS_LOGS_LAB_PROMETHEUS_URL = 'http://127.0.0.1:19290'
$labSecret = Read-Host '输入本地 Logs Lab secret（至少 32 字节，不回显）' -AsSecureString
$labValue = [System.Net.NetworkCredential]::new('', $labSecret).Password
Remove-Variable labSecret
if ([string]::IsNullOrWhiteSpace($labValue) -or [System.Text.Encoding]::UTF8.GetByteCount($labValue) -lt 32) {
  Remove-Variable labValue
  throw 'Logs Lab secret 至少需要 32 UTF-8 字节。'
}
$env:AGENTOPS_LOGS_LAB_CURSOR_SECRET = $labValue
Remove-Variable labValue
pnpm logs:lab
```

等待 JSON `status=ready`。输出的 `expiresAt` 之后快照会过期；不要在 Agent UI 中继续用旧窗口，重启本终端中的 Lab 生成新快照即可。停止 Lab 用 `Ctrl+C`。

### 终端 2：启动 Agent Web 宿主

下面模型地址和模型名是示例，请替换成已获授权的 OpenAI-compatible 服务。API key 和证据游标 secret 以隐藏输入读取，不能把值粘贴进命令行、文件或 `VITE_` 环境变量。

```powershell
Set-Location 'D:\agentops\.worktrees\event-message-v2'
$env:AGENTOPS_DATA_DIR = 'D:\agentops-logs-data'
$env:AGENTOPS_WORKSPACE_ROOTS = 'D:\agentops-logs-workspace'
$env:AGENTOPS_HOST = '127.0.0.1'
$env:AGENTOPS_PORT = '4200'
$env:AGENTOPS_WEB_PROFILE = 'simulation'
$env:AGENTOPS_METRICS_MCP_URL = 'http://127.0.0.1:19210/mcp'
$env:AGENTOPS_LOGS_MCP_URL = 'http://127.0.0.1:19211/mcp'
$env:AGENTOPS_MODEL_BASE_URL = 'https://api.example.com'
$env:AGENTOPS_MODEL = 'your-model-name'
$modelKey = Read-Host '输入模型 API Key（不回显）' -AsSecureString
$modelKeyValue = [System.Net.NetworkCredential]::new('', $modelKey).Password
Remove-Variable modelKey
if ([string]::IsNullOrWhiteSpace($modelKeyValue) -or [System.Text.Encoding]::UTF8.GetByteCount($modelKeyValue) -lt 1) {
  Remove-Variable modelKeyValue
  throw '模型 API Key 不能为空。'
}
$env:AGENTOPS_MODEL_API_KEY = $modelKeyValue
Remove-Variable modelKeyValue
$cursorSecret = Read-Host '输入独立的 Evidence cursor secret（至少 32 字节，不回显）' -AsSecureString
$cursorValue = [System.Net.NetworkCredential]::new('', $cursorSecret).Password
Remove-Variable cursorSecret
if ([string]::IsNullOrWhiteSpace($cursorValue) -or [System.Text.Encoding]::UTF8.GetByteCount($cursorValue) -lt 32) {
  Remove-Variable cursorValue
  throw 'Evidence cursor secret 至少需要 32 UTF-8 字节。'
}
$env:AGENTOPS_EVIDENCE_CURSOR_SECRET = $cursorValue
Remove-Variable cursorValue

New-Item -ItemType Directory -Force $env:AGENTOPS_DATA_DIR, $env:AGENTOPS_WORKSPACE_ROOTS | Out-Null
pnpm web:server
```

宿主只绑定 loopback；若端口 `4200` 不可用，先自行选择一个空闲本地端口并让终端 3 使用相同地址。不要结束或复用不属于本次测试的进程。

### 终端 3：启动浏览器页面

```powershell
Set-Location 'D:\agentops\.worktrees\event-message-v2'
$env:VITE_AGENT_API_URL = 'http://127.0.0.1:4200'
pnpm web:dev
```

打开 Vite 输出的本地地址（通常是 `http://127.0.0.1:5173`）。发起结算巡检后，在页面核对父 Run、Metrics/Logs 子 Run、证据摘要/引用、coverage/missingEvidence 与 token 用量。页面不会显示原始日志正文。

Run 状态为“运行中”时可以取消当前宿主进程内活跃的 Run；暂停、等待确认、已完成/失败/取消的 Run 不提供取消按钮。取消以 AbortSignal 协作中止，不会撤销已经完成的工具副作用；宿主重启后不能取消已不在本进程执行的 Run。

## 隔离 Playwright 验收

Playwright Logs 配置会创建自己的 scripted-model Web/Lab fixture，端口固定为 Agent `45200`、Web `45273`、control `45201`，并使用 Logs Lab 的 `192xx` 专用端口。它不会访问模型 API，但仍需要本地 `agentops-logs` 的 Elasticsearch 与 Prometheus 已就绪。若端口被占用，验收应报错退出；不要关闭占用者。

```powershell
Set-Location 'D:\agentops\.worktrees\event-message-v2'
pnpm logs:backend:up
if ($LASTEXITCODE -ne 0) { throw 'Logs backend startup failed.' }
$env:AGENTOPS_REAL_LOGS_WEB = '1'
pnpm logs:e2e
$testExitCode = $LASTEXITCODE
Remove-Item Env:AGENTOPS_REAL_LOGS_WEB -ErrorAction SilentlyContinue
if ($testExitCode -ne 0) { throw 'Logs browser acceptance failed.' }
```

未显式设置 `AGENTOPS_REAL_LOGS_WEB=1` 时，Logs E2E 命令必须在启动 fixture 或浏览器之前停止并说明如何 opt in。测试使用固定 scripted models，不发起付费模型请求；覆盖公开摘要/引用、来源降级、Run 取消、SSE 断线重连及宿主重启恢复。不要把这个选项当成真实模型烟测开关。失败截图/trace 也不得包含凭据或原始日志。

## 可选模型烟测的网络请求上限

`test/fixtures/bounded-smoke-fetch.ts` 提供给明确授权的临时 smoke harness 使用，不是 Agent Web 的默认 fetch，也不由 `logs:e2e` 调用。将同一个 wrapper 注入父模型和子模型的 `CreateOpenAICompatibleModelOptions.fetch`，让重试和 fallback 也计入同一上限：

```ts
const boundedFetch = createBoundedSmokeFetch({
  fetch: globalThis.fetch,
  limit: 10,
  maxOutputTokens: 512,
  onAttempt: (count) => process.stderr.write(`model_http_attempt=${count}\n`),
});
```

它只在模型 HTTP 边界计数 `/chat/completions` 请求，将输出上限设为 512，并在第 11 次尝试前返回本地 HTTP 402 而不发送网络请求。不要打印请求正文、Authorization 或 key。该 wrapper 只能降低烟测请求上限，不替代服务商账单监控；未获明确授权时不要运行任何真实模型烟测。API key 仍只放进本次宿主进程的隐藏读取环境变量，烟测完成后关闭该终端并在必要时撤销 key。

## 故障排查

- **Logs Lab 未 ready：** 查看终端 1 的错误；确认 Docker 可用、Elasticsearch `19200` 与 Prometheus `19290` 可访问，等待固定快照被 Prometheus scrape。不要清索引或改写业务数据。
- **快照已过期 / unavailable：** 约 120 秒有效期已过；`Ctrl+C` 只停止当前 Logs Lab，再在终端 1 重启生成新快照，并从新的巡检 Run 开始。
- **证据是 partial：** 查看 `missingEvidence`、coverage 和预算状态。64 MiB、50,000 条、60 秒或分页/模型摘要限制可导致 partial；不要扩大生产限制来让单个场景显示完整。
- **MCP 连接失败：** 核对 Agent Server 的 `AGENTOPS_METRICS_MCP_URL`/`AGENTOPS_LOGS_MCP_URL` 与终端 1 ready 输出的 MCP URL；宿主启动后变更 env 不会自动更新正在运行的进程。
- **Evidence cursor 重启后不可读：** `AGENTOPS_EVIDENCE_CURSOR_SECRET` 必须跨 Web 宿主重启保持一致。不要用 Logs Lab 的 cursor secret 代替它。
- **Playwright 报端口占用：** 查看错误中列出的本地端口，停止本次自己启动的服务或另行安排空闲端口；fixture 不会终止任何未知进程。
- **模型鉴权失败：** 在服务商控制台核验 key、模型名和 Base URL；不要把密钥发到聊天、写进 `.env` 后提交或贴进终端命令历史。真实模型烟测将消耗额度，`logs:e2e` 不需要模型 key。

## 停止本次服务

分别在终端 2、3 按 `Ctrl+C` 停止 Agent 宿主和 Vite，再在终端 1 按 `Ctrl+C` 停止本次 Logs Lab。需要停止本次隔离 Docker 容器时，只执行：

```powershell
pnpm logs:backend:stop
```

该命令只停止 `agentops-logs` Compose 项目，不使用 `docker compose down`，不删除 Elasticsearch 索引或卷，也不触碰 `agentops-metrics`、其他项目或用户进程。Agent 数据目录中的 SQLite 与证据 Blob 不会被自动删除；清理前应确认目标路径、停止宿主并自行备份。
