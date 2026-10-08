# 真实烟测跨层契约修复：离线验证记录

日期：2026-10-08
分支：`codex/event-message-v2`
范围：已批准的跨层契约修复 Tasks 1–6。保留工作树原有改动；未提交、未推送。

## 实现结果

- Metric evidence 的 `timeRange` 从 `summary.start/end` 的有效 Unix 秒确定性派生；不改 SQLite schema，不从 raw/capturedAt 推断。
- Logs capture 后，具有同一 evidence ID 的成功 search/read-slice 可以满足 report budget 资格；失败、空引用或跨 evidence ID 不提升预算，证据质量/诊断仍由确定性 Collector 与硬检查负责。
- Trace verifier 接受生产者使用的 child-owned Source 生命周期，并交叉校验 parent/child/toolCallId/source。严格拒绝跨父、重复生命周期和不匹配终态；失败模型的可用 usage/finishReason 与远端对比，缺失用量不补零。
- `/info` HTTP 响应进入 LangSmith SDK 前进行 UTF-8/JSON 验证及 capability 字段白名单筛选。非法 200 不会进入 SDK fallback/warning，不会再次请求或查询，诊断使用固定代码，响应正文 canary 不外泄。
- 独立 Trace probe 保持 opt-in、只生成两个 synthetic Span；真实模型 runner 在 Lab/父 Run/模型调用前执行当前探针准入。没有运行线上探针。
- 新 runtime contract 集成测试使用真实本地生产者/SQLite/投影，远端为 fake LangSmith；非 loopback 网络被测试 fetch 明确阻断。

## 质量门结果

使用仓库随附的 Node 24.19.0 工具和本地二进制，避免 pnpm shim 尝试从 registry 引导安装时的网络/EPERM 环境故障：

| 检查 | 结果 |
| --- | --- |
| ESLint 全仓（忽略既定 `apps/logs-lab/index.mjs`） | 通过 |
| TypeScript 全仓 `tsc --noEmit` | 通过 |
| TypeScript 生产构建 `tsc -p tsconfig.build.json` | 通过 |
| Agent Web TypeScript 检查 | 通过 |
| Agent Web Vite production build | 通过 |
| Vitest 全量（`--maxWorkers=2`） | 156 文件通过，3 个 opt-in 文件跳过；1,286 通过，7 跳过 |
| `git diff --check` | 通过；只有 Git 的 LF/CRLF 提示，不是空白错误 |

全量 Vitest 第一次以高并发执行时有两个 5 秒环境敏感超时；二者单独运行均通过，随后在 2 workers 的全量复跑中均未再现并且整套退出码为 0。跳过的是真实 Elasticsearch/Prometheus opt-in 测试。本轮没有设置或使用真实模型/LangSmith 凭据，测试全部使用本地 fake/脚本服务。

独立只读审查覆盖 Task 3/4 的身份/usage/finishReason、诊断回调隔离、`/info` 隐私与 fail-closed、SDK retry/fallback 路径；结论：无阻塞问题。回归测试以恶意响应 canary 证明日志和结果都不含正文。

## 未验证与限制

- 真实 LangSmith synthetic Trace probe：`not_run`。
- 真实 DeepSeek/OpenAI-compatible 模型 smoke：`not_run`。
- 生产 Prometheus/ELK 数据及 `group-buy-market` Profile：`not_run`。
- 人工检查真实模型最终回复：`not_run`。
- 因此历史远端 multipart HTTP 422 的真实服务端接受情况仍未解决/未证实；离线 SDK-compatible fake server 不能替代真实上传回读。
- `review_required` 或离线测试通过不等同生产上线许可。下一步应在用户单独授权后只运行独立 Trace probe；若通过，再单独授权最多一次真实模型烟测，不自动重跑。
