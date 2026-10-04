> 本文保留可观测性总体目标；Event/Message 字段契约以 [Event 与 Message V2 协议](./15-event-message-v2.md) 为准，当前实现范围以 [实现进度](../implementation-status.md) 为准。

# 可观测、LangSmith 与审计

## 两类链路

Tempo 保存被巡检业务的 Trace；LangSmith 记录 Agent 自身模型、工具、Subagent、检索和重试执行。二者通过证据引用关联，不能混用 traceId。

| 标识 | 用途 |
|---|---|
| runId | 本地一次巡检主键 |
| stepId / toolCallId | 推理步骤和工具调用 |
| subagentRunId / parentRunId | 父子执行关系 |
| agentTraceId / spanId / parentSpanId | Agent 观测链路 |
| businessTraceIds | 业务 Trace 精确查询入口 |
| evidenceId | 可回查证据主键 |
| correctionChainId | 参数纠错前后尝试关联 |

具体字段新增须做兼容性审查。不能因为同名 traceId 字段就直接建立业务与 Agent 父子 span。

## Span 结构

```text
inspection.run
  model.reasoning
  tool.metrics_subagent
    subagent.run
      model.reasoning
      tool.prometheus.query_range
  tool.logs_subagent
  tool.traces_subagent
  report.validation
```

记录起止时间、状态、模型版本、usage、脱敏输入摘要、错误码、闸门、修复规则、重试次数、预算消耗、数据覆盖和证据引用。并行 span 必须显式带 parent，不能依赖共享可变“当前 span”。

### 当前 Subagent 链路

已实现的 `logs_subagent` 生命周期复用 V2 `SUBAGENT_*` 事件。事件信封携带 childRunId、
parentRunId、parent ToolCall/step 关联和 attempt 信息；LangSmith Projector 优先把 child
`subagent.logs` span 挂到同一父 `tool.logs_subagent` span，历史事件缺少 ToolCall 关联时才
回退到 parent Run。生命周期上报失败不会阻塞本地 ToolResult、Checkpoint 或证据提交。

当前只验证了注入式日志页源、SQLite/local Blob 和本地模型/协议测试。真实 ELK、公司 MCP、线上模型
和生产 LangSmith 数据集仍未接入；不得把本地 span 关系测试表述为线上观测验收。

### Metrics Subagent 链路

Metrics 的本地组合固定为：

```text
tool.metrics_subagent
  subagent.run
    model.reasoning
    tool.metrics.settlement
    tool.source_report
    report.validation
```

父级只发布 `metrics_subagent`，child 只看到 `metrics.settlement` 和 `source_report`。父子 Run、
ToolCall、step、attempt 和 evidenceId 通过既有 V2 生命周期与 LangSmith 投影关联；Collector 在
投影前重新计算指标事实和 coverage，模型候选数字或根因不具备覆盖权。测试确认父 Context、Public
SSE、Audit 与 LangSmith 事件不含原始 Prometheus 响应或测试 raw marker。

目前验证的是 simulation checkout Profile 和本地 OpenAI-compatible SDK/SSE 协议。真实 Prometheus
路径仅在 `AGENTOPS_REAL_PROMETHEUS=1` 且后端实际运行时才算验收；默认测试保持跳过，本轮 Docker
不可用，因此没有真实后端结果。线上 LangSmith、ELK/Trace 和生产数据集仍未接入。

## 本地事实与远程观测

本地事件及 SQLite 是审计和恢复事实来源。LangSmith 是可替换 Observability 实现，支持 Noop 和有界发送队列。上报失败记录本地状态，可重试但不拖垮诊断；flush 有截止时间，不能无期限阻塞 RUN_FINISHED。

脱敏在出站前统一执行，默认不上报原始日志、内部地址、密钥和客户字段。模型输入也需同等治理。远程不可用仍保存本地关联 ID，后续评测可导出脱敏记录。

## 事件与界面

SSE、审计、测试共用事件契约。订阅者错误隔离，不使远程观测故障变成工具失败。阶段、工具进度、重试和证据状态展示给用户；不展示隐藏思维链，只展示可审计的执行说明。

一期采用一套权威 Event V2 事实流，并通过 Public SSE、Audit、LangSmith 三类投影服务不同消费者；业务模块不得为三个消费者分别上报同一事实。事件信封、可见性、重放、脱敏、模型 usage、工具结果流和父子 Subagent 关联的完整约束见 [Event 与 Message V2 协议](./15-event-message-v2.md)。

## 评测

数据集包含触发输入、Profile/工具/提示词版本、模拟 fixture 版本、预期事实和证据约束。评测覆盖诊断正确性、数值一致性、引用回查、缺失证据说明、失败恢复、时延与成本。确定性评测先行，LLM judge 仅辅助评价可读性，不替代事实判定。

### 一次性真实模型 / LangSmith 验收

仓库提供 opt-in `acceptance:real-model` CLI：只有环境变量 `AGENTOPS_REAL_MODEL_SMOKE=1` 时才进入配置和 Run 流程；一次最多 10 个模型 HTTP 请求、每次最多 512 输出 tokens、Run 最长 90 秒，不自动重跑整轮。CLI 从本机服务端环境读凭证，保存安全报告摘要；它不把最终回答或原始证据打印到终端或写入报告。

`acceptance:review` 对同一个持久化 Run 的人工判断只记录 `approved/rejected` 和 unsupported-claim 数量，生成新报告，不覆盖原报告，不发网络请求，也不保留消息正文。人工批准不能覆盖失败的确定性检查或 LangSmith `failed/unavailable`。若 LangSmith 未启用，报告只能保持待复核，不能声称远端链路已通过。

上述 CLI 和 fake-client/fake-fetch 测试不等于真实外部联调。只有实际执行一次烟测并单独核对本地 Run、模型 usage、远端父子 span 和人工复核后，才能报告该次闭环结果；生产业务可观测数据集、生产凭证和业务系统接入仍需另外验收。
