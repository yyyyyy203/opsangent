# OpenAI-compatible 模型适配设计

## 目标与边界

为现有 `ChatModel` 契约实现生产边界清晰的 OpenAI-compatible 流式适配器，首个配置目标为 DeepSeek。协议适配器负责消息/工具 Schema 格式化、HTTP/SSE 传输、流组装和错误分类；有界重试由独立 `ChatModel` 装饰器负责，Agent Harness 不感知供应商字段。

本增量仅支持文本、原生 function tool calls 和 usage。图像、reasoning_content、模型发现、多模型 fallback、compact model、JSON response_format 和真实供应商在线验收不在本轮。测试使用本地真实 HTTP/SSE 服务；没有 API Key 时也能完成协议验收。

## 参考与 clean-room 原则

参考官方 `deepseek-ai/deepseek-harness` 的公开 MIT 实现，吸收协议行为而不复制其框架：适配器是 transport-only；工具 arguments 原样保留；SSE 必须收到 `[DONE]`；usage 和 finish 等到流末尾再确认；工具调用按 wire index 汇总；调用者取消和流空闲超时分开处理。

本项目继续使用已有 `ChatModel`、`ModelResponse`、`RawToolCall`、`Tool` 和 Harness。不会引入 Cordis、DeepSeek Harness 包、其事件体系、附件系统或权限模型。两次 Git 浅克隆因连接重置失败，参考内容来自 GitHub 官方仓库页面与 raw 文件；失败目录位于项目外，不属于构建或源码。

## 方案选择

采用 Node 20 原生 `fetch` + 项目内小型 SSE 解码器。相比引入 OpenAI SDK，这能保持供应商中立、精确保留 raw arguments，并自行控制响应上限和取消；相比直接依赖 DeepSeek Harness 包，不会把其插件体系带入核心。相比手写整套 Agent 协议，只实现当前 `ChatModel` 边界，避免重复 Harness 职责。

## 模块结构

```text
src/model/openai-compatible/
├── types.ts             # Wire 类型
├── formatter.ts         # AgentMessage/Tool → chat-completions 请求
├── sse.ts               # 严格 SSE framing 和大小限制
├── assembler.ts         # 文本、工具分片、usage 与 finish 汇总
├── model.ts             # fetch、超时和 transport-only ChatModel 实现
└── index.ts             # 公开入口

src/model/
├── model-failure.ts     # 可序列化的 MODEL_ERROR 分类
├── retrying-model.ts    # 有界重试 ChatModel 装饰器
└── model-attempt-observer.ts # 尝试级审计端口与空实现
```

`formatter.ts` 是纯函数，不读取环境变量。`model.ts` 只接收构造器配置及可注入的 fetch、clock、sleep、random。配置解析留在 bootstrap；API Key 不进入事件、错误、模型消息或测试快照。

## 请求格式

请求发送到规范化后的 `{baseUrl}/chat/completions`，字段为 `model`、`messages`、`stream: true`、`stream_options.include_usage: true`，有工具时增加 `tools`。规范化只移除末尾斜杠，必须保留兼容网关已有的路径前缀，例如 `https://gateway.example/v1/` 得到 `https://gateway.example/v1/chat/completions`。本轮不发送未支持的供应商扩展字段。

工具由现有 `toolInputJsonSchema()` 转换为 `{type:'function', function:{name,description,parameters}}`。工具数组顺序保持 Toolkit 快照顺序，不在 Formatter 中重排。

消息规则：

- system/user 的 text 按块顺序用换行拼接；context_summary 以递归键排序的稳定 JSON 文本附在原角色消息。
- assistant 的 text 拼接为 content；已准入 `tool_call` 将 input 稳定 JSON 序列化；`raw_tool_call` 的 arguments 原样回放，不能先解析再序列化。
- tool 消息按每个 `tool_result` 独立展开，使用 `tool_call_id`。content 由 `renderToolResultForModel()` 按白名单生成稳定 JSON：允许 status、text/json/evidence_ref，以及纠错所需的 `error.code`、安全 message、`gate`、`reason`、`retryableByModel`、`expectedSchema`、`issues`、`correctionChainId`、`remainingModelRetries`；禁止 metadata、artifact URI、本地路径、任意基础设施 error.details 和原始证据正文。
- 无法表示、孤立或不完整的消息在请求发出前返回 `MODEL_ERROR`，不静默删除。
- tool-call-only assistant 的 content 使用空字符串，不使用 null。

baseUrl 只允许 http/https、无 URL 凭据、query 和 fragment；生产 DeepSeek 默认配置建议 `https://api.deepseek.com` 和 `deepseek-chat`，但库实现不硬编码密钥。HTTP 允许自定义 baseUrl 以支持本地测试和兼容网关。

## SSE 与组装

SSE 解码器必须正确处理任意字节分片、UTF-8、多行 `data:`、CRLF、BOM、注释和非 data 字段。单事件上限默认 256 KiB，总响应上限默认 4 MiB，均可配置。只有空行分隔才提交事件；EOF 时未提交尾部或未见 `[DONE]` 均视为截断，不能把部分结果当成功。收到 `[DONE]` 后立即停止消费并取消 reader；不承诺探测服务端在 `[DONE]` 之后发送的字节。

仅接受唯一 choice index 0。文本 delta 立即产生 `text_delta`，同时累积最终 text。tool_calls 以 wire `index` 分桶；id/name 是身份字段，只接受非空更新，arguments 是可分片追加文本。`[DONE]` 到达后，每个调用必须有非空 id/name；其 arguments 无论 JSON 是否有效都作为 `RawToolCall` 返回，`toolCalls` 保持空数组，由现有四道闸门统一解析、修复和语义校验。

