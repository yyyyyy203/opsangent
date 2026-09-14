# 来源 Subagent 设计规格

日期：2026-09-14
状态：设计基线，待实施；本文不代表代码已经完成。
适用分支：codex/event-message-v2

## 1. 背景与问题

当前仓库已经具备统一 Tool 契约、AgentHarness、ToolBatchExecutor、日志证据
Tools、V2 Subagent 生命周期事件和一个通用的 Subagent ToolAdapter。现有
Adapter 可以把委托函数包装成 Tool，也能记录基础重试事件，但它还不是
真正的来源 Subagent：

- 没有为来源创建独立的 AgentHarness 运行上下文；
- 没有把父级 Run 的截止时间、工具调用预算和数据权限传入子 Run；
- 日志 Tools 仍可以作为普通 Tool 注册，尚未由 logs_subagent 统一编排；
- 没有稳定的子 Run 恢复身份，进程重启后无法可靠地续接未完成取证；
- 没有结构化、可回查、可验证的来源诊断结果契约。

本规格只解决第一个来源的完整闭环：logs_subagent。Metrics 和 Trace 使用
同一组通用端口，在后续增量中分别接入；本规格不把尚未验证的真实 ELK
端点或凭据写入实现。

## 2. 目标与不变量

完成后，主 Agent 只能看到一个 logs_subagent Tool。主 Agent 通过标准
ToolCall 调用它，子 Agent 在自己的上下文和预算内使用受限的日志证据
Tools，多轮取证后提交结构化来源报告。对主 Agent 来说，子 Agent 与普通
Tool 一样返回 ToolResponse；对运行时、审计和 LangSmith 来说，父子 Run
关系、重试、部分成功和证据引用都可追踪。

必须满足：

1. Subagent 是 Tool 的一种，主循环只有 AgentHarness 一套，禁止新增第二套
   ReAct 循环。
2. 子 Agent 只拥有当前来源允许的只读 Tools，不拥有 Bash、动作 Tool、
   外部执行 Tool 或其他 Subagent。
3. 父级 Run 的 profile、deadline、剩余预算和 signal 是权限与资源上限；
   模型输入中的同名字段不是授权来源。
4. 日志原文、完整查询 DSL、Blob storage key、内部路径、凭据和 Cookie
   不进入主 ToolResponse、V2 公共事件、SSE 或 LangSmith。
5. 证据引用只在 Manifest 已经 committed 或 partial 后返回；失败和中断
   不伪造 evidenceId。
6. 重试只恢复当前子 Agent 的未完成工作，不重复已确认的动作或无条件重放
   已提交的 capture。
7. 状态、失败分类、覆盖率、证据归属和调用计数由代码计算；LLM 只能提出
   摘要、观测和推断候选。

## 3. 范围与非目标

### 3.1 本增量范围

- 通用 SourceSubagentRunner 和 SourceSubagent Tool 适配边界；
- logs_subagent 的严格输入和结构化输出；
- 使用现有 AgentHarness 创建独立 child Run；
- child Toolkit 只注册 logs.capture、logs.search_evidence、
  logs.aggregate_evidence、logs.read_evidence_slice 以及内部 report Tool；
- 父级预算、截止时间、取消、checkpoint 恢复和网络尝试账本传递；
- 失败重试、partial/unavailable 降级和生命周期事件；
- 父子事件、审计和 LangSmith 关联；
- 注入式日志页源和 SQLite/local Blob 测试验收。

### 3.2 非目标

- 不接入真实 Elasticsearch 地址、账号、Token、索引或公司 MCP；
- 不实现 Tempo、Trace Subagent 或 Metrics Subagent 的具体运行器；
- 不开放 Bash、任意 HTTP、任意 SQL、写操作、熔断/降级动作或外部执行；
- 不实现新的前端页面；
- 不改变既有 ToolResponse 外壳、V1 事件名称或已发布 V2 事件语义；
- 不把跨来源根因排序交给子 Agent；
- 不把长期记忆全部注入子 Agent，也不允许子 Agent 晋级正式经验。

## 4. 公开命名与兼容

主 Agent 的 canonical Tool 名称固定为：

- metrics_subagent
- logs_subagent
- traces_subagent

