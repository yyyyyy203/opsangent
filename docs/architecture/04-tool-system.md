# 统一 Tool、四道闸门与重试

## 统一契约

MCP、Skill、Bash、Subagent 和内置函数都适配 Tool。保留现有 name、description、kind、inputSchema、call、requireUserConfirm、trustedWhenInWorkspace、userFacingLabel、isConcurrencySafe 字段。call 缺失表示外部执行；V1 运行配置禁止注册这类工具。

inputSchema 可以是 Zod 对象或 ToolInputSchema，注册时转换模型可见 JSON Schema，同时保留执行时校验器。Schema 来自已注册工具，模型仅选择工具并生成参数。

call 可返回 ToolResponse、Promise 或以 ToolResponse 结束的流。统一响应继续使用 blocks、evidenceIds、metadata、isError；此前对话中的 ok/error JSON 是 json block 内的错误说明示例，不能替换已有 ToolResponse 外壳。

## Registry

启动时加载本地 Manifest，建立 MCP 连接并执行工具发现，将远程 Schema 与本地允许清单校验，适配后注册。拒绝重名、Schema 不兼容和范围越权。每次 Run 固定 tools snapshot 和版本，模型前缀保持稳定。

主 Agent 的 scoped Registry 提供 Subagent 和 Skill 入口。子 Agent 只看到本来源允许的底层工具。已知工具离线与工具不存在分别报告 TOOL_UNAVAILABLE、TOOL_NOT_FOUND；后台重连更新健康状态，不在运行中静默修改 Schema。新工具或 Schema 版本在新 Run 生效。

## 四道闸门

闸门之前限制原始参数字节数、嵌套深度和单批调用数。流式输出收齐才开始解析。

| 闸门 | 校验 | 允许的恢复 | 失败码 |
|---|---|---|---|
| 1 存在性 | 当前 scoped snapshot 中精确匹配 | 仅 Manifest 明示别名；离线状态至多刷新一次 | TOOL_NOT_FOUND / TOOL_UNAVAILABLE |
| 2 JSON | 标准解析，根值必须为对象 | 一次确定性修复，去围栏/BOM/尾逗号 | TOOL_ARGUMENTS_PARSE_FAILED |
| 3 Schema | 必填、类型、枚举、额外字段 | 显式默认值及已声明规范化 | TOOL_ARGUMENTS_SCHEMA_INVALID |
| 4 语义 | 时间、服务、索引、查询量、调用层级 | Profile 明确允许的安全收缩 | TOOL_ARGUMENTS_SEMANTIC_INVALID / POLICY_DENIED |

失败不传空对象。拒绝截断 JSON 的猜测补全、业务字段猜测、模糊工具名匹配和隐式类型强转。重复键等歧义输入必须拒绝。合法的空对象仅在原始输入确为对象且 Schema/语义都允许时通过。

收缩时间窗口会改变证据覆盖，必须记录原始窗口和实际窗口，并反映在报告 missingEvidence 中。权限拒绝、Abort 和预算耗尽不能通过纠错绕过。

每道闸门返回 passed、degraded 或 rejected 判别联合。degraded 带规则及修改记录；原始参数只进入受控本地审计，LangSmith 上报脱敏元数据和哈希。

## JSON 失败后的 LLM 纠错

```text
解析失败 → 程序修复一次 → 再次解析
  → 仍失败：旧 toolCallId 配对失败 ToolResult 并保存 Checkpoint
  → Harness 下一次 Reasoning 提供错误位置、必要脱敏片段和目标 Schema
  → LLM 生成新 toolCallId → 全部四道闸门 → 统一执行管线
  → 仍失败：该纠错链耗尽，返回部分结果或不可用
```

默认每条逻辑纠错链一次 LLM 重新生成机会，计数属于 Harness，不属于模型提供的字段。持久化 correctionChainId、parentToolCallId、attempt、剩余额度和错误指纹；新 ID、改参数、进程恢复均不重置额度。新查询路径仍消耗父 Run 总预算并受重复检测。

若供应商整段响应格式已损坏，无法得到合法调用 ID，应在 Model/Formatter 边界返回结构化协议错误，交 Harness 有界重试；不要构造供应商不接受的孤儿 tool message。

## 三类重试

| 类型 | 默认上限 | 执行者 |
|---|---|---|
| 确定性语法修复 | 每个原始参数候选一次 | JSON 修复器 |
| LLM 纠错 | 每逻辑纠错链一次 | Harness |
| MCP 瞬态执行重试 | 每逻辑执行最多两次追加尝试 | 执行重试策略 |

计数独立但共享父级总时间和调用预算。MCP 重试额度不能因参数纠错生成新 ID 而无限补充。网络请求尝试也必须计入受限资源账本。不可重试的鉴权、权限、语义错误直接返回。重复失败不全局永久封禁该工具，只终止当前纠错链并降低该来源可用性。

## 统一执行管线

输入闸门 → Guard → 风险合并 → Pre-Hooks → HITL → 幂等检查 → Dry Run（动作）→ Runner → Post-Hooks → 结果与 Checkpoint。

BatchExecutor 只调度，Pipeline 管理准入/中断/持久化边界，Runner 只调用具体工具。返回值也需结构和大小校验、脱敏及证据外置。Guard 必须检查最终规范化参数，而非修复前参数。

## 当前契约迁移点

现有 ToolCall.input 已经是 Record，无法无损表达非法 JSON。实施时新增 RawToolCall/解析结果边界，保留规范化 ToolCall；不要将非法字符串硬塞 input 或提前转换为空对象。所有错误码、追踪元数据和结果扩展先进行兼容性设计。
