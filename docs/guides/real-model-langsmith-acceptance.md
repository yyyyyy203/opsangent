# 一次性真实模型与 LangSmith 联合验收

本指南用于个人开发环境做一轮**显式授权、限额、可人工复核**的真实模型烟测。它不是生产环境验收，也不表示 `group-buy-market` 已接入真实遥测。执行期间模型请求会产生费用；真实模型、ELK/Prometheus 后端及 LangSmith 网络只会在用户主动设置 `AGENTOPS_REAL_MODEL_SMOKE=1` 并运行脚本后访问。

脚本只提交一个父 Run，不自动重跑失败 Run；模型 HTTP 请求总数最多 10 次，单次输出最多 512 tokens，Run 期限 90 秒。输出是脱敏摘要和报告路径，不打印密钥或最终消息正文。未启用 LangSmith 时仍可得到本地报告，但远端核验为 `unavailable`，人工批准不能把 verdict 改成 `passed`。

## 准备

- 在目标工作树使用 Node.js 24 和 pnpm 11.19.0；检查 `node --version` 与 `pnpm --version`。需有可在当前终端直接调用的 `pnpm` shim，因为脚本和 package scripts 内部都会运行 `pnpm build`。
- 依赖已安装，Docker 正常运行。
- 先在目标工作树执行 `pnpm logs:backend:up`，启动本地 Elasticsearch 和 Prometheus 实验后端。默认地址分别为 `http://127.0.0.1:19200` 与 `http://127.0.0.1:19290`。烟测脚本只使用该本地后端，不替你启动 Docker，也不会执行 `down -v`。
- 准备一个 OpenAI-compatible HTTPS 模型 API 和一个明确命名的 LangSmith project。两者的 API Key 仅从当前 PowerShell 环境传给本机进程；不要写进源码、命令行参数、报告或截图。

## 配置 PowerShell 环境

下面是可改路径的模板。工作数据、workspace 和忽略的验收产物使用彼此清晰的绝对路径；不要把个人日常数据目录当作烟测目录。

```powershell
Set-Location 'D:\agentops\.worktrees\event-message-v2'

if ((node --version) -notlike 'v24.*') { throw '需要 Node.js 24' }
if ((pnpm --version) -ne '11.19.0') { throw '需要 pnpm 11.19.0' }

$env:AGENTOPS_ACCEPTANCE_DATA_DIR = 'D:\agentops-smoke-data'
$env:AGENTOPS_ACCEPTANCE_WORKSPACE_ROOT = 'D:\agentops-smoke-workspace'
$env:AGENTOPS_ACCEPTANCE_ARTIFACT_DIR = 'D:\agentops\.worktrees\event-message-v2\test-results\real-model-acceptance'
New-Item -ItemType Directory -Force $env:AGENTOPS_ACCEPTANCE_DATA_DIR | Out-Null
New-Item -ItemType Directory -Force $env:AGENTOPS_ACCEPTANCE_WORKSPACE_ROOT | Out-Null
New-Item -ItemType Directory -Force $env:AGENTOPS_ACCEPTANCE_ARTIFACT_DIR | Out-Null

$env:AGENTOPS_MODEL_BASE_URL = 'https://api.example.com'
$env:AGENTOPS_MODEL_PROVIDER = '填写供应商标识'
$env:AGENTOPS_MODEL = '填写账号已开通的模型 ID'
$env:AGENTOPS_ACCEPTANCE_CODE_REVISION = (git rev-parse HEAD).Trim()
$env:AGENTOPS_ACCEPTANCE_PROFILE_REVISION = 'simulation-v1'

# 为两个用途分别生成不同的随机 secret（各自至少 32 字节）。
$env:AGENTOPS_LOGS_LAB_CURSOR_SECRET = ((New-Guid).ToString('N') + (New-Guid).ToString('N'))
$env:AGENTOPS_EVIDENCE_CURSOR_SECRET = ((New-Guid).ToString('N') + (New-Guid).ToString('N'))

$secureModelKey = Read-Host '模型 API Key（待输入，不回显）' -AsSecureString
$env:AGENTOPS_MODEL_API_KEY = [System.Net.NetworkCredential]::new('', $secureModelKey).Password.Trim()
Remove-Variable secureModelKey

# 如需远端 LangSmith 核验，配置唯一 project 并隐藏输入 Key。
$env:LANGSMITH_TRACING = 'true'
$env:LANGSMITH_PROJECT = 'agentops-real-model-acceptance'
$env:LANGSMITH_ENDPOINT = 'https://api.smith.langchain.com'
$secureLangSmithKey = Read-Host 'LangSmith API Key（待输入，不回显）' -AsSecureString
$env:LANGSMITH_API_KEY = [System.Net.NetworkCredential]::new('', $secureLangSmithKey).Password.Trim()
Remove-Variable secureLangSmithKey
```