usage 可出现在 finish chunk 或尾随 usage-only chunk；取最后一个合法值。现有公共契约只暴露 inputTokens/outputTokens，因此仅映射非负安全整数的 prompt_tokens/completion_tokens。只有 `stop` 和 `tool_calls` 是成功终态；`length` 映射为 `MODEL_ERROR/details.category=output_truncated`，未知原因、空响应、多个 choices、重复或矛盾身份均为协议失败。V1 不向 `ModelResponse` 增加 finishReason。

## 取消、超时和重试

`ModelCallOptions` 新增可选绝对时间 `deadline?: number`。Harness 按 `budget.startedAt + maxDurationMs` 计算并向模型传递 Run 截止时间；单次调用取父 deadline、连接超时、流空闲超时和适配器总调用上限中的最早者。父取消立即停止 fetch/body reader 并返回 `MODEL_ERROR`，details.category=`aborted`。连接默认 10 秒，流空闲默认 60 秒，适配器总调用上限默认 120 秒，全部可配置且测试注入。

内部错误类别为 auth、rate_limit、server、network、timeout、protocol、aborted、context_length、output_truncated。`ModelFailure` 结构化满足现有 `AgentError`：code 固定为 `MODEL_ERROR`，细分类放在 `details.category`。错误对象进入 Checkpoint 前必须经 `toAgentError()` 转成普通 DTO；错误消息不得包含 API Key、请求正文、响应正文或完整内部 URL。

`RetryingChatModel` 最多追加重试 2 次，仅限 429、5xx、网络和连接/首字节超时。401/403、400、context length、协议错误、输出截断和取消不重试。遵循合法 Retry-After，但单次等待最大 2 秒；超过上限则本次调用直接失败，不提前请求。

一旦已向 Harness 产出任意可见文本 delta，就禁止透明重试，避免重复文本和重复计费。工具参数分片不向 Harness 暴露，若流在首次可见文本之前中断可以重试；已经产生文本后截断必须失败。装饰器在首次尝试前创建 messages/tools 的只读数组快照，所有尝试复用相同对象引用；Formatter 的确定性序列化保证请求语义稳定。本轮不实现 fallback 链。

## 流式契约与审计

Adapter 逐个 yield `text_delta`，在正常 DONE 后返回一个 `ModelResponse`：聚合 text、空的 toolCalls、完整 rawToolCalls 和可用 usage。Harness 继续负责发布 TEXT_DELTA、工具准入和 LangSmith span；Adapter 不直接发 AgentEvent。

本轮只对公共契约做向后兼容扩展：`ModelCallOptions.deadline?`；`AgentContext.failure?` 用于保存本次 Run 的结构化失败。`ChatModel`、`ModelResponse`、`ModelStreamEvent` 和消息块联合不变。Harness 必须持久化每次完整 assistant turn：有工具时把文本与 tool call 共同写入，无工具的最终文本也必须在完成 checkpoint 中保留。

兼容性决策：两个新增字段都是 optional，旧调用者和旧 checkpoint 无需改写；当前 checkpoint 是对象存储且尚无 SQLite 列，因此本轮不提升数据库 schema version。读取旧状态时 `failure` 缺失等同于“没有已记录失败”。未来把 AgentContext 映射到关系表时必须把该字段纳入对应迁移，不能依赖这一决定跳过持久化迁移。

模型尝试通过小端口 `ModelAttemptObserver` 记录 attempt started/retry scheduled/succeeded/failed；载荷只含 runId、stepId、attempt、category、status、delayMs、usage 等脱敏字段。默认空实现，`ObservabilityModelAttemptObserver` 把每次尝试映射为现有 Observability 子 span，因此 LangSmith 可以看到成功重试和最终失败。暂不新增公共 AgentEvent；若前端要实时展示模型重试，必须另行做事件契约设计决策。模型边界把未知异常规范化为 `ModelFailure`，Harness catch 使用 `toAgentError(error)` 保留已有结构化错误，避免把预算、工具或取消错误误标为模型错误；模型失败保存到 `AgentContext.failure` 并在 `RUN_FAILED` payload 中发布 code/category/retryable，成功 Run 清除旧 failure。

协议适配不负责系统提示词、巡检策略或证据规划。诊断质量提示词属于后续 Renderer/Prompt Policy 增量，不得塞进供应商 Adapter。

## 测试与验收

Harness 契约测试先覆盖：绝对 deadline 传播；assistant 文本与 tool call 同时持久化；模型结构化错误保存到 checkpoint 和 RUN_FAILED。

纯 Formatter 测试覆盖四种角色、换行拼接、稳定 JSON、多个工具结果、纠错字段白名单、敏感字段剔除、tool-call-only assistant、raw arguments 原样回放、Schema 和不可表示消息拒绝。

本地 HTTP/SSE 集成测试覆盖：文本流；中文跨字节分片；并行工具调用交错分片；无效 JSON arguments 进入 RawToolCall；usage；CRLF/BOM/注释/多 data；缺失 DONE；错误 content-type；空响应；`length` 和未知 finish；响应/事件上限；Abort；Run deadline；连接和空闲超时；401/400 不重试；429/503/网络错误有界重试；Retry-After 上限；可见输出后不重试；尝试审计；错误脱敏。

Harness 集成测试用真实本地 SSE 服务让模型先调用 `metrics.settlement`，第二轮输出摘要，验证四道闸门、MCP、EvidenceStore 和最终文本共用真实 `OpenAICompatibleChatModel`。不访问 DeepSeek 在线服务，因此“兼容协议已验证”不能表述为“真实 DeepSeek 已验证”。

提交前执行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`。真实 API 验收等用户配置密钥后单独进行，并确保日志和错误不打印密钥。
