# Guard、Hooks、HITL 与动作安全

## 职责

Guard 根据工具、最终参数、Profile、服务重要性和实时影响面生成确定性 Finding。风险合并采用更严格结果。Hook 根据 Finding、预算和运行状态返回 continue、interrupt、abort。HITL 管理外部确认、拒绝、过期和恢复。

| Hook | 责任 |
|---|---|
| EvidenceBudgetHook | 限制调用量、查询范围、时间和输出大小 |
| RiskActionHook | 白名单及风险策略决定是否请求确认 |
| AuditHook | 记录决策和执行结果；脱敏后可发送观测事件 |
| CheckpointHook | 请求状态落库；持久化事务由 Pipeline/Store 协调 |
| DiagnosisMemoryHook | 合格案例与经验候选写入，不能自动晋级 |

Hook 不负责实现工具，也不包含另一套推理循环。审计和 Checkpoint 不能只依赖可随意关闭的 Hook：关键记录和失败结果的持久化是 Pipeline 强制保证。

## 中断数据

保存 hookId、interruptType、toolCallId、runId、payload、createdAt、expiresAt 和上下文版本。禁止保存闭包或恢复函数；恢复时按注册表解析。

授权绑定具体调用、最终参数指纹、作用域和有效期。模型纠错产生的新调用不能继承旧授权。拒绝或过期必须生成工具结果，供模型重新规划。

## V1 行为

运行组装只注册只读取证能力。Bash、外部端侧执行、真实动作不可用；框架的 continue/interrupt/abort、确认及 Dry Run 行为通过测试验证。模拟器控制是独立管理 API，不作为 Agent 的故障修复工具。

## 后续动作闭环

风险评估 → 人工确认 → 幂等检查 → Dry Run → 执行 → 状态核验 → 审计。降级、熔断、恢复、回滚均需白名单与风险检查。外部动作成功但本地保存失败时记录 uncertain，通过外部状态查询或人工核验收敛，不无条件重放。

高风险动作串行；同批证据查询完成后必须重新推理才可发起动作。工具执行成功后 Post-Hook 失败不意味着外部动作未发生，应保留执行事实并停止自动重试。
