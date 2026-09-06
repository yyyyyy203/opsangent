# 上下文、压缩、记忆与持久化

## 上下文工程

AgentContext 是运行事实，至少包含触发、Profile、阶段、EvidencePlan、证据摘要、事实、候选、缺失证据、风险、预算、待确认/已执行动作、MemoryHints 和版本。模型消息是 Renderer 的输出，不能作为唯一真实状态。

ContextRenderer 组装稳定系统指令、工具快照、历史消息及尾部动态状态。按 token 预算分配证据、记忆和输出空间。来源文本视为不可信数据，日志中的命令和提示不能覆盖系统指令。模型文本不包含密钥、内部地址和不必要的客户数据。

主子 Agent 上下文隔离，仅通过输入和 EvidenceSubagentResult 交换摘要与引用。Run 标识和路径显式注入；AsyncLocalStorage 可作传递辅助，丢失时明确报错，不能回退到另一个会话或全局默认上下文。

## 三层压缩

| 层 | 触发 | 行为 | 失败处理 |
|---|---|---|---|
| L0 | 原始工具结果到达或超过大小限制 | 原文外置，保留摘要、范围、证据 ID | 落库失败不得发布可用证据引用 |
| L1 | 旧结果数量或上下文结构占用超限 | 确定性裁剪旧 ToolResult 的冗余内容 | 保留原结构，收紧后续输出量 |
| L2 | token 占窗口阈值 | 摘要模型生成结构化历史摘要 | 校验失败保留旧状态，规则裁剪或结束为部分结果 |

各层独立接口及触发策略，bootstrap 注入阈值。L2 不能创造事实。runId、stepId、toolCallId、evidenceId、风险/确认/动作事实、缺失证据和未决问题必须保留。压缩采用版本化投影视图，原始审计历史不被覆盖。

压缩后校验工具调用配对及引用可回查。待执行调用在持久化状态中显式标记，不能为补齐配对伪造成功结果。

## 记忆

| 类型 | 内容 | V1 |
|---|---|---|
| Working | 当前 Run 结构化状态 | Checkpoint 支持 |
| Episodic | 历史报告、证据引用、结果质量 | 保存与有界召回 |
| Semantic | 拓扑、指标、阈值、Runbook | 受控 Profile/知识输入 |
| Procedural | 审核后的经验模板 | 仅保留候选接口，不启用自动晋级 |

MemoryFacade 是门面，内部拆召回、案例存取、语义检索和候选管理。先按 Profile、服务、时间、故障类型和数据来源过滤，再文本排序；V1 可采用 BM25/中文 bigram，实现可替换。只注入有界 MemoryHints，并保留来源和时间。

模拟案例标注 environment=simulation、eligibleForPromotion=false。不能把评测答案或模拟根因标签注入记忆供同一验收任务读取。LLM 只能提出 observation；人工 approved 且通过质量检查后才允许未来正式经验使用。

## 存储与恢复

SQLite WAL 保存 runs、消息、调用尝试、事件、报告、证据元数据、定时任务、记忆与 Checkpoint。采用事务迁移和 schemaVersion；核心依赖 Store 接口。原始证据通过 BlobStore/文件适配器保存，EvidenceStore 提供统一回查。

证据提交：写 pending 元数据 → 临时原文写入并校验哈希 → 原子改名 → 事务标记 committed。只有 committed 引用可进入报告。启动时回收或修复 pending，处理孤立文件；文件改名与 SQLite 并非跨资源原子事务。

Checkpoint 保存父子关系、消息/上下文版本、待调用、授权、中断、执行事实、剩余预算、纠错链、压缩状态、工具快照版本和截止时间。恢复不重置时间和次数。保存完整批次进度，避免仅恢复一个 pending 调用而丢失其他分支。

V1 单进程持久化优先，运行恢复用版本校验/租约防重复；不宣称已有跨 Worker 分布式事务。后续更换数据库必须实现同一 Store 契约及恢复测试。

## 当前实现

当前内存 Memory、Checkpoint、EvidenceStore 和规则压缩器仅是骨架。SQLite、证据提交协议、结构化 L2、检索及恢复测试是目标设计。
