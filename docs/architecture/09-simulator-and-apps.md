# 遥测模拟器、前端与触发入口

## 两套前端

Simulator Web 管理场景、开始/停止/重置、速率和生成状态，通过 Simulator API 操作。Agent Web 发起巡检、查看任务、流式过程、证据、报告和能力健康，通过 Agent API 操作。二者逻辑和权限独立，Agent 不拥有读取场景标准答案的接口。

Agent Web 采用任务列表、中央执行过程、右侧证据详情的布局。默认展示口语化摘要，可展开参数、错误、重试和时序信息。用户输入服务及时间范围，能取消任务、重新打开历史报告和回查证据。

## 模拟数据链路

模拟器按“通用遥测基线 + 场景配置”生成业务请求、日志和 span：指标暴露给 Prometheus 抓取，日志经采集入口进入 Elasticsearch，Trace 经 OTel Collector 进入 Tempo。具体采集组件及版本在 V1.1 选型锁定；Agent 查询的始终是这些真实后端。

黄金场景包含正常基线与 MySQL 超时覆盖。用相同 service、环境、时间和业务 traceId 关联日志与 Trace。指标通常按服务与窗口聚合；没有 exemplar 时不能宣称每个指标点精确对应一个 Trace。

预期根因、故障开关和 fixture 答案仅供模拟控制与评测；不得注入可查询日志字段、Skill、Profile 或记忆。日志里真实模拟出的 timeout 信息可作为证据。

可重复运行保存随机种子、场景版本、实际窗口和批次 ID。重置只操作明确隔离的模拟命名空间。生成完成后等待后端可查询就绪，避免把摄取延迟当成业务缺失。

## 黄金 fixture

固定验收窗口 5 分钟，100 次结算、15 次失败，阈值 5%、最低样本 20。确定性处理器计算 15%。Prometheus Counter 的 increase 可能受抓取和外推影响；测试必须采用可控抓取边界和已定义查询，显式验证取数语义，不能对不受控 Counter 外推值直接断言整数 100。

## 触发与 API 边界

InspectionTrigger 统一 type（manual/scheduled/alert）、profileId、service、start/end、actor、幂等/去重键和来源元数据。应用层验证输入和可用能力后创建 Run。告警按 fingerprint 与窗口去重，定时任务明确时区和重复执行策略；不在 HTTP Controller 写推理循环。

建议资源为 /runs、/runs/:id、/runs/:id/events、/runs/:id/report、/evidence/:id、/schedules、/capabilities、/health，以及告警 webhook；模拟侧为 /scenarios 和场景启动/停止/重置操作。这是资源设计，具体 HTTP 契约在应用里程碑固化。

SSE 事件具备稳定 ID 和重连游标，历史事件来自持久化记录。断开页面不默认取消任务，显式取消操作传播 Abort。事件重放不重新执行工具。

## 本地部署与后续接入

Compose 包含数据后端、采集链路、MCP 和应用，提供健康检查、持久卷及示例配置。V1 单用户服务默认仅本机可访问；公开上线前须补认证授权、入口限流、备份恢复和部署审查。

group-buy-market 当前遥测状态来自早期检查记录，不作为此轮重新验证的事实。真实接入阶段独立核验 Prometheus、日志上报和 Trace 完整性，以新 Profile 接入，不改变 Harness。
