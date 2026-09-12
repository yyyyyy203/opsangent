# Hooks 生命周期与中断语义实施计划

> **执行约束：** 按任务逐项实施；每项先补确定性测试，再写实现；不在本增量引入 Loop Detection、Context Compression 或真实写动作。

## 目标

按照 `docs/superpowers/specs/2026-09-11-agent-runtime-governance-and-context-compression-design.md` 的增量 3，建立控制型 Hook 与生命周期观察者的清晰边界：控制 Hook 可以短路执行，观察者必须收到最终生命周期事实；effects 由上层接收并参与状态提交，观察者失败不能伪造工具执行状态。

## 任务 1：公共 Hook / 生命周期契约 ✅

- 新增 `src/contracts/hooks.ts`，定义 `ControlHook`、`ToolLifecycleFact`、`AuditFact`、`CheckpointIntent`、`DiagnosisSignal`、`GovernanceEffect` 和 `ToolLifecycleObserver`。
- lifecycle fact 仅允许稳定身份、风险摘要、结果状态、错误码和证据 ID，不携带原始输入、日志或完整 ToolResponse。
- 从 `src/contracts/index.ts` 导出契约；不修改既有 V1/V2 事件字段。
- 测试契约工厂/类型边界和结构化脱敏约束。

## 任务 2：控制 Hook 执行器与 PolicyDeny ✅

- 新增 `src/hooks/control-hook-executor.ts`，固定按 `EvidenceBudgetHook -> PolicyDenyHook -> RiskActionHook` 顺序执行，首个 interrupt/abort 短路。
- 将现有预算与风险 Hook 以结构兼容方式接入控制通道，旧 `ToolHook`/`HookExecutor` 保留给兼容扩展 Hook 和 after hook。
- 新增 `src/hooks/policy-deny-hook.ts`，把 deny 映射为稳定 `POLICY_DENIED` 错误；Pipeline 为该结果发布既有 `TOOL_CALL_REJECTED`，不引入破坏性事件变更。
- 控制 Hook 的 `modifiedInput` 返回后，Pipeline 重新执行 schema/semantic 校验并重新计算 digest；校验失败 fail-closed。

## 任务 3：生命周期观察者与默认观察者 ✅

- 新增 `src/hooks/lifecycle-observer-executor.ts`，按注册顺序调用所有观察者，单个观察者失败隔离并返回失败 ID。
- 新增 `AuditHook`、`CheckpointHook`、`DiagnosisMemoryHook`，分别只生成脱敏审计事实、CheckpointIntent 和 observation 级结构化记忆信号；不得直接写 Store、执行外部动作或自动晋级经验。
- `ToolExecutionPipeline` 对未知工具、校验失败、控制中断、外部执行等待、成功、失败、abort 和已执行跳过均构造最终 fact，并保证 observer 仍被调用。

## 任务 4：effects 传递与持久化边界 ✅

- `ExecutionOutcome` 增加只读 effects/observerFailures；`ToolBatchExecutor` 以 outcome 回调把 effects 交给 Harness。
- Harness 将 checkpoint intent 转换为当前状态的单次持久化意图，并在已有 DurableTransitionUnitOfWork 边界内提交；不让观察者直接改变 revision。
- 在不扩大 V2 公共事件的前提下，审计继续由既有 `AuditProjectorV2` 权威记录，memory signal 仅通过注入 sink 暴露给后续 Memory 增量。
- 处理“工具已返回但 effects/状态提交失败”：沿用 uncertain 语义，禁止自动重放。

## 任务 5：HookRegistry 与恢复 fail-closed ✅

- 新增 `src/hooks/hook-registry.ts`，只登记已知静态 Hook ID，提供存在性/有效期校验，不保存闭包或任意 `handleResume`。
- Harness 恢复确认/外部执行前校验 `hookId`、过期时间、toolCallId 和当前 input digest；未知或不一致时生成模型可见终态 ToolResult 并保持安全状态。
- 保持确认、拒绝、过期和外部结果仍由现有恢复服务和 Harness 状态机负责。

## 任务 6：集成测试、文档与门禁 ✅

- 覆盖控制 Hook 短路、modifiedInput 重新校验、观察者必达、观察者失败隔离、PolicyDeny 的稳定结果、恢复 fail-closed 和 durable commit 顺序。
- 更新 Spec 的增量状态和验证记录。
- 已顺序执行 `pnpm lint`、`pnpm typecheck`、`pnpm exec vitest run --reporter=dot`、`pnpm build`、`git diff --check`；无代码失败，真实 Prometheus 环境测试按既有约定跳过。
- 提交消息：`feat: implement lifecycle-aware hooks`。

## 非目标

- 不实现 Loop Detection、L0/L1/L2 压缩、MemoryFacade 持久化、真实写动作或新的 V2 EventType。
- 不删除/改名现有 `ToolHook`、`HookExecutor`、V1 EventType 或已发布消息字段。
