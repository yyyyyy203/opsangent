# 巡检诊断 Agent 架构知识库

本目录是 `agentops` 的架构事实来源（Architecture Knowledge Base）。文档描述已确认的目标设计；代码是否已经实现，以各文档的“实现状态”说明和仓库源码为准。

## 阅读顺序

1. [产品边界与迭代路线](./architecture/01-product-scope-and-roadmap.md)
2. [总体架构与模块边界](./architecture/02-system-architecture.md)
3. [Agent Harness 与运行状态机](./architecture/03-agent-harness.md)
4. [统一 Tool、四道闸门与重试](./architecture/04-tool-system.md)
5. [数据源 Subagent 与 MCP](./architecture/05-subagents-and-mcp.md)
6. [Guard、Hooks、HITL 与动作安全](./architecture/06-guard-hooks-hitl.md)
7. [上下文、压缩、记忆与持久化](./architecture/07-context-memory-storage.md)
8. [可观测、LangSmith 与审计](./architecture/08-observability.md)
9. [遥测模拟器、前端与触发入口](./architecture/09-simulator-and-apps.md)
10. [可靠性、测试、评测与验收](./architecture/10-reliability-and-evaluation.md)
11. [公共契约与工程约束](./architecture/11-contracts-and-engineering.md)
12. [MCP 只读接入实现](./architecture/12-mcp-implementation.md)
13. [指标实验链路实现与复验](./architecture/13-metrics-lab-implementation.md)
14. [结算指标 MCP 与证据闭环](./architecture/14-settlement-mcp-evidence.md)
15. [Event 与 Message V2 协议](./architecture/15-event-message-v2.md)

完整 V1 设计基线见 [巡检诊断 Agent V1 设计规格](./superpowers/specs/2026-09-06-inspection-agent-v1-design.md)。

记忆系统下一增量见 [受控诊断记忆一期 Spec](./superpowers/specs/2026-10-10-governed-diagnostic-memory-design.md) 与 [逐文件实施计划](./superpowers/plans/2026-10-10-governed-diagnostic-memory.md)。当前为待实施设计：默认关闭，以“案例保存 → 人工审核 → 同范围有界召回 → 恢复复核”为一期闭环；不启用向量模型、自动经验晋级或自动动作。

下一持久化增量的已确认方案见 [Durable Run State & Evidence V1 设计](./superpowers/specs/2026-09-10-durable-run-state-evidence-design.md)。该文档目前是设计决策，不代表代码已经实现。

后续 ELK 日志达到几十 MiB 时的已确认扩展方案见 [ELK 大体量证据流式摄取与 BlobStore 设计](./superpowers/specs/2026-09-10-elk-large-evidence-blob-storage-design.md)。该方案规定 SQLite Manifest、流式分页、BlobStore、预算截断、恢复和 LangSmith 脱敏边界，当前尚未实施。

最新已实现能力与检查结果见 [实现进度](./implementation-status.md)。

2026-10-05 本机 Prometheus、Elasticsearch 测试后端和浏览器验收的范围、结果与生产边界见[本轮验收记录](./verification/2026-10-05-local-acceptance-closeout.md)。

个人开发环境的一次性真实模型/LangSmith 验收入口及人工复核操作见 [真实模型与 LangSmith 联合验收指南](./guides/real-model-langsmith-acceptance.md)。指南只描述受限烟测机制，不代表已经执行线上验收。

V2 分支文档与代码的一致性审计见 [V2 文档审计记录](./documentation-audit-v2.md)。

## 文档状态

- 决策状态：已由项目负责人确认，可用于拆分实施计划。
- 当前代码状态：Event/Message V2 协议、AsyncGenerator 模型/工具事件链、OpenAI-compatible 本地流式适配器、内存/SQLite 存储、公共/V1/Audit/LangSmith 投影、暂停恢复和 Node HTTP/SSE 入口已落地。本机 Prometheus → MCP → Metrics Subagent（1/1）及 Elasticsearch/Prometheus Logs Web 测试后端浏览器验收（3/3）已通过，但使用的是模拟/验收数据，不等于目标业务或生产观测栈验收。Task 7 的一次性真实模型 CLI 与本地人工复核 CLI 已提供；在线模型、LangSmith 远端查询、生产数据源、托管 CI 和真实动作仍未闭环，详见[实现进度](./implementation-status.md)及[本轮验收记录](./verification/2026-10-05-local-acceptance-closeout.md)。
- 代码来源：本项目独立实现。Newton 仅用于机制参考；不得把未获授权的公司源码复制到本仓库。
- 第一阶段：只读诊断和模拟验证，不接入真实写动作，也不读取业务仓库代码。

## 变更规则

公共事件、消息块、`ToolResponse`、Harness 顺序、HITL 语义、Checkpoint Schema 或自动写动作发生变化前，必须先更新设计决策，再修改实现。根目录 [AGENTS.md](../AGENTS.md) 的安全和依赖约束优先级最高。