将模型 endpoint、provider 和模型 ID 改为账号实际可用的值。LangSmith 可选；若本次只做本地报告，把 `LANGSMITH_TRACING` 设为 `false` 并清除 `LANGSMITH_API_KEY`、`LANGSMITH_PROJECT`。此时不得把验收描述为远端链路已闭环。

`AGENTOPS_ACCEPTANCE_CODE_REVISION` 是报告中记录的代码版本。若工作树有未提交修改，`git rev-parse HEAD` 只代表当前 HEAD，不代表脏文件内容；请在执行记录中明确这一点，不要把 HEAD 描述成完整工作树快照。

## 执行一次烟测

确认本地后端已就绪、模型余额和 LangSmith project 正确后，再显式打开一次性开关：

```powershell
$env:AGENTOPS_REAL_MODEL_SMOKE = '1'
pnpm acceptance:real-model
$smokeExitCode = $LASTEXITCODE
Remove-Item Env:AGENTOPS_REAL_MODEL_SMOKE
if ($smokeExitCode -ne 0) { throw "Acceptance CLI failed with exit code $smokeExitCode; inspect the fixed error code and saved report before deciding next steps." }
```

命令先构建，再启动一个真实模型 Run。它使用指定的 `AGENTOPS_ACCEPTANCE_DATA_DIR` 保存 SQLite 数据与 `acceptance/<runId>.json`，并把同一份安全报告写到显式的 artifact 目录。`test-results/` 已由仓库忽略。报告只包含校验、预算、usage 完整性、远端核验状态和 Run 标识，不保存最终回答原文、凭证或原始证据。

失败后先检查固定错误码和报告，不要为了“刷绿”自动再跑一次。若报告 verdict 是 `review_required`，这是待人工审核或远端不可用的显式状态，不是通过。

## 人工复核同一个 Run

先通过连接到同一 `AGENTOPS_ACCEPTANCE_DATA_DIR` 的 Agent Web 历史记录，按报告中的 `runId` 打开**这一轮**最终消息并人工判断。不要只凭摘要或 LangSmith span 批准；无法看到同一 Run 的最终消息时，不要选择 approved。复核脚本不会显示或保存消息正文，只记录决定和 unsupported-claim 数量。

将 `<RUN_ID>` 换成 CLI 输出中的 ID：

```powershell
$reportPath = Join-Path $env:AGENTOPS_ACCEPTANCE_ARTIFACT_DIR '<RUN_ID>.json'
pnpm acceptance:review -- --report $reportPath --decision approved --unsupported-claims 0
```

若发现 unsupported claims，选择 `rejected` 并填写实际数量，例如：

```powershell
pnpm acceptance:review -- --report $reportPath --decision rejected --unsupported-claims 2
```

审核命令只读取本地、绝对路径的 v1 JSON 报告，校验结构后调用确定性 `applyManualReview`，在同目录新建 `<runId>.reviewed.json`。原报告不覆盖；目标文件已存在时会失败。输出文件通过白名单重建，不保留输入文件中的未知字段或正文；CLI 不读取模型/LangSmith Key、不发 HTTP 请求。approved 必须使用计数 0；即使如此，失败检查或 LangSmith `failed`/`unavailable` 仍不能变成 `passed`。

## 结果边界

- 自动检查、LangSmith 远端核验和人工复核是不同结果；报告必须保留三者状态。
- 没有真实运行就只能说 CLI/代码和 fake-client 测试已验证，不能说 DeepSeek、真实 Prometheus/Elasticsearch 或 LangSmith 远端验收通过。
- 此烟测验证的是模拟巡检链路，不证明目标业务系统已经接入生产指标、日志、Trace，也不授权任何真实写操作。
