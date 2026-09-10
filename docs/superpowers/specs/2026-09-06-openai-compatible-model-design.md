# OpenAI-compatible 模型适配设计

> 修订于 2026-09-09：根据现有代码审查结果，传输层改用 `openai` SDK；保留项目内的请求格式化、tool-call 聚合、协议校验和错误分类边界。

## 目标与边界

为现有 `ChatModel` 契约实现生产边界清晰的 OpenAI-compatible 流式适配器，首个配置目标为 DeepSeek。协议适配器负责消息/工具 Schema 格式化、SDK 流传输、流组装和错误分类；有界重试由独立 `ChatModel` 装饰器负责，Agent Harness 不感知供应商字段。

本增量仅支持文本、原生 function tool calls 和 usage。图像、reasoning_content、模型发现、compact model、JSON response_format 和真实供应商在线验收不在本轮。fallback 仍由已有装饰器负责，但本轮只验证其错误准入语义，不新增多模型路由。测试使用本地真实 HTTP/SSE 服务；没有 API Key 时也能完成协议验收。

## 参考与 clean-room 原则

参考官方 `deepseek-ai/deepseek-harness` 的公开 MIT 实现，吸收协议行为而不复制其框架：适配器是 transport-only；工具 arguments 原样保留；usage 和 finish 等到流末尾再确认；工具调用按 wire index 汇总。SSE framing 交给官方 `openai` SDK，但项目仍对 content-type、流终态、响应大小和公共契约做自己的校验。

本项目继续使用已有 `ChatModel`、`ModelResponse`、`RawToolCall`、`Tool` 和 Harness。不会引入 Cordis、DeepSeek Harness 包、其事件体系、附件系统或权限模型。两次 Git 浅克隆因连接重置失败，参考内容来自 GitHub 官方仓库页面与 raw 文件；失败目录位于项目外，不属于构建或源码。

## 方案选择

采用 `openai` SDK 作为 OpenAI-compatible HTTP/SSE 传输边界，项目内保留一个薄的 domain assembler。SDK 只存在于 `src/model/openai-compatible` 适配层，不向 `ChatModel`、Harness 或 `contracts` 泄漏 SDK 类型。

选择 SDK 的原因是把最容易出错的 UTF-8/CRLF/网络分片和 `[DONE]` framing 交给成熟实现，同时仍保留以下项目责任：请求消息格式化、工具参数按 wire index 交错聚合、usage/finish/空响应校验、错误脱敏、deadline/signal 传播和审计身份。SDK 内置 retry 必须显式关闭（`maxRetries: 0`），重试唯一由 `RetryingChatModel` 负责，避免重复请求和重复审计。

`fetch`、请求头生成和客户端创建均可注入。注入的 fetch 用于本地 HTTP 测试以及 trace/correlation header 透传；不得把 API Key、完整请求正文或响应正文写入 header、事件或错误。

## 模块结构

```text
src/model/openai-compatible/
├── types.ts             # Wire 类型
├── formatter.ts         # AgentMessage/Tool → chat-completions 请求
├── assembler.ts         # 文本、工具分片、usage 与 finish 汇总
├── client.ts            # openai SDK 创建、fetch/header 注入和响应边界
├── error-classifier.ts  # SDK/HTTP 错误 → ModelFailure
├── model.ts             # SDK stream 和 transport-only ChatModel 实现
└── index.ts             # 公开入口

src/model/
├── model-failure.ts     # 可序列化的 MODEL_ERROR 分类
├── retrying-model.ts    # 有界重试 ChatModel 装饰器
└── model-attempt-observer.ts # 尝试级审计端口与空实现
```

`formatter.ts` 和 `assembler.ts` 是纯领域代码，不读取环境变量。`client.ts` 是唯一接触 `openai` SDK 的模块；`model.ts` 只接收构造器配置及可注入的 client/fetch、clock。配置解析留在 bootstrap；API Key 不进入事件、错误、模型消息或测试快照。

## 请求格式

