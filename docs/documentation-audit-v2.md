# V2 分支文档审计记录

审计日期：2026-09-09。审计分支：`codex/event-message-v2`。

本文记录本次“文档是否过时”的判断依据，避免把目标设计、历史实施计划和当前实现状态混在一起。审计对象是本文件新增前 `docs/` 下的 27 份文档；本文件是审计产物，不纳入自身审计。判断以源码和测试为准，不以文件日期或文档自述为准。

## 代码事实基线

- `src/application/create-runtime.ts` 组装 `EventFactoryV2`、`EventPublisherV2`、内存/SQLite EventMessageStore、ReplayBuffer、MessageAssembler、ProjectionRunner、Public/V1/Audit/LangSmith 投影和 `ready` 启动回放。
- `src/agent/agent-harness.ts` 使用直接 AsyncGenerator；`replyStream()`/`resumeStream()` 直接产生 V1 兼容事件，V2 事实通过已等待的 Publisher 发布；消费者关闭时执行取消、Checkpoint 和 observability 清理。
- `src/tool/tool-runner.ts`、`src/tool/execution-pipeline.ts`、`src/tool/batch-executor.ts` 提供工具流式链路，并保留 Promise drain 包装；安全工具并发、动作工具串行，最终结果按调用顺序收敛。
- `src/event/projectors/v1-projector.ts` 与 `src/event/v1-payloads.ts` 负责 V2→V1 安全映射；V2 模式下 V1 EventBus 由兼容投影提供，不由 Harness/Pipeline 另行写入事实。
- `src/infrastructure/sqlite/` 已有事件消息和投影存储；`src/infrastructure/mcp/`、`src/mcp/` 和 `src/bootstrap/metrics-lab.ts` 已有只读 MCP、来源韧性和 Metrics Lab 组装。
- 当前仍没有 Agent Web、Simulator Web、ELK/Tempo 领域适配器、完整生产模型适配器、持久化 EvidenceStore/Run Checkpoint 或调度/Alertmanager 实现。因此目标架构文档中的这些内容不能当作已交付能力。

## 架构文档审计

| 文档 | 处理 | 判断依据 |
|---|---|---|
| `architecture/01-product-scope-and-roadmap.md` | 保留 | 明确是产品范围与路线图，描述的是目标里程碑，不冒充当前实现。 |
| `architecture/02-system-architecture.md` | 保留 | 描述目标分层、依赖方向和未来入口，并标注实现阶段；未被 V2 代码误写成现状。 |
| `architecture/03-agent-harness.md` | 标记 `DEPRECATED` | “当前状态”仍称 Harness 只有基础骨架，已被直接 Generator、V2 验收文档和当前实现取代。原循环、预算和恢复目标仍有历史参考价值。 |
| `architecture/04-tool-system.md` | 保留 | 是统一 Tool、四闸门、Hook 和重试的目标契约；其中已实现部分与 `src/tool/` 对应，未实现部分仍以目标语气表达。 |
| `architecture/05-subagents-and-mcp.md` | 保留 | 保留每类数据源 Subagent 的目标边界和 ToolAdapter 设计；当前只有通用适配器/只读 MCP，不把三类 Subagent 宣称为已完成。 |
| `architecture/06-guard-hooks-hitl.md` | 保留 | Guard、Hook、HITL 的职责边界和安全策略仍是有效约束；真实写动作仍明确属于后续范围。 |
| `architecture/07-context-memory-storage.md` | 更新当前实现段 | 原文把 SQLite Event/Message 存储也写成目标；已改为区分已实现的 V2 存储与仍待实现的 Evidence/Checkpoint、L0/L1/L2 和长期记忆能力。 |
| `architecture/08-observability.md` | 标记 `DEPRECATED` | 原文仍称 LangSmith 只有适配器骨架，且身份/投影描述已由 V2 协议细化；目标评测内容保留供历史参考。 |
| `architecture/09-simulator-and-apps.md` | 保留 | 是两套前端、触发器和遥测后端的目标设计，并明确使用后续里程碑语气；当前只有服务端实验入口不构成冲突。 |
| `architecture/10-reliability-and-evaluation.md` | 保留 | 描述降级、熔断、评测和验收目标，未把未完成的线上能力写成当前事实。 |
| `architecture/11-contracts-and-engineering.md` | 标记 `DEPRECATED` | 2026-09-06 的状态段明确说 V2、MCP、SQLite 等尚未实现，已被当前 V2 协议、实现进度和验收状态取代；工程约束仍保留。 |
| `architecture/12-mcp-implementation.md` | 更新当前边界 | MCP 连接和韧性实现仍有效；已补充 Metrics Lab、V2 SQLite 事件消息存储，以及证据/Checkpoint、前端和其他数据源仍未持久化的事实。 |
| `architecture/13-metrics-lab-implementation.md` | 更新当前状态 | 已补充 loopback 管理 API、统一启动入口、当前测试计数和真实 Prometheus 的显式启用条件。 |
| `architecture/14-settlement-mcp-evidence.md` | 更新当前状态 | 已区分内存 EvidenceStore 与 SQLite Event/Message 存储，并更新当前验证记录和后续缺口。 |
| `architecture/15-event-message-v2.md` | 保留并更新为当前权威文档 | 它覆盖 V2 契约、投影、消息完整性、AsyncGenerator、暂停恢复和验收门槛；已同步直接 Generator、工具流、消费者关闭、真实投影类名和当前验证计数。 |

