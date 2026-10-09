# 一次性真实模型与 LangSmith 联合验收

本指南用于个人开发环境做一轮**显式授权、限额、可人工复核**的真实模型烟测。它不是生产环境验收，也不表示 `group-buy-market` 已接入真实遥测。执行期间模型请求会产生费用；真实模型、ELK/Prometheus 后端及 LangSmith 网络只会在用户主动设置 `AGENTOPS_REAL_MODEL_SMOKE=1` 并运行脚本后访问。

脚本只提交一个父 Run，不自动重跑失败 Run；模型 HTTP 请求总数最多 10 次，查询轮输出最多 512、报告/汇总轮最多 1024 tokens，整次共享输出预留上限 5120，父 Run 期限 90 秒、子 Run 最多 30 秒。缺失最终 usage 或请求中断时不返还输出预留；费用还受输入 token 和账户定价影响。输出是脱敏摘要和报告路径，不打印密钥或最终消息正文。2026-10-08 起联合验收必须先通过当次 LangSmith Trace 探针；配置缺失或探针失败时，在启动 Lab/Web/父 Run 和付费模型请求之前停止。不能用旧探针报告绕过准入，人工批准也不能覆盖失败或 `unavailable`。

## 先独立验证 Trace（不调用模型）

不需要 DeepSeek 配置或 Docker。仅在你授权访问 LangSmith 后，在当前终端配置 LangSmith，然后显式运行一次：

```powershell
Set-Location 'D:\agentops\.worktrees\event-message-v2'
$env:LANGSMITH_TRACING = 'true'
$env:LANGSMITH_PROJECT = 'agentops-acceptance'
$env:LANGSMITH_ENDPOINT = 'https://api.smith.langchain.com'
$traceSecureKey = Read-Host 'LangSmith API Key（粘贴后回车，不回显）' -AsSecureString
$env:LANGSMITH_API_KEY = [System.Net.NetworkCredential]::new('', $traceSecureKey).Password.Trim()
Remove-Variable traceSecureKey
$env:AGENTOPS_TRACE_PROBE = '1'
try {
  pnpm acceptance:trace-probe
  $traceProbeExitCode = $LASTEXITCODE
} finally {
  Remove-Item Env:AGENTOPS_TRACE_PROBE -ErrorAction SilentlyContinue
}
if ($traceProbeExitCode -ne 0) { throw 'Trace 探针失败；不要继续模型烟测或自动重跑，请保留脱敏 JSON。' }
```

探针通过生产 exporter 创建两个 synthetic Span（一个 root、一个 model），固定 usage 为 input=12、output=5、cache=4；只按本次两个 ID 回查，最多 3 次查询、整体 30 秒。请求和正文共用 10 秒期限、flush 15 秒；普通非验收 exporter 默认仍为 1 秒请求/2 秒 flush。SDK 隐式重试被传输边界阻止。

查询 Fetch 会在 LangSmith SDK 解码前，将每个 Run 限定到验收所需的 11 个字段；`/runs/query` 额外 Run 字段和响应 envelope 字段不会进入校验器，分页 cursor 保留。探针可报告 `discardedTopLevelFieldCount`，只统计被裁掉字段数。选中字段中的 `inputs`、`outputs`、`extra.metadata`、错误、层级和 usage 仍照常校验；远端 `extra.metadata` 仅额外允许 LangSmith 自动补充的 `ls_run_depth`，且必须是非负安全整数，其他未知键和非法值仍拒绝。读回校验和上传校验使用分开的 metadata 策略：上传即使遇到整数形式的 `ls_run_depth` 也会 fail-closed，不扩展上传端字段白名单。该处理验证应用消费的字段视图，不表示 LangSmith 远端没有其他字段。

失败码区分 `TRACE_PROBE_UPLOAD_FAILED`、`TRACE_PROBE_QUERY_UNAVAILABLE`、`TRACE_PROBE_MISMATCH`、`TRACE_PROBE_DEADLINE`。安全诊断只保留 route/phase/outcome/elapsedMs/httpStatus，不包含远端错误正文、URL、消息和密钥。422 的具体服务端拒绝字段仍需依据实际响应另行定位，不能因离线通过就宣布远端已修复。