请求通过 SDK 的 `chat.completions.create()` 发送到规范化后的 `{baseUrl}/chat/completions`，字段为 `model`、`messages`、`stream: true`、可选的 `stream_options.include_usage: true`，有工具时增加 `tools`。是否发送 `include_usage` 由配置控制，以兼容不接受该扩展字段的网关。规范化只移除末尾斜杠，必须保留兼容网关已有的路径前缀，例如 `https://gateway.example/v1/` 得到 `https://gateway.example/v1/chat/completions`。本轮不发送未支持的供应商扩展字段。

工具由现有 `toolInputJsonSchema()` 转换为 `{type:'function', function:{name,description,parameters}}`。工具数组顺序保持 Toolkit 快照顺序，不在 Formatter 中重排。

消息规则：

- system/user 的 text 按块顺序用换行拼接；context_summary 以递归键排序的稳定 JSON 文本附在原角色消息。
- assistant 的 text 拼接为 content；已准入 `tool_call` 将 input 稳定 JSON 序列化；`raw_tool_call` 的 arguments 原样回放，不能先解析再序列化。
- tool 消息按每个 `tool_result` 独立展开，使用 `tool_call_id`。content 由 `renderToolResultForModel()` 按白名单生成稳定 JSON：允许 status、text/json/evidence_ref，以及纠错所需的 `error.code`、安全 message、`gate`、`reason`、`retryableByModel`、`expectedSchema`、`issues`、`correctionChainId`、`remainingModelRetries`；禁止 metadata、artifact URI、本地路径、任意基础设施 error.details 和原始证据正文。
- 无法表示、孤立或不完整的消息在请求发出前返回 `MODEL_ERROR`，不静默删除。
- tool-call-only assistant 的 content 使用空字符串，不使用 null。

baseUrl 只允许 http/https、无 URL 凭据、query 和 fragment；生产 DeepSeek 默认配置建议 `https://api.deepseek.com` 和 `deepseek-chat`，但库实现不硬编码密钥。HTTP 允许自定义 baseUrl 以支持本地测试和兼容网关。SDK client 必须设置 `maxRetries: 0`，并通过 `signal` 接收上层取消。

## SDK 流与组装

SDK 负责任意字节分片、UTF-8、CRLF、多行 data、注释和 `[DONE]` framing。`client.ts` 仍校验 `text/event-stream` content-type，并对响应总字节数设置可配置上限；协议层不另写一套 SSE parser。SDK stream 完成前发生 EOF、没有合法终态或没有可见内容时，不能把部分结果当成功。

仅接受唯一 choice index 0。文本 delta 立即产生 `text_delta`，同时累积最终 text。tool_calls 由 assembler 使用二级键 `(choice.index, tool_call.index)` 分桶；即使 index 0 和 index 1 的 arguments 交错到达，也必须分别追加到各自缓冲区，不能按到达顺序合并。id/name 是身份字段，只接受非空更新；流结束时每个调用必须有非空 id/name。arguments 无论 JSON 是否有效都作为 `RawToolCall` 返回，`toolCalls` 保持空数组，由现有四道闸门统一解析、修复和语义校验。

当前 `ModelStreamEvent` 没有公开 tool-argument delta 类型，因此不新增半截 tool-call 事件；未完成 arguments 只存在 adapter 内部。这样既保留真实 wire 顺序，又不会让 Harness 在 JSON 尚未完整时提前执行工具。

usage 可出现在 finish chunk 或尾随 usage-only chunk；取最后一个合法值。`prompt_tokens`/`completion_tokens` 映射为 `inputTokens`/`outputTokens`，`prompt_tokens_details.cached_tokens` 映射为新增的可选 `cachedInputTokens`，只接受非负安全整数。该字段会同步扩展 `ModelResponse.usage`、V2 usage schema、LangSmith projector 和相关快照；属于向后兼容的可选契约扩展，不提升现有 SQLite schema version。