## 根文档审计

- `docs/README.md`：保留，作为知识库入口；已增加本审计记录链接，当前状态描述与 V2 分支一致。
- `docs/implementation-status.md`：保留并更新最新增量；旧的带日期条目继续作为历史快照，不被误读为当前状态。
- `docs/event-message-v2-acceptance-status.md`：保留并更新直接 Generator、V1/V2 映射、消费者关闭和当前测试证据；它是 V2 验收结论的权威状态文档。
- 根目录除 `AGENTS.md` 外没有散落的 Markdown/分析文档。`AGENTS.md` 是执行约束，不属于知识库历史文档，因此不移动、不标记废弃。

## Plans 与 Specs 审计

- `docs/superpowers/plans/2026-09-07-event-message-v2.md`：标记 `DEPRECATED`。它是早期 V2 任务拆分，全部实施状态和部分执行结构已被 `architecture/15`、2026-09-09 AsyncGenerator 设计/计划取代，但保留为历史记录。
- `docs/superpowers/plans/2026-09-09-agent-harness-async-generator-tool-stream.md`：保留。它是当前分支最近一次改造的已完成实施计划，文件映射、验收和关闭语义与源码一致。
- `docs/superpowers/specs/2026-09-09-agent-harness-async-generator-design.md`：保留并补充“已落地”状态。它记录直接 Generator、V1/V2 双通道边界和消费者关闭语义，是当前实现的专项设计依据。
- `docs/superpowers/specs/2026-09-06-inspection-agent-v1-design.md`：保留。文档明确是目标设计基线而非实现证明，且仍用于约束完整 V1 范围。
- `docs/superpowers/specs/2026-09-06-openai-compatible-model-design.md`：保留。OpenAI-compatible 适配器仍是后续目标，当前源码尚未提供该完整适配器，文档没有被当前实现取代。
- `docs/superpowers/plans/2026-09-06-mcp-readonly.md`、`2026-09-06-tool-admission.md`、`2026-09-06-metrics-lab.md`：保留为已完成/进行中的历史实施计划；它们没有作为当前状态入口，当前事实分别以架构实现文档和 `implementation-status.md` 为准。

## 清理结论

本次没有发现可以安全删除的“完全冗余中间产物”：旧 V2 计划、旧状态文档仍包含决策和验证历史，因此按要求标记为 `DEPRECATED` 而不是删除。没有发现需要从根目录迁移的分析文档。当前阅读入口应优先使用 `docs/README.md`、`docs/architecture/15-event-message-v2.md`、`docs/implementation-status.md` 和 `docs/event-message-v2-acceptance-status.md`。
