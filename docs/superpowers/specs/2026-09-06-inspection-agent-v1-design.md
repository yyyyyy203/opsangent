# 巡检诊断 Agent V1 设计规格

日期：2026-09-06。状态：讨论方案已确认，知识库已整理，供审阅与后续里程碑计划使用。本文及链接专题共同构成设计基线；本文不是实现完成证明。

## 产品目标

本地单用户经前端使用巡检 Agent。遥测模拟器驱动真实 Prometheus、Elasticsearch 和 Tempo；主 Agent 调度数据源 Subagent，通过 MCP Tool 取证，输出可回查、可审计的结构化诊断和详细自然语言摘要。后续接入 group-buy-market，再扩展受控保护动作。

## 决策索引

| 设计部分 | 规范 |
|---|---|
| 范围、V1/V2、迭代交付 | [产品边界](../../architecture/01-product-scope-and-roadmap.md) |
| 分层、注入、接口替换、Newton 边界 | [总体架构](../../architecture/02-system-architecture.md) |
| ReAct、调度、阶段、退出、恢复 | [Harness](../../architecture/03-agent-harness.md) |
| Tool、注册、四闸门、JSON/LLM/执行重试 | [工具系统](../../architecture/04-tool-system.md) |
| 三类 Subagent、MCP、Skill、确定性处理 | [数据源能力](../../architecture/05-subagents-and-mcp.md) |
| Guard、Hooks、中断、HITL、安全动作 | [安全机制](../../architecture/06-guard-hooks-hitl.md) |
| Context、L0/L1/L2、记忆、SQLite、证据 | [状态治理](../../architecture/07-context-memory-storage.md) |
| Agent Trace、业务 Trace、LangSmith、审计 | [可观测](../../architecture/08-observability.md) |
| 双前端、模拟场景、API、三类触发 | [应用与模拟器](../../architecture/09-simulator-and-apps.md) |
| 超时、预算、熔断、测试、评测 | [可靠性与验收](../../architecture/10-reliability-and-evaluation.md) |
| 版本兼容、报告、实现缺口、工程约束 | [契约与工程](../../architecture/11-contracts-and-engineering.md) |

## 关键不变量

所有能力通过统一 Tool Pipeline。主子 Agent 复用唯一 Harness 实现。解析失败不变成空对象；程序修复一次，LLM 每纠错链一次，新调用重新过全闸门。并行分支结果不因单分支失败重放。授权和重试预算不随新调用 ID 重置。

原始证据可回查，压缩保留事实和引用。模拟答案与 Agent 隔离。LangSmith 故障不阻止本地诊断，业务 Trace 和 Agent Trace 分开关联。V1 不注册真实动作和 Bash，证据不足输出 partial/inconclusive。

## 交付顺序

按 V1.1 遥测实验室、V1.2 能力接入、V1.3 手动闭环、V1.4 可靠运行、V1.5 评测交付拆分实施计划。框架内部先有契约和脚本化测试，再接外部后端与模型。

具体前端/API 框架、SQLite 驱动、MCP 候选和镜像版本属于各里程碑的实现选型，须在对应计划中锁定并验证兼容性。这里不把未经用户选择或实测的库版本宣称为既定可运行环境。

## 自审说明

已统一 ToolResponse 外壳、Run 生命周期与诊断结果区别、父子总预算、JSON 纠错链和消息配对，补充证据文件与 SQLite 的非原子提交恢复规则。已记录早期 AGENTS.md 接入顺序与当前模拟器优先范围的差异。

当前文档只描述目标和读取确认的骨架状态。生产可用性、依赖兼容、MCP 候选和验收指标需通过实施及测试证明。
