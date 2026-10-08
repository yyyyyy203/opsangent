# 真实模型烟测修复验证记录

日期：2026-10-07。实施目录：`D:/agentops/.worktrees/event-message-v2`，分支 `codex/event-message-v2`。本轮基于 HEAD `ce4d4e7` 的未提交工作树实施；保留开始前已有的 modified/untracked 文件，未自动提交或推送。HEAD 不代表这些未提交改动的完整快照。

对应[实施计划](../superpowers/plans/2026-10-07-real-model-smoke-repair.md)和[联合验收 Spec](../superpowers/specs/2026-10-04-real-model-langsmith-acceptance-design.md)。

## 已实施

- 截断输出仍按 terminal `output_truncated` 失败，保留供应商已返回的安全 usage 和 `finishReason`；不执行残缺工具参数、不自动重试或 fallback。V2 failed payload 只增加可选字段，旧事件和报告保持可读，无持久化迁移。
- 正常完成和异常退出使用同一安全失败摘要收集器，保留父子 Run 的白名单错误码、类别及已知 token 小计。失败运行也尝试关闭自有宿主后读取持久化快照；未执行检查显式标为 `not_run`，人工复审不能把未执行/失败项变成通过。不保存异常全文或模型原文。
- LangSmith 审计支持 SDK 实际协商的 JSON batch、multipart 和 gzip；重组 split fields 后统一白名单校验，再重建安全请求。仍禁止附件、未知字段、原始数据、凭据、重定向及超大正文。区分本地审计拒绝与远端 HTTP 失败。
- LangSmith 一秒超时覆盖响应头和正文，正文卡住时取消读取；请求/响应读取、解压和 multipart 重建均有界。
- 烟测查询轮最多输出 512 token，来源报告/最终汇总轮最多 1024；父子调用和重试共享 5120 输出预留及 10 次 HTTP 上限。预留在发送前同步完成，只有可信最终 usage 才结算；缺失用量、Abort、网络错误和不完整流不退还预留。不改变生产 Tool schema、Harness、HITL、Checkpoint 或证据摘要/引用边界。

## 回归证据

- 失败子 Run 的类别在父 Run 完成后丢失：新增回归先失败（`failures` 为 `undefined`），共享收集器接线后通过。
- 已到响应头但正文不结束：修复前探针返回 headers-only 且没有取消；修复后产生 `TimeoutError` 并取消读取，Vitest 回归通过。
- 输出预算未接线：新回归先收到 200 而非本地 402；接线后通过。并发、父子共享、重试、无 usage、Abort、恶意计数和截断均有覆盖。
- SDK multipart 离线集成与上传隐私回归通过；真实远端接收仍需单独验收。
- 最新聚焦复验为 3 个文件、114 项通过，覆盖父子失败诊断、实际截断 tool JSON、不重试/fallback 和完整上传超时。
- 独立审查已收口：响应正文超时、父完成时子失败诊断两项发现均修复并复审通过；共享预算与结算机制复审未发现待修的 Critical/Important 问题。

## 质量门

使用 Node 24.19.0 和当前锁定依赖，没有升级依赖。由于当前 pnpm 命令转发不能解析本地工具，直接调用同一已安装包的入口，命令与 package scripts 等价；测试仅额外限制并行数。

```powershell
# 下列 node 指向 Node 24.19.0。
node node_modules/eslint/bin/eslint.js . --ignore-pattern apps/logs-lab/index.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node node_modules/vitest/vitest.mjs run --maxWorkers 2
```

ESLint、TypeScript no-emit、构建和全量测试均通过，退出码 0。最终 Vitest 于 22:38:49 开始，持续 210.95 秒：**150 个文件、1144 项测试通过，3 个 opt-in 文件的 7 项测试按设计跳过**。跳过的是 `logs-web-real-elasticsearch`（4 项）、`metrics-web-real-prometheus`（2 项）和 `real-prometheus`（1 项），未把它们计为通过。前端 typecheck/build 已在本轮通过，`git diff --check` 通过；原生 SQLite 和 HTTP/MCP 测试使用本地测试夹具，不连接生产系统。