现有 adaptSubagentTool 的默认命名 subagent.<name> 保持兼容。来源适配器
使用显式 publicToolName 生成 canonical 名称，不修改旧默认命名规则。事件
中的 subagentType 使用 logs、metrics、traces 这类来源类型，不使用内部
实现类名。

底层 logs.* Tools 可以继续被单独测试，但在生产 Inspection Runtime 中
不注册到 parent Toolkit，只注册到 child Toolkit。这样主 Agent 无法绕过
logs_subagent 的预算、报告和来源边界。

## 5. 分层与依赖

~~~text
contracts
   ↑
agent / tool / context-compressor
   ↑
application source-subagent runner
   ↑
bootstrap source-subagent composition
   ↑
infrastructure log page source / Blob / Manifest / MCP adapter
~~~

AgentHarness、SourceSubagentRunner 和 ToolAdapter 只能依赖 contracts 以及
注入端口。它们不能 import better-sqlite3、文件系统、zlib、Elasticsearch
SDK、MCP SDK 或具体模型 SDK。所有 child Agent、child Toolkit、日志 Tools
和持久化实现都在 bootstrap 组装。

## 6. 公共契约

### 6.1 来源结果

~~~ts
export type SourceSubagentType = 'metrics' | 'logs' | 'traces';

export type SourceSubagentStatus = 'complete' | 'partial' | 'unavailable';

export type SourceFindingKind = 'observation' | 'inference';

export interface SourceFinding {
  kind: SourceFindingKind;
  statement: string;
  evidenceIds: string[];
}

export interface SourceSubagentRequest {
  profileId: string;
  service: string;
  start: string;
  end: string;
  question: string;
  evidenceIds: string[];
}

export interface SourceSubagentResult {
  source: SourceSubagentType;
  status: SourceSubagentStatus;
  summary: string;
  findings: SourceFinding[];
  evidenceIds: string[];
  businessTraceIds: string[];
  missingEvidence: string[];
  coverage: number;
  toolCallsUsed: number;
  durationMs: number;
}
~~~

字符串、数组和序列化结果都必须有界。默认沿用现有 16 KiB 模型摘要和
20 条样本限制。findings 的 evidenceIds 必须是 child Run 实际观察到、
当前 profile/run 可见的引用；未知引用使报告无效。observation 必须能
回查证据，inference 必须明确标注为推断。

coverage 根据 capture Manifest 状态、分页完整性、预算和缺失项由代码计算，
不采信模型自行填写的覆盖率。summary 可以是自然语言，但只能来自脱敏、
有界 child 结果。

### 6.2 执行上下文

~~~ts
export interface SourceSubagentExecution {
  parentRunId: string;
  parentToolCallId: string;
  parentStepId: string;
  childRunId: string;
  profileId: string;
  profileRevision?: string;
  sessionId?: string;
  replyId?: string;
  streamId?: string;
  deadline?: number;
  signal: AbortSignal;
  networkAttemptBudget?: { remaining: number };
}

export interface SourceSubagentRunner {
  run(
    request: SourceSubagentRequest,
    execution: SourceSubagentExecution,
  ): AsyncGenerator<ToolResponseChunk, SourceSubagentResult>;
}
~~~

ToolCallOptions 增加 profileId 和 profileRevision 两个可选字段，由
ToolExecutionPipeline 从 AgentContext 注入。旧 Tool 不读取它们，因此保持
向后兼容。现有 ToolCallOptions.toolCallId 就是
SourceSubagentExecution.parentToolCallId；SourceSubagentAdapter 缺少
profileId 或 toolCallId 时必须 fail closed。childRunId 在适配器内部生成，
不能要求模型提供。

childRunId 由注入的稳定身份函数生成，输入至少包含 parentRunId、
parentToolCallId 和 source。相同父 ToolCall 在重试或进程恢复时必须得到
同一个 childRunId，不能依赖每次变化的随机 ID。

### 6.3 来源适配器

~~~ts
export interface SourceSubagentDescriptor {
  publicToolName: string;
  subagentType: SourceSubagentType;
  description: string;
  inputSchema: Tool['inputSchema'];
  runner: SourceSubagentRunner;
  childRunId: (execution: Omit<SourceSubagentExecution, 'childRunId'>) => string;
  maxAttempts?: number;
  retry?: SourceSubagentRetryPolicy;
  lifecycle?: SubagentLifecyclePorts;
}

