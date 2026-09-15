# Metrics Subagent 设计规格

日期：2026-09-15
状态：待实现；本文是 Metrics Subagent 的正式设计基线
适用分支：codex/event-message-v2
代码核验基线：9c0d069

## 1. 规格关系

本文是 来源 Subagent 设计规格 的 Metrics 专项增量，必须同时遵守：

- docs/superpowers/specs/2026-09-14-source-subagent-design.md
- docs/architecture/15-event-message-v2.md
- 根目录 AGENTS.md

通用 SourceSubagentResult、canonical Tool 命名、父子预算、Checkpoint、四轮降级和
SUBAGENT_* 事件语义继续以来源规格为准。本文只补充 metrics_subagent 的 Profile、
child Toolkit、指标事实、报告收敛和实验验收规则。发生冲突时，本文只能收紧 Metrics
边界，不得放宽通用安全、恢复和公共契约约束。

## 2. 当前代码基线与缺口

代码核验显示，仓库已经具备：

1. src/bootstrap/settlement-evidence-tool.ts 中的 metrics.settlement Tool；
2. 固定 checkout/simulation 查询的 PrometheusSettlementSource；
3. 官方 MCP SDK 服务和 HttpMcpConnection；
4. 失败率、阈值和最小样本的确定性计算；
5. EvidenceRecorder 与内存/SQLite EvidenceStore；
6. 通用 DefaultSourceSubagentRunner、canonical Source Tool Adapter、重试、恢复和
   SourceReportCollector；
7. 已实现的 logs_subagent，可作为来源边界和父子 Harness 的参考实现；
8. normal、settlement_failure、low_sample 三个模拟场景；
9. OpenAI-compatible 模型适配器及本地 HTTP/SSE 验收。

尚缺：

- parent Toolkit 中没有 canonical metrics_subagent；
- metrics.settlement 仍可作为普通父级 Tool 使用，尚未被 child Toolkit 封装；
- DefaultSourceSubagentRunner 的默认提示词写死为“日志取证”，不能直接复用于 Metrics；
- source_report 工厂和稳定 childRunId 帮助函数仍位于 logs_subagent 文件中；
- 指标 ToolResponse 没有统一的 SourceEvidenceObservation 控制视图；
- 通用 Collector 只靠开放 JSON 字段猜测 coverage/state，指标报告缺少确定性事实收敛；
- 指标证据已经持久化，但默认 evidenceId 不是由 Run/ToolCall 稳定派生；
- 没有 Metrics child Harness、三场景、恢复、V2 生命周期和 OpenAI-compatible 的端到端验收；
- 当前查询只能代表实验环境的最新 300 秒快照，不能回答任意历史区间，也不能代表
  group-buy-market 的真实 Prometheus。

因此，本增量不是重写 Prometheus/MCP，而是在既有低层能力之上补齐 Metrics
Subagent 的自治编排与确定性报告边界。

## 3. 目标与不变量

完成后，主 Agent 只看到 metrics_subagent。它通过普通 ToolCall 委托指标调查；
Metrics child 使用同一个 AgentHarness，在受限 Toolkit 内调用 metrics.settlement，
最后调用 source_report。对父级仍返回一个 SourceSubagentResult ToolResponse。

必须满足：

1. 只有一套 AgentHarness 主循环，不为 Metrics 新建第二套 ReAct 状态机。
2. parent Toolkit 不出现 metrics.settlement；child Toolkit 只出现
   metrics.settlement 和 source_report。
3. child 不拥有 logs、traces、Bash、Skill、任意 HTTP、动作、外部执行或其他 Subagent。
4. Prometheus URL、PromQL、selector、阈值、最小样本、窗口规则和环境来自宿主/Profile，
   不由模型输入。
5. failed/total、failureRate、阈值比较、样本充分性、时间窗口和 coverage 全部由代码计算。
6. LLM 只负责决定何时查询、何时提交报告；不能改写确定性指标事实，也不能仅凭指标确认根因。
7. raw Prometheus 响应只进入 EvidenceStore，不进入模型上下文、父 ToolResponse、SSE、
   Audit 或 LangSmith。
