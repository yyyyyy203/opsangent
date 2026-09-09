> **DEPRECATED**：本文保留早期可观测性目标；Event/Message、投影、身份字段和当前实现状态已由 [Event 与 Message V2 协议](./15-event-message-v2.md) 与 [实现进度](../implementation-status.md) 取代。

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

## 本地事实与远程观测

本地事件及 SQLite 是审计和恢复事实来源。LangSmith 是可替换 Observability 实现，支持 Noop 和有界发送队列。上报失败记录本地状态，可重试但不拖垮诊断；flush 有截止时间，不能无期限阻塞 RUN_FINISHED。

脱敏在出站前统一执行，默认不上报原始日志、内部地址、密钥和客户字段。模型输入也需同等治理。远程不可用仍保存本地关联 ID，后续评测可导出脱敏记录。

## 事件与界面

SSE、审计、测试共用事件契约。订阅者错误隔离，不使远程观测故障变成工具失败。阶段、工具进度、重试和证据状态展示给用户；不展示隐藏思维链，只展示可审计的执行说明。

一期采用一套权威 Event V2 事实流，并通过 Public SSE、Audit、LangSmith 三类投影服务不同消费者；业务模块不得为三个消费者分别上报同一事实。事件信封、可见性、重放、脱敏、模型 usage、工具结果流和父子 Subagent 关联的完整约束见 [Event 与 Message V2 协议](./15-event-message-v2.md)。

## 评测

数据集包含触发输入、Profile/工具/提示词版本、模拟 fixture 版本、预期事实和证据约束。评测覆盖诊断正确性、数值一致性、引用回查、缺失证据说明、失败恢复、时延与成本。确定性评测先行，LLM judge 仅辅助评价可读性，不替代事实判定。

当前存在 LangSmith 适配器骨架，嵌套 span、脱敏、可靠发送、数据集和完整评测尚需实施与验证。
