# 公共契约与工程约束

## 稳定边界

contracts 集中公共类型，禁止依赖实现。发布后的事件、消息块、ToolResponse、exports 和持久化 Schema 不得破坏性修改。可选字段扩展需默认行为；必需字段或语义变更引入版本、兼容读取和迁移测试。

现有 Tool.kind 是 evidence/action/utility；MCP/Skill/Subagent 是实现来源，不混入 kind 破坏风险分类。来源信息可以独立元数据表达。

## 待实施的兼容性决策

| 项目 | 设计处理 |
|---|---|
| 非法 JSON | 增加 RawToolCall 边界，保留规范化 ToolCall.input |
| 错误响应 | 使用现有 ToolExecutionResult.error / ToolResponse blocks，不用示例 ok 替代外壳 |
| partial/inconclusive | 独立 DiagnosisOutcome，不改变已有 RunStatus 意义 |
| 四道闸门 | 新增稳定错误码及验证元数据，兼容旧错误读取 |
| 父子运行与重试 | 增加关联、计数和版本字段，迁移 Checkpoint |
| 阶段变化 | 计划增加 STAGE_CHANGED，先更新事件契约和测试 |

事件基线包含 RUN_STARTED、STEP_STARTED、REASONING_STARTED、TEXT_DELTA、TOOL_CALL_CREATED、TOOL_STARTED、TOOL_RESULT、EVIDENCE_COLLECTED、REQUIRE_CONFIRM、CONTEXT_COMPRESSED、RUN_PAUSED、RUN_FINISHED、RUN_FAILED。现有扩展事件先盘点，不能以本列表为理由删除。每条事件含 runId/时间戳，步骤事件含 stepId；事件 ID/序列号支持重放去重。

## 报告契约

结构化报告包含 outcome、summary、trigger、profileVersion、window、observedMetrics、findings、rootCauseCandidates、evidenceIds、missingEvidence、recommendations、limitations 和执行统计。字段名为目标设计，实施时进行 JSON Schema 固化。

数值、阈值、趋势、影响面和风险等级由处理器计算；根因候选由 LLM 关联证据，不能把未经校准的模型置信度当概率。口语化摘要基于已验证结构化报告生成；若数字或引用不一致，采用确定性模板回退并记录渲染失败。

## 工程实践

阅读 AGENTS.md、相关文档和公开接口，先用 rg 定位并检查 Git 状态。采用严格类型和稳定错误码；时间、ID、随机数、外部调用可注入；无 Run 级全局状态，不用 process.cwd 隐式定位业务路径。

修改核心机制执行 lint、typecheck、test、build；不把旧 dist 或过去通过的测试当当前证明。纯文档变更检查链接、内容完整性和相互一致性即可。

## 状态与缺口

2026-09-06 读取确认：仓库已有 Harness、Tool/适配器、Guard/Hook、内存 Store、规则压缩和 LangSmith 骨架；Toolkit 是 register/get/list 的 Map。未发现 docs 以外的完整生产设计实现。

待实施项包括：生产模型接入、Registry 快照与 Manifest、MCP 连接、四闸门和纠错、Subagent 自治循环组装、SQLite/证据提交、上下文/记忆完善、API/Web/模拟器、定时告警、可靠性和评测。

本轮未重新运行项目测试，未修改运行源码。仓库当前无 Git 元数据，文档没有 commit。实施前另行建立版本管理，并核验 Node、pnpm 和锁定依赖的兼容组合。