8. 低样本是成功取得完整指标证据后的 insufficient_data，不等于 partial 或 unavailable。
9. 重试共享父级 deadline、Tool 预算和网络尝试账本，不重置额度。
10. 恢复沿用稳定 parentToolCallId、childRunId、captureKey 和 evidenceId；不无条件重复取证。
11. 本增量不新增 Event/Message 类型，只复用既有 Tool、Evidence 和 SUBAGENT_* 事件。
12. 所有公开变化只能是向后兼容的可选字段或新导出；现有低层 metrics.settlement 输入和
    首个 JSON 摘要保持兼容。

## 4. 范围与非目标

### 4.1 本增量范围

- 通用 Source Runner 的来源提示词注入；
- 通用 source_report 与稳定来源 childRunId 工厂抽取；
- SourceEvidenceObservation 的有界内部契约；
- metrics.settlement 返回控制视图和稳定证据身份；
- Metrics 专用确定性 ReportCollector；
- createMetricsSubagentTool 及严格输入/宿主范围校验；
- parent/child Toolkit 隔离；
- 三个模拟场景的完整父子 Harness 闭环；
- retry、resume、partial、unavailable、Abort 和预算验收；
- SUBAGENT_*、EVIDENCE_COLLECTED、Audit/LangSmith 脱敏验收；
- 本地 OpenAI-compatible HTTP/SSE 协议验收；
- 现有真实 Prometheus Docker 验收扩展为可选的 Metrics Subagent 路径。

### 4.2 非目标

- 不接入 group-buy-market 的真实 Prometheus 地址、认证或业务指标名；
- 不支持任意 PromQL、任意 selector、任意 URL 或模型生成查询表达式；
- 不支持历史 query_range、趋势比较、基线学习或多窗口同比/环比；
- 不接入 ELK、Tempo、变更平台或真实保护动作；
- 不实现 Agent Web、Simulator Web、Run/Evidence HTTP API；
- 不实现在线模型供应商的强制 CI 验收，不在仓库保存 API Key；
- 不把“本地 OpenAI-compatible 协议已验证”表述成“线上模型效果已验收”；
- 不允许 Metrics Subagent 直接给出 MySQL、Redis、线程池或下游服务根因；
- 不在本增量解决不同 parent ToolCall 之间复用旧指标 evidenceId；第一版不接收非空
  evidenceIds。

## 5. 总体架构

~~~text
Parent AgentHarness
  -> metrics_subagent                         parent 唯一可见
       -> SourceSubagentToolAdapter
            -> DefaultSourceSubagentRunner
                 -> Child AgentHarness
                      -> metrics.settlement    child-only
                           -> readonly MCP
                                -> PrometheusSettlementSource
                           -> EvidenceRecorder / EvidenceStore
                      -> source_report         child-only
                 -> MetricsSourceReportCollector
            -> SourceSubagentResult
       -> 普通 ToolResponse 返回 Parent
~~~

依赖方向：

~~~text
contracts
  ↑
application source runner / collectors
  ↑
bootstrap metrics composition
  ↑
mcp / prometheus / sqlite 等具体实现
~~~

Metrics Collector 只读取已脱敏 ToolResponse，不读取 raw Evidence。Prometheus、MCP、
EvidenceStore 和模型的具体实例仍由 bootstrap/宿主注入。

## 6. Metrics Profile 与输入

### 6.1 实验 Profile

第一版只实现一个显式实验 Profile：

~~~ts
export interface SettlementMetricsProfile {
  profileId: string;
  service: 'checkout';
  environment: 'simulation';
  windowSeconds: 300;
  maxWindowSkewSeconds: 120;
  maxFutureSkewSeconds: 30;
  threshold: 0.05;
  minSamples: 20;
}
~~~

具体常量放在 src/profiles/settlement.ts，不得放进 AgentHarness、ToolAdapter 或提示词。
将来接入 group-buy-market 时替换 Profile 和来源适配器，不修改 Metrics Subagent 的公共
Tool 名称与结果契约。

### 6.2 父级输入 Schema

metrics_subagent 使用来源通用字段，但第一版做更严格的 Metrics 语义校验：

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

规则：

