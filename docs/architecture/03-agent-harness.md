> **DEPRECATED**：本文保留早期 Harness 目标与历史边界；其中“当前状态”已被 [实现进度](../implementation-status.md) 和 [AgentHarness AsyncGenerator 改造设计](../superpowers/specs/2026-09-09-agent-harness-async-generator-design.md) 取代。当前事件/流式契约以 [Event 与 Message V2 协议](./15-event-message-v2.md) 和源码为准。

# Agent Harness 与运行状态机

## 唯一循环实现

主 Agent 与 Subagent 复用同一权威 Harness 实现。每个实例拥有独立上下文、工具范围、预算和 Checkpoint，主 Agent 负责跨来源关联，子 Agent 负责本来源调查。

```text
Abort check → 加载状态和预算 → Pre-reasoning 上下文治理
→ Reasoning → 模型输出校验 → Acting batch → Loop detection
→ Awaiting/HITL → Checkpoint → Exit decision
```

Pre-reasoning 完成相关记忆召回、证据计划对齐、压缩和 Renderer 构建。模型产生完整 ToolCall 后才能调度；流式参数尚未收齐时不能执行。

## 阶段与退出

保留 triage、evidence_collection、hypothesis、risk_gate、action、verification、postmortem 阶段。V1 只读流程对 action 记录 skipped，verification 验证证据及结论一致性，不伪造动作效果。

阶段变化必须显式记录。无 ToolCall 只是模型停止请求工具的信号，最终报告还必须通过 Schema、证据引用和数值一致性校验。

RunStatus 表示执行生命周期；诊断结果另设 complete、partial、inconclusive，不能把 INCONCLUSIVE 直接加入现有 RunStatus 并改变旧字段语义。正常结束但证据不足的任务可以是 completed + inconclusive；框架不可恢复错误为 failed。

## 调度与上下文

模型可在同一步输出多个 Subagent 调用。仅声明并发安全且只读的调用并行，使用 allSettled 隔离错误，按原始调用顺序汇总结果。并发上限受总预算限制；写工具串行；查询与动作混批时动作返回标准 skipped，待重新推理。

每个调用必须对应结果，包括闸门拒绝、超时、取消和跳过。保存成功兄弟调用的结果，纠错时不重放整批。工具流式进度与最终 ToolResponse 分开，只有最终结果作为完整工具结果进入上下文。

## 预算与中断

Run 默认硬截止 120 秒、最多 20 次工具调用；Subagent 默认 30 秒、最多 8 次调用，实际额度由父级剩余额度分配。父截止、用户取消与子截止共同传播。不能让三个子 Agent 各自领取不受父预算限制的 8 次额度。

重复工具/参数/错误指纹触发 WARN、HARD、FORCE_BREAK。参数纠错预算由 Harness 管理，子工具不得调用模型形成隐藏循环。

暂停先持久化可序列化中断和待执行调用，再返回 paused/awaiting_confirmation。恢复检查状态版本和截止时间，只处理未完成步骤；不重放已完成兄弟分支。运行租约或版本条件更新防止同一 Run 被两个执行器同时恢复。

## 当前状态

已有 reply/replyStream、基础执行和恢复骨架。循环检测、完整状态机、父子预算、持久化恢复和最终报告校验仍属于待实施目标。