`TRACE_PROBE_MISMATCH` 会额外返回固定枚举 `mismatchReason`（包括 inputs、outputs、extra、metadata、error 结构类别，以及父子关系、状态和 token 字段 mismatch）。能关联到某个测试 Span 时还返回 `mismatchSpan`，仅为 `root` 或 `model`。`discardedTopLevelFieldCount` 是读回投影丢弃的额外字段数量，不包含字段名、值、Run ID 或原始 payload。投影后选中字段结构仍 fail-closed；不能通过删除嵌套检查或放宽预期把 mismatch 改为通过。

离线 fixture 会按选择对 root 或 model Span 应用 readback mismatch；root mismatch 测试断言诊断只返回固定的 `root` 标签，不含远端 ID 或内容。

探针 `verified` 只证明上传/读回这两个测试 Span 的协议，不代表完整 Agent、模型回答质量或生产数据通过。联合烟测仍会重新执行同一准入探针，通过后才启动 Lab 和一次父 Run。

## 本轮契约修复与诊断

- Metrics 公开窗口仅从合法的 summary.start/end 确定性生成，旧/无效记录省略可选窗口，窗口检查不放宽。
- Logs 成功 capture 加同 evidenceId 的 search 或 read-slice 即可进入 1024-token 报告轮；aggregate 仍可调用但不是必需前置。`length` 仍为失败，不执行残缺参数、不重试或自动增加预算。
- Source 生命周期按生产者的 child-owned 归属核验，旧 parent-owned 事件只在完整身份匹配时兼容；不重写历史事件。
- 已知失败尝试的 usage 可参与 Trace 一致性核验，但缺失 usage 不补零，子 Run 失败仍使场景失败。
- 本地 V2 验收报告新增可选 diagnostics（最多 16 次模型 phase/cap 决策、64 条上传请求、Trace 核验阶段/原因）；严格白名单、超限记 dropped，旧报告和人工复核继续兼容。证据页面仍只显示摘要和引用。

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

烟测会在创建运行前计算 `sourceFingerprint`（64 位 SHA-256），覆盖 `src/`、`apps/` 和构建清单，以识别当前实际源码/构建输入，包括尚未提交的修改。报告只保留摘要指纹，不写入路径、源码内容或密钥；计算失败会在调用模型前终止。它用于区分本地验收产物，不替代 Git revision 或代码审查。

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

运行失败时也尝试关闭自有宿主并读取持久化快照。报告保留可核实的子 Run、`failures` 安全错误码/类别、已知 usage 小计；缺失用量标记 `partial/unavailable`，不能据此核实精确账单。可选 `checks[].status` 区分 `passed`、`failed`、`not_run`；未执行检查的 `passed=false` 仅表示尚不能通过，不表示检查已执行且失败。人工复审不会移除这些事实或把未执行项批准为通过。旧报告仍可读取。

`TRACE_LOCAL_AUDIT_REJECTED` 表示上传前被本机白名单阻断；`TRACE_HTTP_ERROR` 表示远端 HTTP 返回失败。LangSmith 上传兼容 SDK 真实协商的 multipart/gzip，但仍拒绝附件、原始数据及超大正文。不要用关闭审计的方式绕过失败。

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

验收报告当前为 v2；复核命令仍可读取历史 v1 报告。它校验结构后调用确定性 `applyManualReview`，在同目录新建 `<runId>.reviewed.json`。原报告不覆盖；目标文件已存在时会失败。输出文件通过白名单重建，不保留输入文件中的未知字段或正文；CLI 不读取模型/LangSmith Key、不发 HTTP 请求。approved 必须使用计数 0；即使如此，失败检查或 LangSmith `failed`/`unavailable` 仍不能变成 `passed`。v1 报告缺少的新门禁会在升级后的 v2 报告中标为 `not_run`，人工批准不能补成通过。

v2 自动检查包含 `SCENARIO_OUTCOME_VALID`（父 Run 及预期子 Run 均完成，且没有截断输出失败）和 `SOURCE_FINGERPRINT_VALID`。运行时父提示、Metrics、Logs 和 Logs capture 共用 Lab 固定快照的同一 UTC 窗口；报告轮 token cap 仅在来源结果成功并带可验证证据引用后提升。

## 结果边界

- 自动检查、LangSmith 远端核验和人工复核是不同结果；报告必须保留三者状态。
- 没有真实运行就只能说 CLI/代码和 fake-client 测试已验证，不能说 DeepSeek、真实 Prometheus/Elasticsearch 或 LangSmith 远端验收通过。
- 此烟测验证的是模拟巡检链路，不证明目标业务系统已经接入生产指标、日志、Trace，也不授权任何真实写操作。