- 严格对象，拒绝未知字段；
- profileId 必须同时等于宿主注入 profileId 和 Metrics Profile.profileId；
- service 必须等于 Profile.service；
- start/end 必须为带时区 ISO-8601，且 start < end；
- 第一版窗口必须正好 300 秒；
- end 不得晚于注入时钟 30 秒，也不得早于注入时钟 120 秒；
- question 非空，UTF-8 最多 2 KiB；
- evidenceIds 可为省略或空数组；非空数组在 child 启动前 fail closed。

最后一条是明确的第一版限制：Metrics child 尚无 metrics.read_evidence Tool，不能把“通过
归属检查但从未读取”的旧证据当成已观察事实。后续若增加有界只读 Tool，再单独开放该字段。

为承载来源专项校验，SourceSubagentDescriptor 新增可选、向后兼容的宿主校验端口：

~~~ts
validateRequest?: (
  request: SourceSubagentRequest,
  execution: Omit<SourceSubagentExecution, 'childRunId'>,
) => void | Promise<void>;
~~~

Adapter 必须先完成通用 Schema/host profile 校验，再调用 validateRequest，最后才创建 child
和访问来源。失败使用 INVALID_INPUT 或 POLICY_DENIED，不调用模型或 MCP。

## 7. Child Toolkit 与工具注册

child Toolkit 固定为：

1. metrics.settlement
2. source_report

metrics.settlement 必须满足：

- name 精确等于 metrics.settlement；
- kind=evidence；
- source=mcp；
- call 已实现；
- 模型输入只包含 service=checkout；
- 不接受 URL、PromQL、阈值、环境、时间戳或认证信息；
- 调用仍走 child 的 ToolAdmission、四道参数闸门、Guard、Hook、BatchExecutor 和 Pipeline。

source_report 继续使用来源通用 Schema。工厂从 logs-subagent.ts 抽到独立
src/bootstrap/source-report-tool.ts，Logs 和 Metrics 都依赖它，二者不得互相 import。

parent 注册方式固定：

~~~ts
createInspectionRuntime({
  sourceSubagentTools: [metricsSubagent],
  allowedToolNames: ['metrics_subagent'],
  // metrics.settlement 不得出现在 tools/sourceSubagentTools
})
~~~

Source Adapter 当前固定 isConcurrencySafe=false。第一版保持串行，因为父子共享可变预算账本；
跨来源并行要等预算预留/原子账本设计完成后另立增量。

## 8. SourceEvidenceObservation 内部契约

通用 Collector 不应再从每种来源的任意 JSON 摘要猜测控制状态。新增一个有界、无 raw 的内部
控制视图：

~~~ts
export interface SourceEvidenceObservation {
  schemaVersion: 1;
  source: SourceSubagentType;
  evidenceId: string;
  state: 'committed' | 'partial';
  coverage: number;
  timeRange?: { start: string; end: string };
  missingEvidence: string[];
}
~~~

metrics.settlement 成功响应保持原有首个 JSON 摘要和 evidence_ref，同时追加：

~~~ts
metadata: {
  sourceEvidence: {
    schemaVersion: 1,
    source: 'metrics',
    evidenceId,
    state: 'committed',
    coverage: 1,
    timeRange: {
      start: new Date(summary.start * 1000).toISOString(),
      end: new Date(summary.end * 1000).toISOString()
    },
    missingEvidence: []
  }
}
~~~

约束：

- metadata 不包含 raw、PromQL、URL、storage path、凭据或完整 MCP 响应；
- observation.evidenceId 必须同时存在于 response.evidenceIds 和 evidence_ref；
- coverage 是来源读取覆盖率，不由模型填写；
- 旧 logs.capture 顶层 JSON 形式继续兼容，Collector 优先读取 metadata.sourceEvidence，
  然后才走旧格式；
- 非法 observation 按 MCP_PROTOCOL_ERROR 处理，不静默当成完整证据；
- 此变化不新增 ToolResponse block 类型，也不修改 Event/Message V2。

## 9. 指标事实与确定性报告

### 9.1 规范化事实

Metrics Collector 只接受由 metrics.settlement 产生的以下事实：

