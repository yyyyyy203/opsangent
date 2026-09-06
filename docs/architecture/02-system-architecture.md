# 总体架构与模块边界

## 主链路

```text
Agent Web / Scheduler / Alertmanager
                 ↓
Agent API → Application → 主 Harness
                             ↓ 统一 Tool Pipeline
          metrics_subagent / logs_subagent / traces_subagent
                 ↓ 各自 scoped Toolkit 与同一 Harness 实现
          Prometheus MCP / Elastic MCP / Tempo MCP
                 ↓
          Prometheus / Elasticsearch / Tempo
                 ↑
          遥测模拟器 ← Simulator API ← Simulator Web
```

SQLite 保存运行事实；EvidenceStore 保存证据；LangSmith 订阅 Agent 执行链路。每个 Subagent 是同一 Harness 实现的独立实例，不另写一套循环。

## 模块边界

核心保留在一个 src 包中，按职责拆模块，通过 index.ts 收敛公开入口，不提前拆成大量 packages。外围应用放 apps。目标布局：

```text
src/
  contracts/ agent/ tool/ hooks/ guard/ event/
  context/ context-compressor/ memory/ storage/ checkpoint/
  model/ mcp/ profiles/ observability/
  api/ application/ infrastructure/ bootstrap/
apps/
  agent-api/ agent-web/ simulator-api/ simulator-web/ prometheus-mcp/
skills/ profiles/ infrastructure/ test/ docs/
```

src/api 是边界适配，apps/agent-api 是启动宿主；src/profiles 提供类型和加载抽象，根 profiles 保存实例配置；src/infrastructure 是适配实现，根 infrastructure 是 Compose 和部署配置。

## 依赖规则

api → application → agent/core → contracts。基础设施实现依赖契约，bootstrap 构造具体实现并注入。命令和查询走显式接口；生命周期、SSE、审计走事件。无需把所有交互强行变成事件请求应答。

Harness 不依赖数据库、文件系统、MCP SDK、HTTP 框架或具体模型 SDK。时间、ID、随机数、模型、存储、重试策略均可注入。模块不得使用全局 Run 状态。

## 可替换接口

| 边界 | 责任 | 可替换实现 |
|---|---|---|
| ChatModel / Formatter | 模型调用及消息协议转换 | DeepSeek、其他兼容端点 |
| ToolRegistry / ToolRunner | 能力查询及具体执行 | MCP、Skill、Subagent、内置函数 |
| ContextRenderer / ContextCompressor | 模型输入构建及窗口治理 | 规则压缩、摘要模型 |
| MemoryFacade 与小型 Repository | 召回、案例、候选经验 | 本地检索、后续其他检索后端 |
| CheckpointStore / EvidenceStore | 可恢复状态和证据 | SQLite/文件、后续其他存储 |
| Observability | span、事件和脱敏上报 | LangSmith、Noop |

新接口是设计目标，实施前与现有 contracts 对齐。实现替换应在 bootstrap 完成，不修改主循环。

## Newton 参考范围

借鉴统一 Tool、Subagent 自治、流式接口、分桶调度、Hooks、中断序列化、上下文分层治理及构造器注入。Newton 的桌面宿主、公司网关、工作流沙箱、复杂偏好系统和缓存收益数字不直接成为本项目需求；未验证收益不写入验收标准。
