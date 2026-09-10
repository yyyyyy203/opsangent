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

下一持久化增量的已确认方案见 [Durable Run State & Evidence V1 设计](./superpowers/specs/2026-09-10-durable-run-state-evidence-design.md)。该文档目前是设计决策，不代表代码已经实现。

最新已实现能力与检查结果见 [实现进度](./implementation-status.md)。

V2 分支文档与代码的一致性审计见 [V2 文档审计记录](./documentation-audit-v2.md)。

## 文档状态

- 决策状态：已由项目负责人确认，可用于拆分实施计划。
- 当前代码状态：Event/Message V2 协议、AsyncGenerator 模型/工具事件链、Node.js 20 兼容的 OpenAI-compatible 本地流式适配器、内存/SQLite 存储、公共/V1/Audit/LangSmith 投影、暂停恢复和 Node HTTP/SSE 入口已落地；真实 DeepSeek 在线验收、真实数据源的完整 Subagent、生产 Registry、前端和完整运行时生命周期接入仍按实现进度推进。
- 代码来源：本项目独立实现。Newton 仅用于机制参考；不得把未获授权的公司源码复制到本仓库。
- 第一阶段：只读诊断和模拟验证，不接入真实写动作，也不读取业务仓库代码。

## 变更规则

公共事件、消息块、`ToolResponse`、Harness 顺序、HITL 语义、Checkpoint Schema 或自动写动作发生变化前，必须先更新设计决策，再修改实现。根目录 [AGENTS.md](../AGENTS.md) 的安全和依赖约束优先级最高。