~~~ts
export interface SettlementMetricFact {
  status: 'healthy' | 'breached' | 'insufficient_data';
  total: number;
  failed: number;
  failureRate: number | null;
  threshold: number;
  minSamples: number;
  service: 'checkout';
  environment: 'simulation';
  start: number;
  end: number;
}
~~~

Collector 再次校验：

- total/failed 为安全非负整数，failed <= total；
- failureRate 等于 failed / total；total=0 时只能为 null；
- threshold/minSamples 与注入 Profile 完全一致；
- status 与 assessSettlementMetrics 的重新计算结果一致；
- end-start=300 秒；
- observation 时间和事实时间一致；
- evidenceId 唯一且与 ToolResponse 引用配对。

任何不一致都视为 MCP_PROTOCOL_ERROR，不能让 LLM“修正”。

### 9.2 source_report 的角色

child 仍必须调用 source_report，证明它完成了 Tool 编排并引用了已观察 evidenceId。
候选 summary/findings 经过通用引用校验，但 MetricsSourceReportCollector 不直接把模型生成的
数值、阈值或根因文本返回父级。最终 summary/findings 由规范化事实确定性生成。

因此：

- 模型提交未知 evidenceId：POLICY_DENIED；
- 模型声称错误失败率：最终结果仍使用代码计算值；
- 模型声称数据库根因：该文本不进入父级 SourceSubagentResult；
- 未调用 source_report：有证据则 partial，无证据则 unavailable。

### 9.3 三种场景

| 场景 | 指标事实 | SourceSubagentResult.status | Finding |
|---|---|---|---|
| normal | 100/0，0%，阈值 5% | complete | healthy observation |
| settlement_failure | 100/15，15%，阈值 5% | complete | breached observation |
| low_sample | 10/8，样本少于 20 | complete | insufficient_data observation |

low_sample 即使观测失败率为 80%，也不能输出 breached；样本不足优先。

确定性摘要模板：

~~~text
healthy:
结算指标正常：<window> 共 <total> 次，失败 <failed> 次，失败率 <rate>，
未超过 <threshold> 阈值。指标只能确认当前症状，不能单独确认根因。

breached:
结算指标异常：<window> 共 <total> 次，失败 <failed> 次，失败率 <rate>，
超过 <threshold> 阈值。指标只能确认当前症状，不能单独确认根因。

insufficient_data:
结算指标样本不足：<window> 共 <total> 次，低于最小样本 <minSamples>；
观测失败率为 <rate>，不作健康或异常阈值结论。指标不能单独确认根因。
~~~

百分比使用固定两位小数，时间使用 ISO-8601。每个结果只生成一条 observation finding，
businessTraceIds 固定为空。日志和 Trace 是后续取证建议，不作为 Metrics 来源本身的
missingEvidence；否则会把完整的 Metrics 调查错误标记为 partial。

### 9.4 状态计算

- complete：恰有一个有效指标 observation、报告已提交、窗口/Profile 一致；
- partial：已有有效证据，但报告缺失、child 后续失败、出现多个冲突快照或窗口不匹配；
- unavailable：没有任何有效 metric evidence；
- insufficient_data 是指标事实状态，不是 SourceSubagentStatus。

coverage 来自 observation。窗口不匹配时计算实际区间与请求区间的重叠比例，并强制
SourceSubagentStatus=partial；完全不相交时 coverage=0，但仍保留实际 evidenceId 并明确
其不能回答请求区间。

## 10. Runner 泛化

DefaultSourceSubagentRunner 增加两个 application 层可选端口：

~~~ts
export type SourcePromptRenderer = (
  request: SourceSubagentRequest,
  execution: SourceSubagentExecution,
) => string;

export type SourceReportCollectorFactory = (input: {
  request: SourceSubagentRequest;
  execution: SourceSubagentExecution;
}) => SourceReportCollector;
~~~

SourceSubagentRunnerOptions 使用 renderPrompt? 和 collector?。默认 renderer 必须使用
options.source 生成中性来源提示词，不能再写死“日志”。Logs 可显式注入日志提示词；
Metrics 必须注入 Metrics 提示词。

Metrics 固定提示要求：

- 只调用 metrics.settlement 和 source_report；
- metrics.settlement 最多形成一个成功快照；
- 原样引用返回的 evidenceId；
- 不计算失败率、不修改阈值、不猜根因；
- 低样本必须描述为 insufficient_data；
- 最终一定调用 source_report；
- 不输出 raw、PromQL、URL、凭据或内部路径。