export interface SourceSubagentRetryPolicy {
  maxAttempts: number;
  shouldRetry: (error: unknown) => boolean;
  delayMs: (attempt: number) => number;
  sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface SubagentLifecyclePorts {
  factory: EventFactoryV2Like;
  publisher: EventPublisherV2Like;
  ids: IdGenerator;
  correlationId: (runId: string) => string;
}
~~~

publicToolName 只允许与 subagentType 对应的 canonical 名称，例如 logs 对应
logs_subagent。适配器生成的 Tool 必须具有 kind=evidence、source=subagent、
recoveryPolicy=verify_before_retry 和 isConcurrencySafe=false。

call 内部先完成输入及宿主权限校验，再创建稳定 childRunId，调用 runner
的 AsyncGenerator，最后压平为一个有界 JSON ToolResponse，并保留
sourceResult.evidenceIds。unavailable 可以设置 isError=true；partial
仍是模型可见的正常证据结果，不能静默转换为空字符串。

重试过程中的 child 进度不能先暴露给父模型再重放。生命周期事件可以实时
记录；父模型可见进度必须在成功尝试后按顺序补发，或本次尝试完全不发。

### 6.4 application 层的 child 工厂和报告 Collector

child Agent 的创建是 application 层端口，不放进 contracts，避免稳定契约
依赖 AgentHarness 的具体文件：

~~~ts
export interface SourceChildAgent {
  replyStream(
    options: {
      runId: string;
      profileId: string;
      message: string;
      sessionId?: string;
      replyId?: string;
      signal: AbortSignal;
      maxToolCalls: number;
      maxDurationMs: number;
    },
  ): AsyncGenerator<AgentEvent, DiagnosisRunResult>;
  resumeStream(
    runId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, DiagnosisRunResult>;
}

export interface SourceChildAgentFactory {
  create(input: {
    childRunId: string;
    source: SourceSubagentType;
    tools: readonly Tool[];
    maxToolCalls: number;
    maxDurationMs: number;
  }): SourceChildAgent;
}

export interface SourceReportCollector {
  observeToolResult(toolName: string, response: ToolResponse): void;
  acceptReport(candidate: {
    summary: string;
    findings: SourceFinding[];
    businessTraceIds: string[];
    missingEvidence: string[];
  }): void;
  finalize(input: {
    source: SourceSubagentType;
    startedAt: number;
    finishedAt: number;
    parentRunId: string;
    childRunId: string;
  }): SourceSubagentResult;
}
~~~

SourceChildAgentFactory 负责用现有 AgentHarness 组装 child 的 Toolkit、模型、
Checkpoint、Compressor 和事件依赖；SourceSubagentRunner 只依赖这个最小
端口。Collector 只接收已脱敏的 ToolResponse 和 report 候选，不能读取
Blob 文件或绕过 Manifest。

## 7. logs_subagent 输入和 child Toolkit

### 7.1 输入 Schema

输入是严格对象，只允许：

~~~ts
{
  profileId: string,
  service: string,
  start: string,
  end: string,
  question: string,
  evidenceIds?: string[]
}
~~~

profileId 必须等于宿主注入的 profileId；不一致返回结构化 POLICY_DENIED。
start/end 必须可解析且 start < end。evidenceIds 只能作为当前父 Run 已知
的调查线索，不授予额外访问范围。

父级 evidenceIds 必须先通过 EvidenceManifestStore.getVisible 并验证
manifest.runId 等于 parentRunId；child 不能因模型提交一个 evidenceId 就
取得跨 Run 访问权限。child report 可以引用已验证的父级证据和本 child
新产生的证据，但 Collector 必须分别验证两类引用的归属。

模型不能提交 index、queryDsl、pitId、storageKey、path、credentials、
headers、token 或任意 URL。分页游标只由 child Tool 内部产生和消费。

### 7.2 child Toolkit 和 report Tool

child Toolkit 固定包含：

1. logs.capture
2. logs.search_evidence
3. logs.aggregate_evidence
4. logs.read_evidence_slice
5. source_report（只在 child Toolkit 中存在）

source_report 只接受：

~~~ts
{
  summary: string,
  findings: Array<{
    kind: 'observation' | 'inference',
    statement: string,
    evidenceIds: string[]
  }>,
  businessTraceIds: string[],
  missingEvidence: string[]
}
~~~

source_report 不接受 status、coverage、toolCallsUsed、durationMs、profileId
或权限字段。它把候选交给 Collector；运行器结合实际 ToolResult、Manifest
状态和预算计算其余字段。

child Toolkit 不包含 logs_subagent、任何其他 *_subagent、Bash、Skill、
action、外部执行或未列出的 MCP Tool，也不包含直接读取 SQLite、Blob 或
进程环境的函数。

## 8. child Harness 执行流程

SourceSubagentRunner 使用注入的 SourceChildAgentFactory 创建 AgentHarness 实例，
不复制主循环：

~~~text
父 Tool Pipeline
  -> 输入 Schema / profile / scope 校验
  -> 创建稳定 childRunId
  -> 计算 child deadline 和剩余预算
  -> 创建 child AgentContext + child Toolkit 快照
  -> child AgentHarness.replyStream()
       -> triage
       -> evidence_collection
       -> hypothesis
       -> source_report
       -> child 完成或 partial
  -> Collector 校验报告和证据引用
  -> 代码计算状态、coverage、耗时和缺失证据
  -> 返回有界 SourceSubagentResult
~~~

child 初始消息由固定 Renderer 生成，包含调查问题、服务、时间窗口、
profileId 和已有 evidenceId 引用，不拼接完整日志原文。字段稳定排序，
动态内容放在固定前缀之后。

child 的每一次 ToolCall 都必须经过与 parent 相同的
ToolAdmission -> ToolBatchExecutor -> ToolExecutionPipeline 顺序，包含
存在性、JSON、Schema、语义四道闸门、Guard、Hooks、幂等和结果边界。Runner
不得直接调用 Tool.call 来绕过这些步骤。source_report 也通过同一 Pipeline
执行，只是它不访问外部数据，且只负责把严格 Schema 的候选报告交给
Collector。

source_report 成功且引用有效时，按 Manifest 和来源完整性确定为 complete
或 partial。capture partial 必须保留证据引用并记录预算/分页缺口。没有
可用证据时只能返回 unavailable。报告缺失、Schema 错误或引用越权时，
不得生成高置信结论。

## 9. 父子预算、截止时间和并发

child 预算是父级剩余资源的子集：

~~~text
child.maxToolCalls = min(8, parent.remainingToolCalls)
child.deadline = min(parent.deadline, childStartedAt + 30s)
child.networkAttemptBudget = parent.networkAttemptBudget 共享引用
~~~

父级没有剩余 Tool 或网络尝试额度时，child 创建前返回结构化预算失败，
不调用模型和来源端点。child 每个模型 ToolCall 都计入父级总预算，重试
不能重置额度。

logs_subagent 默认 isConcurrencySafe=false。child 内部的只读检索可按
现有 BatchExecutor 规则并发，capture 必须串行。同一父批次出现来源调查
和动作时，先完成证据调查，动作 deferred，主 Agent 基于新证据重新推理。

## 10. 失败、重试和四轮降级

### 10.1 错误分类

| 类别 | 示例 | 处理 |
|---|---|---|
| abort | ABORTED、用户取消、父 deadline | 立即结束，不重试 |
| policy | POLICY_DENIED、越权、profile 不匹配 | 立即结束，不换工具 |
| terminal | BUDGET_EXCEEDED、INVALID_INPUT、认证失败 | 不重试 |
| retryable | MCP_NETWORK_ERROR、MCP_TIMEOUT、MCP_RATE_LIMITED、MCP_SERVER_ERROR、TIMEOUT | 最多按配置重试 |
| protocol | MCP_PROTOCOL_ERROR、报告 Schema 错误 | 不自动重试，记录失败 |

未知错误默认按 terminal 处理，不依据错误文案猜测。

### 10.2 重试规则

- 默认 maxAttempts=2，硬上限为 3；
- 没有父模型可见结果前才允许重试；
- 重试沿用 parentToolCallId、childRunId、profile snapshot、deadline 和
  共享 networkAttemptBudget；
- child 已提交 capture 后，先读取 child checkpoint 和 Manifest，不得
  无条件重复 capture；
- 已有 committed/partial evidence 时优先恢复未完成步骤，无法恢复则返回
  partial，不丢弃证据；
- 每次重试发布 SUBAGENT_RETRY_SCHEDULED，等待受父 deadline 限制；
- signal 在等待期触发时立即结束并传播 ABORTED；
- 重试耗尽后只发布一次最终失败或 partial 完成事件。

### 10.3 四轮降级

1. Retry：重试可恢复的临时错误；
2. Resume/Verify：加载 child checkpoint 和 Manifest，避免重复写入；
3. Reduced scope：有部分证据时只返回 partial，列明缺口；
4. Unavailable：无证据时返回 unavailable，禁止编造结论。

Reduced scope 只能缩小查询或分析范围，不能绕过 Profile、Guard、Hook、
权限和来源健康检查，也不能静默切换数据源。

## 11. 生命周期、事件和可观测性

复用既有 V2 Subagent 事件，不新增同义事件：

~~~text
SUBAGENT_STARTED
  -> SUBAGENT_PROGRESS*
  -> SUBAGENT_RETRY_SCHEDULED*
  -> SUBAGENT_FALLBACK_ACTIVATED?
  -> SUBAGENT_COMPLETED | SUBAGENT_FAILED
~~~

现有事件的状态值与 SourceSubagentResult 做如下确定性映射：

| SourceSubagentResult.status | SUBAGENT_COMPLETED status | 终态事件 |
|---|---|---|
| complete | completed | SUBAGENT_COMPLETED |
| partial | partial | SUBAGENT_COMPLETED |
| unavailable | 不发布 completed | SUBAGENT_FAILED，error.code=UNAVAILABLE |

事件必须包含 childRunId、parentRunId、correlationId，以及适用的 sessionId、
replyId、streamId、stepId 和 attemptId。payload 只包含来源、阶段、状态、
错误码、evidenceId、coverage、预算和限制摘要。

事件、SSE、Audit 和 LangSmith 禁止包含 raw log、完整 exception、查询 DSL、
Blob key、文件路径、密钥、Cookie、Authorization header、完整 ToolResponse
或 child Message。

LangSmith 父 Tool Span 命名为 tool.logs_subagent，child Span 命名为
subagent.logs，child 的 parentSpanKey 优先指向同一 parentRunId 和
toolCallId 对应的父 Tool Span。实现通过 Projector 已有的 toolKeys 映射
解析 tool:<parentRunId>:<toolCallId>:<toolAttemptId>；如果历史事件缺少
toolCallId 或对应 TOOL_STARTED 尚未到达，兼容回退为 run:<parentRunId>，
不能因为远程 span 关系缺失而阻塞本地执行。SourceSubagentAdapter 发布
生命周期事件时必须把 ToolCallOptions.toolCallId 写入事件信封。

attempt 作为同一 child Run 的属性或嵌套 attempt 记录。观测失败不能阻止
本地结果、Checkpoint 或证据提交。

## 12. Checkpoint、幂等和进程恢复

child 与 parent 使用相同的 CheckpointStore 接口，但 childRunId、消息和
pending ToolCall 独立隔离。parent Checkpoint 保存父 ToolCall、执行状态和
evidenceIds；child Checkpoint 保存未完成步骤和 source_report。

恢复流程：

1. parent Harness 按现有 pending ToolCall 恢复 logs_subagent；
2. 适配器用相同 parentRunId、parentToolCallId 和 source 得到 childRunId；
3. runner 加载 child Checkpoint；
4. child 已完成且有有效 source_report 时，先验证证据归属再返回结果；
5. child 未完成时调用 childAgent.resumeStream(childRunId)，不重建成功的
   capture；
6. child Checkpoint 缺失但 parent 有 evidenceId 时进入 Verify/Reduced
   scope，不能无条件重放；
7. 外部 capture 成功而本地落库失败时，通过 Manifest 和 captureKey 验证
   后再决定恢复。

所有恢复路径都必须再次经过 Tool Admission、Guard、Hook 和来源归属检查。

## 13. 安全和数据边界

- profileId、profileRevision、scope 和 allowedToolNames 由宿主注入；
- child Registry 创建后冻结，MCP 重连不得静默增加 Schema；
- logs Tools 只通过 EvidenceReader 读取已提交/partial Manifest；
- SourceSubagentResult 返回 parent 前执行统一脱敏和字节上限校验；
- evidenceIds 必须验证当前 Run/profile 所有权；
- businessTraceIds 只能来自规范化日志字段，并执行长度、数量和格式限制；
- profile 不匹配、Tool 不在 allowlist、报告引用越权、Manifest 不可见或
  摘要超限都 fail closed；
- 第一阶段没有真实 action，SourceSubagent 不得调用降级、熔断或发布 Tool。

## 14. 测试与验收

实施计划必须先写失败测试，再写生产代码。至少覆盖：

1. canonical Tool 名称、source、recoveryPolicy 和旧 Adapter 兼容；
2. 未知字段、非法时间、空服务、profile 不匹配和越权 evidenceId；
3. 结果 Schema、finding 引用、摘要字节上限和 report Tool 禁止字段；
4. parent Toolkit 不含 child-only Tools，child Toolkit 不含 Subagent/Bash/action；
5. parent ToolCall 创建稳定 childRunId，child 通过 Harness 完成多轮 capture
   和 source_report；
6. child 事件的父子关联、顺序、审计和 LangSmith span 关系；
7. 未注册 Tool 被拒绝且不扩大 child 权限；
8. timeout 重试和 RETRY_SCHEDULED，成功后只返回一份最终结果；
9. capture 已提交而 aggregate 失败时恢复/验证证据，不重复 capture；
10. retryable 耗尽后有证据返回 partial，无证据返回 unavailable；
11. ABORTED、POLICY_DENIED、INVALID_INPUT、BUDGET_EXCEEDED 不重试；
12. child deadline 不超过 parent，网络尝试消耗共享账本，父预算为零时不启动；
13. SQLite 重启后通过稳定 childRunId resume 未完成调查；
14. Public SSE、Audit、LangSmith 不含 raw、storageKey、路径或完整输入；
15. LangSmith 失败不影响本地结果，父/子 iterator 关闭后状态可恢复；
16. 并行 parent Tool 失败隔离，child partial 不污染其他 ToolResult。

质量门禁：

~~~text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
~~~

没有真实 ELK/Tempo 或线上模型配置时，相关测试必须标记 skipped，不得统计
为生产验收通过。

## 15. 实施文件边界

最终实施计划应优先使用以下文件边界；如需扩大公共契约，必须先更新本
规格并重新审阅：

| 层 | 文件 | 职责 |
|---|---|---|
| contracts | src/contracts/source-subagent.ts、src/contracts/tool.ts、src/contracts/index.ts | 结果、请求、执行上下文、重试端口和可选 ToolCallOptions 字段 |
| tool | src/tool/adapters/source-subagent-tool-adapter.ts | canonical Tool、生命周期、重试和结果压平 |
| application | src/application/source-subagent-runner.ts、src/application/source-report-collector.ts | child Harness、预算、恢复、报告校验和状态计算 |
| bootstrap | src/bootstrap/logs-subagent.ts、src/bootstrap/inspection-runtime.ts、src/application/create-runtime.ts | child Toolkit、日志 Tools、SourceChildAgentFactory 和 parent Registry |
| event | 现有 V2 Subagent 事件映射 | 复用既有事件，不新增同义事件 |
| test | test/source-subagent-contract.test.ts、test/source-subagent-tool.test.ts、test/logs-subagent-runtime.test.ts、test/source-subagent-recovery.test.ts | 契约、适配器、Harness、重试和恢复验收 |
| docs | docs/implementation-status.md、docs/architecture/05-subagents-and-mcp.md、docs/architecture/08-observability.md | 记录已验证实现和真实后端缺口 |

Runner、报告 Collector、canonical Tool Adapter、child Toolkit 组装和基础设施
适配必须可以分别替换和测试，不允许把所有逻辑塞进一个大类。

## 16. 完成定义

只有以下条件全部满足，才能把本增量标记为完成：

- parent 只能通过 logs_subagent 调用日志来源，child-only Tools 未暴露；
- child 确实通过同一个 AgentHarness 执行多轮取证；
- 结构化结果、证据引用、partial/unavailable 和错误分类均有确定性测试；
- 重试不重放已提交证据，恢复可用稳定 childRunId 续接；
- 父子事件、Checkpoint、Public/Audit/LangSmith 边界通过测试；
- lint、typecheck、test、build 和 diff check 全部通过；
- 文档明确区分注入式/本地验收与真实 ELK 生产接入；
- 不得因为 ScriptedModel、模拟页源或本地 Blob 测试通过，就宣称线上
  Elasticsearch 或真实巡检业务已经验收。
