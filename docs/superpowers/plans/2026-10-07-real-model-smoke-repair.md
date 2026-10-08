# 真实模型烟测失败修复实施计划

用户于 2026-10-07 批准本计划对应的对话方案；在现有 `codex/event-message-v2` 工作树实施。
Spec：`../specs/2026-10-04-real-model-langsmith-acceptance-design.md`，本计划更新其烟测修订约定。

实施状态（2026-10-08 更新）：原 Task 1–4 已实施；针对既有烟测中的 LangSmith HTTP 422 及评测可信度缺口完成一轮补强。全量离线 1153 项通过、7 项真实后端 opt-in 测试跳过；lint、类型检查、构建和 Web 类型检查/构建通过。真实模型/LangSmith 请求本轮均未发起；远端 422 是否已消除仍待单独验收。详见[修复验证记录](../../verification/2026-10-07-real-model-smoke-repair.md)，不据离线结果宣称线上模型、LangSmith 远端或生产数据已验收。

## Global Constraints

- 保留已有 modified/untracked 文件，不覆盖无关改动、不自动 push。
- 不修改 Harness 主循环、HITL、恢复、SQLite Schema、ToolResponse 和证据摘要/引用边界。
- V2 事件仅增加可选失败 usage/finishReason 字段；旧事件仍可读取，不补造缺失用量。
- 默认测试全部离线；真实模型最多一个父 Run，HTTP 最多 10 次，父 90 秒、子 30 秒，每来源一次；失败不自动重跑。
- 查询轮输出最多 512、报告/汇总轮最多 1024，所有父子/重试共享输出预留上限 5120；无 usage 的失败保留预留。
- LangSmith 仅允许白名单执行元数据；拒绝附件、原文、地址和密钥，解压后正文最多 1 MiB，HTTPS 1 秒、flush 2 秒、SDK 重试 0。
- 实施采用 TDD，先确认新回归失败再写实现。使用 Node 24 / 已锁定 pnpm，不升级依赖。

### Task 1: 失败诊断与用量保留

- 修改 model failure/assembler/evented model、可选 V2 failed usage 字段及聚合；截断仍失败，绝不执行残缺 JSON 或自动重试已暴露输出。
- Runner 在 Run 失败后也关闭自有宿主、读取安全 snapshot；报告保留子 Run、错误类别、已知 usage、未执行检查状态，不复制正文或异常全文。
- 先补截断 usage、旧 failed event 兼容、failed snapshot 和脱敏回归。

### Task 2: LangSmith 上传协议审计

- 独立文件 `src/acceptance/langsmith-export-transport.ts`，测试 `test/langsmith-export-transport.test.ts`；本任务不改 runner/bootstrap，控制器负责接线。
- 导出 `createAuditedLangSmithFetch(fetcher, config, sensitiveValues, onReject)`；config 使用现有 LangSmithEventConfig；onReject 参数为安全机器码 `TRACE_LOCAL_AUDIT_REJECTED`。
- 保持 JSON batch 现有白名单行为；支持 SDK multipart 的 post/patch 主记录及 inputs/outputs/events/extra/error/serialized JSON 部分。按记录重组后统一白名单，禁止未知/重复/孤立部分、附件和超大/恶意压缩数据。可复用现有 `isSafeLangSmithExportBody`，但避免循环依赖，必要时将纯白名单逻辑抽到独立模块。
- URL、method、endpoint path 必须白名单，禁止 redirect；保留 Request/AbortSignal，支持空 GET /info；streaming/gzip 均有界。去除 SDK runtime 后仅重建审计通过的安全上传，不转发未审计原始内容。
- SDK 能力协商返回 use_multipart_endpoint=true 的离线集成必须成功；canary/附件/不合法/超大请求必须在外部 fetch 前失败。
- 不修改 SDK 私有状态，不伪造 /info，不新增全局 retry。

### Task 3: 共享输出预留预算

- 独立修改 `src/model/bounded-smoke-fetch.ts`，新增 `src/model/smoke-output-budget.ts`、相应测试，必要时导出 model/index；不修改 runner/bootstrap。
- 保持现有 fixed-cap API 默认行为；新增显式 outputBudget，可按可验证请求阶段选 512/1024，整次预留上限 5120。
- 发送前原子预留；并发不能穿透，超过余额在本地安全 402 不发送。只在完整合法且与当前请求对应的最终 usage 已知时结算，缺失/异常/截断无 usage 不退还。
- 对 response 流采用有界轻量 usage 观察，不消费调用方流、不无限 tee；覆盖 SSE 分片、CRLF、并行/Abort/网络失败与恶意 usage，保证信号传播及有限内存。
- 请求计数 ledger 和输出 ledger 独立，共用同一 fetch 实例覆盖父子与重试。不得改变已暴露输出不重试的保护。

### Task 4: 接线、文档和验收

- 接线新审计与预算，安全区分本地拒绝和远端 HTTP；增加精简来源报告 smoke 提示，不收紧生产公共 Tool schema。
- 更新 Spec、现有计划/指南和实现状态，明确本次实现与真实验收、人工复核分别记录。
- 全量运行 lint/typecheck/test/build；相关 UI typecheck/build 按影响验证。审查差异、隐私与兼容性。
- 仅在真实凭据和后端均已配置时运行一次真实烟测；不能使用对话中旧密钥、读取无关终端历史或自动重跑。凭据缺失则只报告预检阻塞，不调用模型。

## 2026-10-08 补强轮记录

- Multipart：审计后采用受控 UTF-8 wire 编码，part 明确带字节长度且不生成 filename；离线 fake 服务对实际 multipart bytes 进行校验。原远端 422 的具体拒绝原因未被远端诊断信息证实，本轮不把离线结果表述为远端已修复。
- 窗口与预算：固定 Lab 快照的 UTC 时间窗贯穿父级提示、Metrics、Logs 和内部 capture；仅有效成功证据引用可提升报告阶段输出上限。
- 验收可信度：报告升为 schema v2，增加 `SCENARIO_OUTCOME_VALID` 与 `SOURCE_FINGERPRINT_VALID`；v1 可读，复核升级时新增门禁为 `not_run`，不能人工补成通过。指纹只写 SHA-256 摘要，不写文件路径或内容。
- 回归和质量门的最终结果见对应验证记录。所有检查只针对本地源码/假服务；不触发真实模型、LangSmith 或生产数据源，不提交、不推送。