动态 profile/service/time/question 放在稳定前缀之后，使用固定字段顺序和有界 JSON，
避免破坏工具/系统前缀稳定性。

## 11. 执行流程

~~~text
Parent Tool Pipeline
  -> 四道参数闸门
  -> host profile / Metrics Profile / 最新 5m 窗口校验
  -> 稳定 childRunId
  -> 继承 signal/deadline/toolCallBudget/networkAttemptBudget
  -> Child AgentHarness
       -> metrics.settlement
            -> MCP 可靠性执行器
            -> Prometheus 最新快照
            -> 确定性 assessSettlementMetrics
            -> EvidenceStore 提交
            -> SourceEvidenceObservation
       -> source_report
  -> MetricsSourceReportCollector 重新校验并确定性渲染
  -> SourceSubagentResult
  -> Parent ToolResponse
~~~

metrics.settlement 和 source_report 都必须经 child Pipeline。Runner 不得直接调用
settlementTool.call 或 Prometheus source。

## 12. 预算、重试与四轮降级

沿用来源规格：

~~~text
child.maxToolCalls = min(8, parent.remainingToolCalls)
child.deadline = min(parent.deadline, childStartedAt + 30s)
child.networkAttemptBudget = parent.networkAttemptBudget 共享引用
~~~

Metrics 正常闭环只需要两个模型 ToolCall；额外调用仍消耗父级额度。父级剩余 ToolCall 少于 2
时不启动 child，返回 BUDGET_EXCEEDED。

重试分层：

1. MCP 传输重试由现有 ResilientExecutor 唯一管理；
2. Source Adapter 只在 child 尚未向父级暴露输出且错误可重试时重启/恢复 child；
3. 两层都共享 networkAttemptBudget 和绝对 deadline；
4. maxAttempts 默认 2，硬上限 3；
5. ABORTED、POLICY_DENIED、INVALID_INPUT、BUDGET_EXCEEDED、MCP_AUTH_ERROR、
   MCP_PROTOCOL_ERROR 不重试；
6. MCP_TIMEOUT、MCP_NETWORK_ERROR、MCP_RATE_LIMITED、MCP_SERVER_ERROR、TIMEOUT
   可在预算内重试。

四轮降级：

1. Retry：来源瞬态失败时在共享预算内重试；
2. Resume/Verify：加载 child Checkpoint 和既有 evidence/captureKey；
3. Reduced scope：有有效指标证据但后续失败时返回 partial；
4. Unavailable：无有效证据时返回 unavailable，禁止生成健康或异常结论。

不能因 Prometheus 不可用而回退到模拟答案，也不能静默切换到日志或 Trace。

## 13. Checkpoint、证据身份与恢复

childRunId 统一使用共享帮助函数：

~~~text
source-child-metrics-<sha256("metrics\0" + parentRunId + "\0" + parentToolCallId)[0..31]>
~~~

同一 parent ToolCall 的普通重试和进程恢复必须得到相同 childRunId。

metric evidenceId 默认由 child runId 和 metrics.settlement toolCallId 稳定派生；测试仍可
注入固定 id：

~~~text
metric-evidence-<sha256(childRunId + "\0" + childToolCallId)[0..31]>
~~~

captureKey 继续为：

~~~text
metric:<childRunId>:<childToolCallId>:0
~~~

恢复规则：

- Checkpoint 已有成功 ToolResult 时直接恢复结果，不访问 Prometheus；
- EvidenceStore 已有同 evidenceId/captureKey 且内容身份一致时视为幂等完成；
- 外部查询成功但本地状态不确定时，不把 metrics.settlement 标成可无条件 replay；
- evidence 冲突或 raw hash 不一致时返回 STORAGE_ERROR/partial，不能覆盖旧记录；
- child 完成但 parent 未持久化 ToolResult 时，外层 metrics_subagent 仍使用
  verify_before_retry；
- iterator 提前关闭必须触发 child finally、Checkpoint 和观测 flush。

由于第一版不接收旧 evidenceIds，不承诺不同 parent ToolCall 间的历史指标证据复用。

