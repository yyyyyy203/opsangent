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

完整 V1 设计基线见 [巡检诊断 Agent V1 设计规格](./superpowers/specs/2026-09-06-inspection-agent-v1-design.md)。

## 文档状态

- 决策状态：已由项目负责人确认，可用于拆分实施计划。
- 当前代码状态：已有 TypeScript 基础 Harness、Tool 契约、执行管线、Hook/Guard、内存存储和 LangSmith 适配器骨架；生产 Registry、四道闸门、数据源 MCP/Subagent、SQLite、API、前端与模拟环境仍待实现。
- 代码来源：本项目独立实现。Newton 仅用于机制参考；不得把未获授权的公司源码复制到本仓库。
- 第一阶段：只读诊断和模拟验证，不接入真实写动作，也不读取业务仓库代码。

## 变更规则

公共事件、消息块、`ToolResponse`、Harness 顺序、HITL 语义、Checkpoint Schema 或自动写动作发生变化前，必须先更新设计决策，再修改实现。根目录 [AGENTS.md](../AGENTS.md) 的安全和依赖约束优先级最高。