只有 `stop` 和 `tool_calls` 是成功终态；`length` 映射为 `MODEL_ERROR/details.category=output_truncated`，未知原因、空响应、多个 choices、重复或矛盾身份均为协议失败。V1 的流事件不增加 finish-reason 事件；`ModelResponse.finishReason?` 只作为可选返回字段供 `EventedChatModel` 写入 V2 审计，不参与工具执行。

## 取消、超时和重试

`ModelCallOptions` 使用可选绝对时间 `deadline?: number`。Harness 按 `budget.startedAt + maxDurationMs` 计算并向模型传递 Run 截止时间；adapter 只实现父 `deadline` 与 `AbortSignal`，不在第一版增加首字节、空闲和多层本地 timer。deadline 已过期时不得发请求；父 signal 中止时必须停止 SDK stream 并映射为 `aborted`。没有 deadline 的直接调用仍由调用者的 signal 负责生命周期，bootstrap 的生产组装必须始终提供 Run deadline。

内部错误类别为 auth、rate_limit、server、network、timeout、protocol、aborted、context_length、output_truncated。`ModelFailure` 结构化满足现有 `AgentError`：code 固定为 `MODEL_ERROR`，细分类放在 `details.category`。错误对象进入 Checkpoint 前必须经 `toAgentError()` 转成普通 DTO；错误消息不得包含 API Key、请求正文、响应正文或完整内部 URL。

错误分类分为四种处置，不只依赖一个 HTTP status：

- `terminal`：402，以及错误 code/type 明确表示配额耗尽、余额不足或 hard billing limit 的 429；不重试、不 fallback。
- `fallback_only`：401、400，以及没有被识别为临时策略故障的 403；不重试，但允许已有 fallback 链接管。400 只有在 fallback 配置存在时才尝试替代模型，不能把客户端请求 bug 伪装成成功。
- `retryable`：5xx、普通 429、网络连接错误，以及被显式识别为临时性的 403；指数退避后重试，耗尽后允许 fallback。
- `aborted`：调用者 AbortSignal 或 Run deadline 触发；立即传播，不重试、不 fallback。

SDK 传输超时（包括 `APIConnectionTimeoutError`、`TimeoutError` 和 `ETIMEDOUT`）属于 `timeout/retryable`，不得与调用者取消混淆；只有父 `AbortSignal` 和 Run deadline 进入 `aborted`。若 HTTP 400 的 provider `code` 或 `type` 命中显式 context-length 白名单，必须在通用 400 规则之前分类为 `context_length/fallback_only`。解析 HTTP-date 形式的 `Retry-After` 时，分类器必须使用可注入时钟，不能直接读取环境 `Date.now()`。

403 不默认全部重试：只有 provider error code/type 命中可配置的 transient-forbidden 白名单时才进入 `retryable`，否则按 `fallback_only` 处理，避免权限错误被放大。429 必须先识别 quota code，再决定是 `terminal` 还是普通限流。`RetryingChatModel` 需要消费 `fallbackAllowed`/等价的结构化处置字段；不能对 terminal 或 aborted 无条件调用 fallback。遵循合法 Retry-After，但单次等待最大 2 秒；超过上限则本次调用直接失败，不提前请求。

一旦已向 Harness 产出任意可见文本 delta，就禁止透明重试，避免重复文本和重复计费。工具参数分片不向 Harness 暴露，若流在首次可见文本之前中断可以重试；已经产生文本后截断必须失败。装饰器在首次尝试前创建 messages/tools 的只读数组快照，所有尝试复用相同对象引用；Formatter 的确定性序列化保证请求语义稳定。本轮不新增多模型路由或供应商选择策略，继续复用已有 `RetryingChatModel` 的可选 fallback，并按四级处置决定是否允许 fallback。

## 流式契约与审计

Adapter 逐个 yield `text_delta`，在正常 SDK stream 结束后返回一个 `ModelResponse`：聚合 text、空的 toolCalls、完整 rawToolCalls 和可用 usage。Harness 继续负责发布 TEXT_DELTA、工具准入和 LangSmith span；Adapter 不直接发 AgentEvent。