## 14. Event、Message、SSE 与 LangSmith

本增量不新增事件。一次正常调用的主要事实流：

~~~text
TOOL_CALL_CREATED(metrics_subagent)
-> TOOL_STARTED(metrics_subagent)
-> SUBAGENT_STARTED(subagentType=metrics)
-> child RUN/REASONING/TOOL events
-> EVIDENCE_COLLECTED(source=metric)
-> SUBAGENT_COMPLETED(status=completed)
-> TOOL_RESULT(metrics_subagent)
~~~

失败/降级按需出现：

~~~text
SUBAGENT_RETRY_SCHEDULED
SUBAGENT_FALLBACK_ACTIVATED
SUBAGENT_FAILED
~~~

约束：

- SUBAGENT_STARTED 信封带 parentRunId、parent toolCallId、stepId、childRunId；
- LangSmith 名称固定为 tool.metrics_subagent 和 subagent.metrics；
- partial 映射 SUBAGENT_COMPLETED status=partial；
- unavailable 映射 SUBAGENT_FAILED error.code=UNAVAILABLE；
- EVIDENCE_COLLECTED 只在 EvidenceStore 可回读后发布；
- Public SSE 只展示安全摘要、状态、coverage 和 evidenceId；
- Audit/LangSmith 不含 raw、完整 ToolResponse、PromQL、URL、Header、API Key 或模型候选根因；
- 观测失败不影响本地 ToolResult、Checkpoint 或 Evidence 提交。

SourceEvidenceObservation 位于 ToolResponse.metadata，不是新的 Event/Message 类型。
MessageBlock 继续只使用 json、evidence_ref 和既有 tool_result。

## 15. 安全边界

- metrics_subagent 与 metrics.settlement 均只读；
- 模型不能访问模拟器管理 API，也不能选择 scenario；
- 模型不能提供 Prometheus 地址、认证、PromQL、阈值或最小样本；
- 远程 MCP 工具仍经过本地 Manifest/Schema 字节级对照；
- parent allowlist 只包含 metrics_subagent；
- child Registry 创建后冻结；
- 原始指标响应最多 64 KiB，并只存 EvidenceStore；
- ToolResponse summary、finding、question 和 lifecycle 文本都有字节/条目上限；
- Profile 不匹配、时间越界、非空 evidenceIds、非法 observation、事实重算不一致均
  fail closed；
- 不根据指标自动执行降级、熔断、发布、Shell 或数据库操作。

## 16. 测试与验收

### 16.1 默认测试

必须覆盖：

1. metrics_subagent canonical 名称和固定 Tool 属性；
2. parent 只见 metrics_subagent，child 只见 metrics.settlement/source_report；
3. wrong profile、wrong service、非法/历史窗口、未知字段、非空 evidenceIds 在 child 前拒绝；
4. SourceEvidenceObservation Schema、兼容旧 logs JSON、非法 metadata 拒绝；
5. normal=healthy、settlement_failure=breached、low_sample=insufficient_data；
6. 三场景均产生可回查 evidenceId，raw 不进入父 Context；
7. 模型提交错误数字或根因文本时，父结果仍是确定性事实；
8. 未调用 source_report、有证据后 child 失败、无证据来源失败的 partial/unavailable；
9. retryable/terminal/Abort/预算耗尽和共享网络尝试账本；
10. 稳定 childRunId/evidenceId、Checkpoint resume 和无重复已完成查询；
11. SUBAGENT_* 顺序、parent/tool 关联和 LangSmith span 名称；
12. Public/Audit/LangSmith 中不存在 raw、PromQL、URL、路径、密钥或完整模型候选；
13. 本地 OpenAI-compatible HTTP/SSE 完成 parent -> child -> 两个 child Tools -> parent；
14. consumer.return() 后状态可恢复。

### 16.2 可选真实 Prometheus 验收

保留 AGENTOPS_REAL_PROMETHEUS=1 显式开关，扩展 test/real-prometheus.test.ts，让三个场景
经过真实 Prometheus、MCP HTTP、Metrics child Harness、parent metrics_subagent 和 EvidenceStore。

