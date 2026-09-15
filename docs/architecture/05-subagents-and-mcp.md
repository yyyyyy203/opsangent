# 数据源 Subagent 与 MCP

本主题的首个可实施切片见 [来源 Subagent 设计规格](../superpowers/specs/2026-09-14-source-subagent-design.md)。

## 当前实现状态（2026-09-15）

`logs_subagent` 已完成首个可恢复闭环：它是父 Toolkit 中唯一的日志来源入口，内部通过注入的
child AgentHarness 使用四个有界 `logs.*` evidence Tools 和一个仅 child 可见的 `source_report`
Tool。child 仍经过统一 ToolAdmission、BatchExecutor、ExecutionPipeline、Guard/Hook 和
Checkpoint 管线；没有 Bash、动作、外部执行、任意 HTTP/SQL 或其他 Subagent。

适配器执行严格输入与宿主 profile/父 Run evidence 归属校验，使用稳定 childRunId，传递父 deadline、
取消信号、共享 Tool/网络尝试账本和 profile revision，并把结果压平为一个有界 ToolResponse。重试
最多三次；已产生父模型可见输出后不重试。child Checkpoint/Manifest 优先用于 Verify/Resume；已有
证据而后续查询失败时返回 `partial`，无证据时返回 `unavailable`，状态和 coverage 不采信模型填值。

当前验收是注入式/本地验收：日志页源、Manifest/Blob、Checkpoint 和模型均可替换，测试覆盖多轮
capture/search/aggregate/report、重试、恢复、预算和 Public/Audit/LangSmith 脱敏。尚未接入真实
Elasticsearch/ELK 地址、账号、Token 或公司 MCP，也没有实现 Metrics/Trace 的具体 Runner；后续接入
必须继续复用本 Tool 契约和来源边界，不能把底层 MCP 工具直接暴露给父模型。

## 分工

| 对外 Tool | 内部取证范围 | 返回重点 |
|---|---|---|
| metrics_subagent | Prometheus 查询 | 失败率、样本量、趋势、阈值、窗口 |
| logs_subagent | Elasticsearch 日志查询 | 错误聚类、异常原因分布、日志证据和 traceId |
| traces_subagent | Tempo 搜索与 Trace 明细 | 调用链、慢 span、关键路径及依赖异常 |

变更 Subagent 后续加入。按证据类型划分职责，每类可接多个同类后端，无需为每个索引或 MCP 工具新建 Agent。

Subagent 对外为 ToolAdapter，对内复用 Harness 自治取证。拥有独立上下文、来源限定 Toolkit、指令、证据集合和预算。只允许一层子 Agent，子 Agent 不再调用其他 Subagent。

## 输入与输出

输入至少含 profileId、service、startTime、endTime、调查问题及已有证据引用。父级 runId、deadline、scope、预算和关联信息由宿主注入，不信任模型自行填报的权限字段。

结果作为 ToolResponse 的 JSON block：source、status（complete/partial/unavailable）、summary、findings、evidenceIds、businessTraceIds、missingEvidence、coverage、toolCallsUsed、durationMs。每条 finding 区分观测事实和推断，并引用证据。子 Agent 只报告来源内结论，最终根因排序由主 Agent 关联。

## MCP 接入策略

Prometheus 使用独立最小只读 MCP；Elastic 和 Tempo 优先复用兼容的已有 MCP。具体仓库、许可证、协议版本、工具 Schema、安全范围必须在接入里程碑核验，本文不把候选当成已可用组件。候选不合格时实现受控只读适配器，不改变核心 Tool 契约。

每个 MCP 独立连接、健康状态、限流、超时和熔断。远程工具必须通过 Manifest 允许清单；不把发现到的所有远程工具直接暴露给模型。密钥和内部地址留在适配层配置。

## 普通工具、Skill 与计算

底层工具以一次有界查询为单位。失败率计算、阈值判断、错误原因排序、Trace 关键路径、证据关联等确定性处理器是内部函数，按需组合，不把每个算术函数都暴露成模型 Tool。

Skill 是按需加载的调查指引和能力编排入口，使用 skill.load 与 invoke_skill_function。声明可用工具与版本，不携带模拟答案；任何实际能力调用都回到统一 Pipeline。V1 不提供任意脚本执行沙箱。

## 并行与失败隔离

主 LLM 可同时提出三个 Subagent ToolCall；BatchExecutor 在父预算允许时并行，按原序 fan-in。各子 Agent 底层调用同样经过 Guard/Hooks，外层许可不能替代内层检查。

失败只恢复该子 Agent 的未完成步骤，不重跑已成功取证。外层最多一次恢复且沿用原截止和计数。子 Agent 返回 partial 时主 Agent 保留证据并说明缺口；权限拒绝不自动换工具规避。