本轮只对公共契约做向后兼容扩展：`ModelResponse.finishReason?`、`ModelResponse.usage.cachedInputTokens?`、V2 usage 的同名可选字段，以及 `AgentContext.failure?` 用于保存本次 Run 的结构化失败。`ModelCallOptions.deadline?` 已存在，本适配器只消费和传播它，不再重复设计。`ChatModel` 方法、`ModelStreamEvent` 和消息块联合不变；`EventedChatModel` 将可选 finish reason 和 usage 透传到 V2 `MODEL_CALL_COMPLETED`/`MESSAGE_COMPLETED`。Harness 必须持久化每次完整 assistant turn：有工具时把文本与 tool call 共同写入，无工具的最终文本也必须在完成 checkpoint 中保留。

兼容性决策：新增的 `finishReason`、`cachedInputTokens` 和 `failure` 都是 optional，旧调用者和旧 checkpoint 无需改写；当前 checkpoint 是对象存储且尚无 SQLite 列，因此本轮不提升数据库 schema version。读取旧状态时 `failure` 缺失等同于“没有已记录失败”。未来把 AgentContext 映射到关系表时必须把该字段纳入对应迁移，不能依赖这一决定跳过持久化迁移。

模型尝试通过小端口 `ModelAttemptObserver` 记录 attempt started/retry scheduled/succeeded/failed；载荷只含 runId、stepId、attempt、category、status、delayMs、usage 等脱敏字段。默认空实现，`ObservabilityModelAttemptObserver` 把每次尝试映射为现有 Observability 子 span，因此 LangSmith 可以看到成功重试和最终失败。暂不新增公共 AgentEvent；若前端要实时展示模型重试，必须另行做事件契约设计决策。模型边界把未知异常规范化为 `ModelFailure`，并携带不含供应商正文的 `disposition` 与 `fallbackAllowed`；`RetryingChatModel` 只据此决定重试和 fallback。Harness catch 使用 `toAgentError(error)` 保留已有结构化错误，避免把预算、工具或取消错误误标为模型错误；模型失败保存到 `AgentContext.failure` 并在 `RUN_FAILED` payload 中发布 code/category/retryable，成功 Run 清除旧 failure。

协议适配不负责系统提示词、巡检策略或证据规划。诊断质量提示词属于后续 Renderer/Prompt Policy 增量，不得塞进供应商 Adapter。

## 测试与验收

Harness 契约测试先覆盖：绝对 deadline 传播；assistant 文本与 tool call 同时持久化；模型结构化错误保存到 checkpoint 和 RUN_FAILED。

纯 Formatter 测试覆盖四种角色、换行拼接、稳定 JSON、多个工具结果、纠错字段白名单、敏感字段剔除、tool-call-only assistant、raw arguments 原样回放、Schema 和不可表示消息拒绝。Assembler 测试覆盖多个 tool-call index 交叉 delta、同一 index 的分片拼接、缺失身份、finish reason、usage-only chunk 和空响应；EventedChatModel 测试覆盖 finish reason 与 cached input tokens 的透传。

本地 HTTP/SSE 集成测试覆盖：文本流；中文跨字节分片；多个并行工具调用交错分片；无效 JSON arguments 进入 RawToolCall；usage 和 cached tokens；SDK 对缺失 DONE 的失败处理；错误 content-type；空响应；`length` 和未知 finish；响应上限；流式中途 Abort；Run deadline；401/400 fallback-only；402/quota-429 terminal；普通 429/503/网络错误有界重试；条件 403；Retry-After 上限；可见输出后不重试；尝试审计；错误脱敏。

Harness 集成测试用真实本地 SSE 服务让模型先调用 `metrics.settlement`，第二轮输出摘要，验证四道闸门、MCP、EvidenceStore 和最终文本共用真实 `OpenAICompatibleChatModel`。不访问 DeepSeek 在线服务，因此“兼容协议已验证”不能表述为“真实 DeepSeek 已验证”。

提交前执行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`。真实 API 验收等用户配置密钥后单独进行，并确保日志和错误不打印密钥。