默认 pnpm test 继续跳过该测试。只有实际执行并记录通过，才能声称“真实本地 Prometheus
链路已复验”；它仍不等于 group-buy-market 生产接入。

### 16.3 模型验收表述

本地 HTTP/SSE 服务通过时，只能表述：

~~~text
OpenAI-compatible 协议与 Metrics Subagent 工具闭环已验证。
~~~

没有显式在线凭据、实际供应商调用和评测数据集时，不得表述：

~~~text
真实模型诊断质量已验收。
~~~

质量门禁：

~~~text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
~~~

## 17. 实施文件边界

| 层 | 文件 | 职责 |
|---|---|---|
| contracts | src/contracts/source-subagent.ts | SourceEvidenceObservation 与可选专项校验端口 |
| application | src/application/source-evidence-observation.ts | 严格解析/构建安全 observation |
| application | src/application/source-report-collector.ts | 优先读取 observation，保留 logs 旧格式兼容 |
| application | src/application/source-subagent-runner.ts | 来源提示词与 Collector factory 注入 |
| application | src/application/metrics-source-report-collector.ts | 指标重算、窗口校验、确定性报告 |
| tool | src/tool/adapters/source-subagent-tool-adapter.ts | 调用可选的来源专项宿主校验 |
| profiles | src/profiles/settlement.ts | 实验 Profile、阈值、样本与窗口常量 |
| bootstrap | src/bootstrap/source-report-tool.ts | Logs/Metrics 共用 child-only report Tool |
| bootstrap | src/bootstrap/source-subagent-identity.ts | 稳定 childRunId |
| bootstrap | src/bootstrap/settlement-evidence-tool.ts | 指标证据身份、observation 和有界摘要 |
| bootstrap | src/bootstrap/logs-subagent.ts | 改用共享工厂，行为保持兼容 |
| bootstrap | src/bootstrap/metrics-subagent.ts | Metrics child Toolkit 与 canonical parent Tool |
| tests | test/metrics-source-report-collector.test.ts | 三状态、重算、窗口与抗幻觉 |
| tests | test/metrics-subagent-runtime.test.ts | 父子 Toolkit 和三场景 Harness |
| tests | test/metrics-subagent-recovery.test.ts | 重试、Checkpoint、幂等与降级 |
| tests | test/metrics-subagent-openai-compatible.test.ts | 本地 SDK/SSE 完整闭环 |
| tests | test/real-prometheus.test.ts | 可选真实 Prometheus Subagent 路径 |
| docs | docs/implementation-status.md、docs/architecture/05-subagents-and-mcp.md、docs/architecture/08-observability.md、docs/architecture/14-settlement-mcp-evidence.md | 实现状态与非声明边界 |

不得把 Metrics Collector、MCP 连接、child Runtime 组装和 ToolAdapter 塞进一个大类。

## 18. 完成定义

以下条件全部满足，才能把 Metrics Subagent 增量标记为完成：

- parent 只能调用 metrics_subagent，不能绕过到 metrics.settlement；
- child 确实复用 AgentHarness 和完整 Tool Pipeline；
- child Toolkit 只有 metrics.settlement/source_report；
- 三个模拟场景得到确定性且可回查的指标结果；
- 低样本不会被误判 breached，模型文本不能覆盖代码事实；
- raw Prometheus 数据不进入 parent Context、SSE、Audit 或 LangSmith；
- stable child/evidence identity、retry/resume/partial/unavailable/Abort 均有测试；
- 复用现有 Event/Message V2，没有新增同义事件；
- 本地 OpenAI-compatible 协议闭环通过；
- lint、typecheck、默认 test、build、diff check 全部通过；
- 文档明确真实 Prometheus 可选验收和 group-buy-market/线上模型未接入边界。

## 19. 后续顺序

本增量完成后，推荐顺序保持：

1. Run/Evidence 只读 API；
2. Agent Web；
3. group-buy-market 真实 Prometheus Profile 与来源适配器；
4. 真实 ELK/Trace Subagent；
5. 评测数据集和 LangSmith 在线验收；
6. 保护动作 Dry Run，再进入 HITL 真实动作。

任何后续来源接入都不得把底层 Prometheus/ELK/Tempo 工具重新暴露给 parent。