## 未验证边界

当前执行进程没有模型/LangSmith 凭据，因此本轮真实模型请求数为 **0**，未消耗 DeepSeek 模型余额，也没有执行 LangSmith 远端验收。未验证 `group-buy-market` 生产数据、真实生产 ELK/Trace 或线上模型诊断质量；不能据离线测试宣称真实闭环通过。

5120 是输出 token 预留上限，不是人民币总花费上限；输入 token 仍会计费，且依赖供应商遵守输出上限并提供准确 usage。缺失或不可信 usage 时保守保留预留，不能据本地账本承诺精确账单。

后续在已配置凭据和本地后端的同一终端，按[验收指南](../guides/real-model-langsmith-acceptance.md)仅运行一次烟测。保留报告的 usage 完整性、远端核验与人工复核三个独立状态；失败先读固定错误码及安全报告，不自动重跑。用量缺失时不估算精确账单。

## 2026-10-08 补强轮复验

本节是后续迭代记录，不改写上面的 2026-10-07 验证结果。工作目录仍为 `D:/agentops/.worktrees/event-message-v2`、分支 `codex/event-message-v2`。保留了本轮开始时所有既有 modified/untracked 文件；未提交或推送。

### 修复内容与边界

- **Multipart 422 防回归**：审计后的上传使用受控 multipart 编码；每个 JSON part 的 `Content-Type` 为 `application/json`，独立 `Content-Length` 头按 UTF-8 字节精确计数，`Content-Disposition` 不含 `filename`。离线 fake LangSmith 端检查实际 wire body，错误格式会返回 422。该测试能证明本地编码符合官方 SDK serializer 格式及离线检查；此前真实远端返回的 422 没有给出具体字段级原因，因此本轮没有声称远端已确认修复。
- **同一遥测时间窗**：Lab 在产生模拟快照时给出规范 UTC `sourceWindow`；父 Agent 上下文、Metrics/Logs 查询及 Logs capture 都使用并核验该窗口，避免同一次巡检混用窗口。
- **证据驱动的 token cap**：只有成功、带有效 evidence ID 且跨工具引用可匹配的来源结果，才能把该轮输出上限提升到报告档；不可用、失败、空证据或引用不匹配不升级。
- **验收报告可信度**：报告 schema 升到 v2；新增 `SCENARIO_OUTCOME_VALID`（父子 Run 均完整完成且没有 `output_truncated`）及 `SOURCE_FINGERPRINT_VALID`。源码指纹覆盖 `src/`、`apps/` 和构建清单，报告仅保存 SHA-256；计算失败须在付费模型调用前终止。v1 历史报告仍可读，人工复核会把新门禁记为 `not_run`，不能批准通过。

### 本轮验证结果

- 聚焦回归：13 个文件、289 项通过（覆盖报告兼容、来源时间窗、证据预算、multipart 编码与 usage 账本）。
- 全仓 ESLint：通过；TypeScript `--noEmit`：通过；构建：通过。
- 全量 Vitest：151 个文件通过、3 个 opt-in 文件按设计跳过；1153 项通过、7 项跳过。跳过项为真实 Elasticsearch/Prometheus opt-in 测试，不计为通过。
- Web TypeScript 检查与 Vite 生产构建：通过。
- `git diff --check`：通过；不把脏工作树的 HEAD 当作源码快照，报告的 `sourceFingerprint` 用于区分实际源码/构建输入。

本轮没有调用 DeepSeek/其他真实模型，没有发送 LangSmith 上传或读取请求，也没有连接生产数据源；模型请求和 LangSmith 外部请求数均为 0。上一次真实模型调用及其 422 记录仍保留为历史证据，不能因离线回归通过而标记成已解决。需要在用户单独授权后，用一次受限的 synthetic LangSmith probe 验证远端 multipart 接收；该 probe 不应调用模型。之后若要复验完整烟测，仍须另行确认预算、凭据和后端状态，失败不得自动重跑。
