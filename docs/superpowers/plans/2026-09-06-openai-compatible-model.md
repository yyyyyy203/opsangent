# OpenAI-Compatible Model Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为巡检 Agent 接入可审计、可取消、支持原生工具调用的 OpenAI-compatible 流式模型，首个配置目标为 DeepSeek，并修复真实模型接入暴露出的 Harness 契约缺口。

**Architecture:** 先以向后兼容方式扩展 Harness 的 deadline、assistant 历史和结构化失败持久化，再将消息格式化、SSE 解码、流组装、HTTP transport 和重试分别实现为独立模块。`OpenAICompatibleChatModel` 只负责一次协议调用，`RetryingChatModel` 负责尝试策略，二者通过 `ChatModel` 组合；所有协议验收使用本地真实 HTTP/SSE 服务器，不依赖在线密钥。

**Tech Stack:** TypeScript 5.9、Node.js 20 原生 `fetch`/Web Streams、pnpm、Vitest、现有 Zod Tool Schema、现有 LangSmith Observability。

**Spec:** `docs/superpowers/specs/2026-09-06-openai-compatible-model-design.md`

## Global Constraints

- 保持 `ChatModel`、`ModelResponse`、`ModelStreamEvent`、消息块和已发布 EventType 的现有语义；只新增可选字段。
- `OpenAICompatibleChatModel` 是 transport-only，不读取环境变量，不包含重试、fallback、系统提示词或诊断策略。
- 工具 arguments 必须原样进入 `RawToolCall`，由现有四道 Tool Admission 闸门统一解析和修复。
- 只把明确白名单内的 ToolResult 字段发给模型；不得泄露 metadata、artifact URI、本地路径、密钥、请求正文、响应正文或完整内部 URL。
- 只有 `stop` 和 `tool_calls` 是成功终态；`length` 必须以 `output_truncated` 失败。
- 透明重试最多 2 次，且一旦向上游 yield 任意 `text_delta`，本次逻辑调用不得重试。
- 每个网络调用同时服从父 signal、Run deadline、连接/首字节超时、流空闲超时和单调用总上限。
- 不引入 OpenAI SDK、DeepSeek Harness 包或新的运行时依赖。
- 不访问真实 DeepSeek 服务；在线验收必须等用户提供密钥后另开任务。
- 修改公共契约后同步测试 checkpoint 结构化克隆和旧对象缺少可选字段时的兼容行为。
- `AgentContext.failure?` 当前随对象 checkpoint 保存，不提升 SQLite schema version；未来关系型映射必须单独迁移。

---

## File Map

**Modify**

- `src/contracts/model.ts`：给 `ModelCallOptions` 增加可选绝对 `deadline`。
- `src/contracts/context.ts`：给 `AgentContext` 增加可选结构化 `failure`。
- `src/agent/agent-harness.ts`：传播 Run deadline；持久化 assistant 文本 + tool call；保存并发布结构化模型失败。
- `src/index.ts`：导出新增模型实现、配置、错误和观察端口。
- `docs/architecture/15-openai-compatible-model.md`：记录已实现边界、配置、错误和验收结论。
- `docs/implementation-status.md`、`docs/README.md`：更新当前能力和文档索引。

**Create**

- `src/model/model-failure.ts`：`ModelFailure` 与安全错误分类。
- `src/model/model-attempt-observer.ts`：尝试级审计端口、事件 DTO 和空实现。
- `src/observability/model-attempt-observer.ts`：把模型尝试映射为现有 Observability/LangSmith 子 span。
- `src/model/retrying-model.ts`：有界重试 `ChatModel` 装饰器。
- `src/model/openai-compatible/types.ts`：请求、SSE chunk 和 assembler 的内部 wire 类型。
- `src/model/openai-compatible/formatter.ts`：纯消息/工具格式化、稳定 JSON 和 ToolResult 白名单。
- `src/model/openai-compatible/sse.ts`：增量 UTF-8 SSE 解码与事件/总量限制。
- `src/model/openai-compatible/assembler.ts`：choice、文本、tool fragments、usage、finish 和 DONE 状态机。
- `src/model/openai-compatible/model.ts`：单次 HTTP 流调用、超时、取消、content-type 和脱敏错误。
- `src/model/openai-compatible/index.ts`：该子模块公开入口。
- `src/bootstrap/deepseek-model.ts`：显式配置的 DeepSeek 组合工厂，不直接读取环境变量。
- `test/model-harness-contract.test.ts`：Harness 新契约回归。
- `test/openai-formatter.test.ts`：消息和工具序列化。
- `test/openai-sse.test.ts`：SSE framing 和限制。
- `test/openai-assembler.test.ts`：流组装状态机。
- `test/openai-model-http.test.ts`：本地真实 HTTP/SSE transport 测试。
- `test/retrying-model.test.ts`：重试矩阵和尝试审计。
- `test/openai-harness.integration.test.ts`：真实 Adapter → Tool Admission → MCP → EvidenceStore → Harness 闭环。

---

### Task 1: 修复 Harness 的真实模型契约缺口

**Files:**
- Modify: `src/contracts/model.ts`
- Modify: `src/contracts/context.ts`
- Modify: `src/agent/agent-harness.ts`
- Test: `test/model-harness-contract.test.ts`

**Interfaces:**
- Consumes: `ChatModel.stream(messages, tools, options)`、`toAgentError(error, fallbackCode)`、现有 `CheckpointStore`。
- Produces: `ModelCallOptions.deadline?: number`、`AgentContext.failure?: AgentError`；`appendToolExchange(context, text, calls, results)` 保存完整 assistant turn。

- [ ] **Step 1: 写 deadline、混合 assistant turn 和结构化失败的失败测试**

在 `test/model-harness-contract.test.ts` 构造最小 Harness fixture，并加入三个明确断言：

```ts
it('passes the absolute run deadline to every model call', async () => {
  const seen: number[] = [];
  const model: ChatModel = {
    async *stream(_messages, _tools, options) {
      seen.push(options.deadline ?? -1);
      return { text: 'done', toolCalls: [] };
    },
  };
  const harness = createHarnessFixture({ model, now: '2026-09-06T00:00:00.000Z' });
  await harness.reply({ message: 'inspect', profileId: 'settlement', maxDurationMs: 30_000 });
  expect(seen).toEqual([Date.parse('2026-09-06T00:00:00.000Z') + 30_000]);
});

it('persists assistant text beside raw tool calls before the next reasoning step', async () => {
  const model = new CapturingSequenceModel([
    { text: '我先检查失败率。', toolCalls: [], rawToolCalls: [{ id: 'tc-1', name: 'metrics.settlement', arguments: '{"window":"5m"}' }] },
    { text: '检查完成。', toolCalls: [] },
  ]);
  const { harness, checkpoints } = createHarnessFixture({ model, toolResult: successResult('tc-1') });
  await harness.reply({ message: 'inspect', profileId: 'settlement' });
  const saved = await checkpoints.load(model.runId);
  const assistant = saved?.messages.find((message) => message.role === 'assistant');
  expect(assistant?.blocks).toEqual([
    { type: 'text', text: '我先检查失败率。' },
    { type: 'raw_tool_call', call: { id: 'tc-1', name: 'metrics.settlement', arguments: '{"window":"5m"}' } },
  ]);
  expect(model.requests[1]).toContainEqual(assistant);
});

it('persists the final assistant text before the completed checkpoint', async () => {
  const { harness, checkpoints, runId } = createHarnessFixture({ model: oneShotModel('diagnosis complete') });
  await harness.reply({ runId, message: 'inspect', profileId: 'settlement' });
  expect((await checkpoints.load(runId))?.messages.at(-1)).toMatchObject({
    role: 'assistant', blocks: [{ type: 'text', text: 'diagnosis complete' }],
  });
});

it('checkpoints a plain MODEL_ERROR and publishes its safe category', async () => {
  const failure = Object.assign(new Error('Model request failed.'), {
    code: 'MODEL_ERROR' as const,
    retryable: true,
    details: { category: 'server', status: 503 },
  });
  const { harness, checkpoints, events, runId } = createHarnessFixture({ model: throwingModel(failure) });
  const result = await harness.reply({ runId, message: 'inspect', profileId: 'settlement' });
  expect(result.status).toBe('failed');
  expect((await checkpoints.load(runId))?.failure).toEqual({
    code: 'MODEL_ERROR', message: 'Model request failed.', retryable: true,
    details: { category: 'server', status: 503 },
  });
  expect(events).toContainEqual(expect.objectContaining({
    type: 'RUN_FAILED', payload: expect.objectContaining({ code: 'MODEL_ERROR', category: 'server', retryable: true }),
  }));
});
```

- [ ] **Step 2: 运行定向测试并确认失败原因**

Run: `pnpm vitest run test/model-harness-contract.test.ts`

Expected: FAIL，分别显示 `deadline` 不存在、assistant block 缺少 text、checkpoint 缺少 failure。

- [ ] **Step 3: 做最小向后兼容契约和 Harness 修改**

在 `src/contracts/model.ts` 增加：

```ts
export interface ModelCallOptions {
  signal: AbortSignal;
  runId: string;
  stepId: string;
  deadline?: number;
}
```

在 `src/contracts/context.ts` 引入 `AgentError` 并增加：

```ts
failure?: AgentError;
```

在 Harness 调模型时计算一次绝对截止时间：

```ts
const deadline = Date.parse(context.budget.startedAt) + context.budget.maxDurationMs;
const stream = this.dependencies.model.stream(context.messages, this.dependencies.toolkit.list(), {
  signal,
  runId: context.runId,
  stepId,
  deadline,
});
```

把调用改为 `this.appendToolExchange(context, response.text, candidates, orderedResults)`，并以 text-first 顺序构造 assistant blocks。无 candidates 时，在 completed checkpoint 前调用同一个 assistant append helper 写入最终文本：

```ts
const blocks: MessageBlock[] = [];
if (text !== undefined && text.length > 0) blocks.push({ type: 'text', text });
blocks.push(...calls.map((call) => 'arguments' in call
  ? { type: 'raw_tool_call' as const, call }
  : { type: 'tool_call' as const, call }));
```

在 `run()` 成功开始前删除旧失败；catch 中只保存普通 DTO：

```ts
delete context.failure;
// ...
const failure = toAgentError(error);
context.failure = failure;
await this.dependencies.checkpoints.save(context);
await this.publish('RUN_FAILED', context, {
  message: failure.message,
  code: failure.code,
  retryable: failure.retryable,
  category: failure.details?.category,
});
```

- [ ] **Step 4: 运行契约回归**

Run: `pnpm vitest run test/model-harness-contract.test.ts test/error-serialization.test.ts test/tool-admission.test.ts`

Expected: PASS；旧 checkpoint fixture 不提供 `failure` 仍能读取。

- [ ] **Step 5: 提交该独立修复**

```bash
git add src/contracts/model.ts src/contracts/context.ts src/agent/agent-harness.ts test/model-harness-contract.test.ts
git commit -m "fix: preserve model turns and run deadlines"
```

---

### Task 2: 定义结构化模型失败与尝试审计端口

**Files:**
- Create: `src/model/model-failure.ts`
- Create: `src/model/model-attempt-observer.ts`
- Create: `src/observability/model-attempt-observer.ts`
- Test: `test/retrying-model.test.ts`

**Interfaces:**
- Consumes: `AgentError`、`ModelResponse`。
- Produces: `ModelFailureCategory`、`ModelFailure`、`ModelAttemptEvent`、`ModelAttemptObserver.record(event): void | Promise<void>`、`NOOP_MODEL_ATTEMPT_OBSERVER`、`ObservabilityModelAttemptObserver`。

- [ ] **Step 1: 写序列化和脱敏边界测试**

```ts
it('converts ModelFailure to a checkpoint-safe AgentError DTO', () => {
  const failure = new ModelFailure('server', 'Model request failed.', true, { status: 503, attempts: 2 });
  expect(structuredClone(toAgentError(failure))).toEqual({
    code: 'MODEL_ERROR', message: 'Model request failed.', retryable: true,
    details: { category: 'server', status: 503, attempts: 2 },
  });
  expect(JSON.stringify(failure)).not.toContain('api.deepseek.com');
});

it('maps retry attempts to closed observability child spans', async () => {
  const observability = new RecordingObservability();
  const observer = new ObservabilityModelAttemptObserver(observability);
  await observer.record({ type: 'started', runId: 'r1', stepId: 's1', attempt: 1 });
  await observer.record({ type: 'retry_scheduled', runId: 'r1', stepId: 's1', attempt: 1, category: 'server', delayMs: 100 });
  expect(observability.spans).toEqual([
    expect.objectContaining({ name: 'model.attempt', kind: 'llm', runId: 'r1', stepId: 's1' }),
  ]);
  expect(observability.handles[0]?.failed).toBe(true);
  expect(observer.activeCount).toBe(0);
});
```

- [ ] **Step 2: 运行测试确认类型不存在**

Run: `pnpm vitest run test/retrying-model.test.ts`

Expected: FAIL，`ModelFailure` 和 observer 模块尚不存在。

- [ ] **Step 3: 实现小接口和稳定错误对象**

```ts
export type ModelFailureCategory =
  | 'auth' | 'rate_limit' | 'server' | 'network' | 'timeout'
  | 'protocol' | 'aborted' | 'context_length' | 'output_truncated';

export class ModelFailure extends Error implements AgentError {
  public readonly code = 'MODEL_ERROR' as const;
  public readonly details: Record<string, unknown>;
  public constructor(
    category: ModelFailureCategory,
    message: string,
    public readonly retryable: boolean,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ModelFailure';
    this.details = { category, ...details };
  }
}
```

```ts
export type ModelAttemptEvent =
  | { type: 'started'; runId: string; stepId: string; attempt: number }
  | { type: 'retry_scheduled'; runId: string; stepId: string; attempt: number; category: ModelFailureCategory; delayMs: number }
  | { type: 'succeeded'; runId: string; stepId: string; attempt: number; usage?: ModelResponse['usage'] }
  | { type: 'failed'; runId: string; stepId: string; attempt: number; category: ModelFailureCategory; retryable: boolean };

export interface ModelAttemptObserver {
  record(event: ModelAttemptEvent): void | Promise<void>;
}

export const NOOP_MODEL_ATTEMPT_OBSERVER: ModelAttemptObserver = { record: () => undefined };
```

`ObservabilityModelAttemptObserver` 以 `${runId}:${stepId}:${attempt}` 保存临时 `SpanHandle`：started 时创建 `model.attempt`/`llm` 子 span；retry_scheduled 和 failed 时写入脱敏属性后 fail；succeeded 时携 usage end，并立即删除 Map 项，禁止跨 Run 残留。

- [ ] **Step 4: 运行测试和类型检查**

Run: `pnpm vitest run test/retrying-model.test.ts && pnpm typecheck`

Expected: PASS。

- [ ] **Step 5: 提交错误与审计端口**

```bash
git add src/model/model-failure.ts src/model/model-attempt-observer.ts src/observability/model-attempt-observer.ts test/retrying-model.test.ts
git commit -m "feat: define model failure and attempt audit contracts"
```

---

### Task 3: 实现安全、稳定的请求 Formatter

**Files:**
- Create: `src/model/openai-compatible/types.ts`
- Create: `src/model/openai-compatible/formatter.ts`
- Test: `test/openai-formatter.test.ts`

**Interfaces:**
- Consumes: `AgentMessage[]`、`Tool[]`、`toolInputJsonSchema(tool)`。
- Produces: `formatChatRequest(messages, tools, model): OpenAIChatRequest`、`renderToolResultForModel(result): string`、`stableJson(value): string`。

- [ ] **Step 1: 写正常消息、RawToolCall 和安全字段白名单测试**

```ts
it('preserves raw arguments and removes sensitive tool-result fields', () => {
  const request = formatChatRequest([
    message('assistant', [
      { type: 'text', text: 'checking' },
      { type: 'raw_tool_call', call: { id: 'c1', name: 'metrics.settlement', arguments: '{window:"5m"}' } },
    ]),
    message('tool', [{ type: 'tool_result', result: {
      toolCallId: 'c1', toolName: 'metrics.settlement', status: 'failed',
      error: { code: 'TOOL_ARGUMENTS_SCHEMA_INVALID', message: 'Arguments do not match.', retryable: false,
        details: { gate: 'schema', expectedSchema: { type: 'object' }, issues: ['window'], secret: 'never-send' } },
      response: { blocks: [
        { type: 'evidence_ref', evidenceId: 'ev-1' },
        { type: 'artifact', uri: 'file:///D:/secret/report.json' },
      ], metadata: { token: 'never-send' } },
      startedAt: '2026-09-06T00:00:00.000Z', finishedAt: '2026-09-06T00:00:01.000Z',
    } }]),
  ], [], 'deepseek-chat');
  expect(request.messages[0]).toMatchObject({
    role: 'assistant', content: 'checking',
    tool_calls: [{ id: 'c1', function: { name: 'metrics.settlement', arguments: '{window:"5m"}' } }],
  });
  const content = JSON.stringify(request.messages[1]);
  expect(content).toContain('expectedSchema');
  expect(content).toContain('ev-1');
  expect(content).not.toContain('never-send');
  expect(content).not.toContain('file:///');
});

it('sorts nested object keys and joins text blocks with newlines', () => {
  expect(stableJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
  expect(formatChatRequest([message('user', [text('line 1'), text('line 2')])], [], 'm').messages[0])
    .toEqual({ role: 'user', content: 'line 1\nline 2' });
});
```

再以 `it.each` 覆盖：system/context_summary、tool-call-only content `''`、多个独立 tool result、Zod/custom JSON Schema、孤儿 tool result、assistant call 缺 id/name、不可表示 block。

- [ ] **Step 2: 运行 Formatter 测试确认失败**

Run: `pnpm vitest run test/openai-formatter.test.ts`

Expected: FAIL，formatter 模块尚不存在。

- [ ] **Step 3: 实现递归稳定 JSON 和白名单渲染**

核心实现保持纯函数：

```ts
const CORRECTION_DETAIL_KEYS = new Set([
  'gate', 'reason', 'retryableByModel', 'expectedSchema', 'issues',
  'correctionChainId', 'remainingModelRetries',
]);

export function renderToolResultForModel(result: ToolExecutionResult): string {
  const blocks = result.response?.blocks.flatMap((block) => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }];
    if (block.type === 'json') return [{ type: 'json', value: block.value }];
    if (block.type === 'evidence_ref') return [{ type: 'evidence_ref', evidenceId: block.evidenceId }];
    return [];
  }) ?? [];
  const details = result.error?.details === undefined
    ? undefined
    : Object.fromEntries(Object.entries(result.error.details).filter(([key]) => CORRECTION_DETAIL_KEYS.has(key)));
  return stableJson({
    status: result.status,
    blocks,
    ...(result.error === undefined ? {} : { error: {
      code: result.error.code,
      message: result.error.message.slice(0, 500),
      ...(details === undefined || Object.keys(details).length === 0 ? {} : { details }),
    } }),
  });
}
```

Formatter 先建立 assistant tool_call id 集合，再验证 tool result 的 `toolCallId` 必须存在；任何不可表示输入抛 `ModelFailure('protocol', 'Model request cannot be formatted.', false)`。

- [ ] **Step 4: 运行 Formatter 测试**

Run: `pnpm vitest run test/openai-formatter.test.ts test/tool-admission.test.ts`

Expected: PASS；现有纠错测试继续通过。

- [ ] **Step 5: 提交 Formatter**

```bash
git add src/model/openai-compatible/types.ts src/model/openai-compatible/formatter.ts test/openai-formatter.test.ts
git commit -m "feat: format safe openai compatible requests"
```

---

### Task 4: 实现严格 SSE 解码器

**Files:**
- Create: `src/model/openai-compatible/sse.ts`
- Test: `test/openai-sse.test.ts`

**Interfaces:**
- Consumes: `ReadableStream<Uint8Array>`、`AbortSignal`、`{ maxEventBytes, maxResponseBytes }`。
- Produces: `decodeSse(stream, options): AsyncGenerator<string>`；只 yield 合并后的 data payload。

- [ ] **Step 1: 写跨字节、CRLF、多 data 和截断测试**

```ts
it('decodes split UTF-8 and multiline data fields', async () => {
  const bytes = new TextEncoder().encode('\uFEFF: ping\r\ndata: 你\r\ndata: 好\r\n\r\n');
  const stream = byteStream([bytes.slice(0, 14), bytes.slice(14, 17), bytes.slice(17)]);
  expect(await collect(decodeSse(stream, { maxEventBytes: 1024, maxResponseBytes: 4096 })))
    .toEqual(['你\n好']);
});

it.each([
  ['event limit', 'data: 12345\n\n', 4, 100],
  ['response limit', 'data: 1\n\ndata: 2\n\n', 100, 10],
])('rejects %s', async (_name, body, maxEventBytes, maxResponseBytes) => {
  await expect(collect(decodeSse(textStream(body), { maxEventBytes, maxResponseBytes })))
    .rejects.toMatchObject({ code: 'MODEL_ERROR', details: { category: 'protocol' } });
});
```

另测 LF/CRLF、BOM、comment、event/id/retry 忽略、空 data、任意 chunk 边界、Abort、EOF 尚有未提交字段时失败。

- [ ] **Step 2: 运行 SSE 测试确认失败**

Run: `pnpm vitest run test/openai-sse.test.ts`

Expected: FAIL，`decodeSse` 尚不存在。

- [ ] **Step 3: 实现增量 TextDecoder 状态机**

使用 `TextDecoder.decode(chunk, { stream: true })`，只按空行提交事件，多条 `data:` 用 `\n` 合并；统计原始字节而非 JS 字符数。EOF 时若 parser buffer 或当前事件字段非空，抛 protocol failure；在 `finally` 调用 `reader.releaseLock()`。

```ts
export interface SseDecodeOptions {
  signal: AbortSignal;
  maxEventBytes?: number;
  maxResponseBytes?: number;
}

export async function* decodeSse(
  stream: ReadableStream<Uint8Array>,
  options: SseDecodeOptions,
): AsyncGenerator<string>;
```

- [ ] **Step 4: 运行 SSE 测试和类型检查**

Run: `pnpm vitest run test/openai-sse.test.ts && pnpm typecheck`

Expected: PASS。

- [ ] **Step 5: 提交 SSE 解码器**

```bash
git add src/model/openai-compatible/sse.ts test/openai-sse.test.ts
git commit -m "feat: decode bounded openai sse streams"
```

---

### Task 5: 实现流组装与严格终态

**Files:**
- Create: `src/model/openai-compatible/assembler.ts`
- Modify: `src/model/openai-compatible/types.ts`
- Test: `test/openai-assembler.test.ts`

**Interfaces:**
- Consumes: SSE data string。
- Produces: `OpenAIStreamAssembler.accept(data): ModelStreamEvent[]`、`finish(): ModelResponse`、`done: boolean`。

- [ ] **Step 1: 写交错工具片段、usage、DONE 和 length 失败测试**

```ts
it('assembles interleaved raw tool calls by wire index', () => {
  const assembler = new OpenAIStreamAssembler();
  assembler.accept(chunk([{ index: 0, delta: { tool_calls: [
    { index: 1, id: 'b', function: { name: 'logs.search', arguments: '{"q":' } },
    { index: 0, id: 'a', function: { name: 'metrics.query', arguments: '{"w":' } },
  ] } }]));
  assembler.accept(chunk([{ index: 0, delta: { tool_calls: [
    { index: 0, function: { arguments: '"5m"}' } },
    { index: 1, function: { arguments: '"error"}' } },
  ] }, finish_reason: 'tool_calls' }]));
  assembler.accept(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
  assembler.accept('[DONE]');
  expect(assembler.finish()).toEqual({
    toolCalls: [],
    rawToolCalls: [
      { id: 'a', name: 'metrics.query', arguments: '{"w":"5m"}' },
      { id: 'b', name: 'logs.search', arguments: '{"q":"error"}' },
    ],
    usage: { inputTokens: 10, outputTokens: 4 },
  });
});

it('rejects length as truncated output', () => {
  const assembler = new OpenAIStreamAssembler();
  assembler.accept(chunk([{ index: 0, delta: { content: 'partial' }, finish_reason: 'length' }]));
  expect(() => assembler.accept('[DONE]')).toThrowError(expect.objectContaining({
    code: 'MODEL_ERROR', details: { category: 'output_truncated' },
  }));
});
```

另测：text delta 立即返回；stop；无效 JSON；choice 非 0；多 choice；重复矛盾 id/name；缺 id/name；负数/非整数 usage 忽略；空响应；缺 DONE 的 `finish()` 失败；DONE 后 `accept()` 拒绝。

- [ ] **Step 2: 运行 assembler 测试确认失败**

Run: `pnpm vitest run test/openai-assembler.test.ts`

Expected: FAIL，assembler 尚不存在。

- [ ] **Step 3: 实现显式状态机**

内部维护 `Map<number, { id?: string; name?: string; arguments: string }>`、累计 text、last usage、finish reason、seenPayload 和 done。`accept('[DONE]')` 只在已见合法 finish reason 时成功；`finish()` 再校验 DONE 和所有 tool identity。

```ts
export class OpenAIStreamAssembler {
  public get done(): boolean;
  public accept(data: string): ModelStreamEvent[];
  public finish(): ModelResponse;
}
```

tool calls 最终按 wire index 升序输出；arguments 不做 JSON.parse。

- [ ] **Step 4: 运行 assembler 与 admission 测试**

Run: `pnpm vitest run test/openai-assembler.test.ts test/tool-admission.test.ts`

Expected: PASS；无效 raw arguments 仍由 admission 拒绝或修复。

- [ ] **Step 5: 提交流组装器**

```bash
git add src/model/openai-compatible/types.ts src/model/openai-compatible/assembler.ts test/openai-assembler.test.ts
git commit -m "feat: assemble openai streaming responses"
```

---

### Task 6: 实现单次 OpenAI-compatible HTTP Transport

**Files:**
- Create: `src/model/openai-compatible/model.ts`
- Create: `src/model/openai-compatible/index.ts`
- Test: `test/openai-model-http.test.ts`

**Interfaces:**
- Consumes: `formatChatRequest()`、`decodeSse()`、`OpenAIStreamAssembler`、`ModelCallOptions.deadline`。
- Produces: `OpenAICompatibleChatModel implements ChatModel`、`OpenAICompatibleModelConfig`；每次 `stream()` 只发起一次 HTTP 请求。

- [ ] **Step 1: 写本地真实 HTTP/SSE 成功和 URL 规范化测试**

```ts
it('streams text from a prefixed base URL and returns usage', async () => {
  const server = await startSseServer('/gateway/v1/chat/completions', (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write('data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\n');
    response.write('data: {"choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n');
    response.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
    response.end('data: [DONE]\n\n');
  });
  const model = new OpenAICompatibleChatModel({
    baseUrl: `${server.url}/gateway/v1/`, apiKey: 'test-key', model: 'deepseek-chat',
  });
  const { events, result } = await drain(model.stream([userMessage('hi')], [], callOptions()));
  expect(events).toEqual([
    { type: 'text_delta', delta: '你' },
    { type: 'text_delta', delta: '好' },
    { type: 'usage', inputTokens: 3, outputTokens: 2 },
  ]);
  expect(result).toEqual({ text: '你好', toolCalls: [], usage: { inputTokens: 3, outputTokens: 2 } });
  expect(server.paths).toEqual(['/gateway/v1/chat/completions']);
});
```

再测：Authorization header 不进入错误；baseUrl 拒绝 credentials/query/fragment/非 http(s)；content-type 错误；401/403→auth；400 context 文案→context_length，否则 protocol；429→rate_limit；5xx→server；缺 body；缺 DONE；4 MiB 总限制；256 KiB 事件限制；父 Abort。

- [ ] **Step 2: 运行 HTTP 测试确认失败**

Run: `pnpm vitest run test/openai-model-http.test.ts`

Expected: FAIL，HTTP transport 尚不存在。

- [ ] **Step 3: 实现配置、URL、单次 fetch 和 reader 取消**

```ts
export interface OpenAICompatibleModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxEventBytes?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class OpenAICompatibleChatModel implements ChatModel {
  public constructor(config: OpenAICompatibleModelConfig);
  public stream(messages: AgentMessage[], tools: Tool[], options: ModelCallOptions): AsyncGenerator<ModelStreamEvent, ModelResponse>;
}
```

默认值固定为 10_000/60_000/120_000/256*1024/4*1024*1024。组合 signal 时为每个 timer 保存句柄并在 finally 清理；Run deadline 已过时不发请求。收到 assembler DONE 后调用 `reader.cancel()`，再返回 `assembler.finish()`。错误只保留类别、HTTP status、Retry-After 毫秒，不读取或回显完整响应正文。

- [ ] **Step 4: 运行 HTTP、SSE、assembler 测试**

Run: `pnpm vitest run test/openai-model-http.test.ts test/openai-sse.test.ts test/openai-assembler.test.ts`

Expected: PASS；测试 server 在 afterEach 中关闭，没有悬挂 handle。

- [ ] **Step 5: 提交 transport**

```bash
git add src/model/openai-compatible/model.ts src/model/openai-compatible/index.ts test/openai-model-http.test.ts
git commit -m "feat: add openai compatible streaming transport"
```

---

### Task 7: 以 ChatModel 装饰器实现有界重试

**Files:**
- Create: `src/model/retrying-model.ts`
- Modify: `test/retrying-model.test.ts`

**Interfaces:**
- Consumes: 任意 `ChatModel`、`ModelFailure`、`ModelAttemptObserver`。
- Produces: `RetryingChatModel implements ChatModel`、`RetryingModelOptions`。

- [ ] **Step 1: 写重试矩阵、可见输出边界和观察事件测试**

```ts
it('retries a retryable failure before visible output and audits every attempt', async () => {
  const inner = sequenceModel([
    new ModelFailure('server', 'Model request failed.', true, { status: 503 }),
    { text: 'ok', toolCalls: [] },
  ]);
  const recorded: ModelAttemptEvent[] = [];
  const model = new RetryingChatModel(inner, {
    maxRetries: 2, maxDelayMs: 2_000, sleep: async () => undefined, random: () => 0,
    observer: { record: (event) => { recorded.push(event); } },
  });
  const { result } = await drain(model.stream([], [], callOptions()));
  expect(result.text).toBe('ok');
  expect(inner.callCount).toBe(2);
  expect(recorded.map((event) => event.type)).toEqual(['started', 'retry_scheduled', 'started', 'succeeded']);
});

it('does not retry after yielding visible text', async () => {
  const inner: ChatModel = { async *stream() {
    yield { type: 'text_delta', delta: 'partial' };
    throw new ModelFailure('network', 'Stream interrupted.', true);
  } };
  const model = new RetryingChatModel(inner, deterministicRetryOptions());
  const stream = model.stream([], [], callOptions());
  expect(await stream.next()).toEqual({ done: false, value: { type: 'text_delta', delta: 'partial' } });
  await expect(stream.next()).rejects.toMatchObject({ details: { category: 'network', attempts: 1 } });
});
```

以 `it.each` 固定矩阵：rate_limit/server/network/连接或首字节 timeout 可重试；auth/context_length/protocol/aborted/output_truncated 不重试；maxRetries=2 总尝试为 3；Retry-After=2000 可等待；Retry-After=2001 直接失败；父 Abort 终止 backoff；所有尝试收到同一个 messages/tools 对象引用。

- [ ] **Step 2: 运行重试测试确认失败**

Run: `pnpm vitest run test/retrying-model.test.ts`

Expected: FAIL，`RetryingChatModel` 尚不存在。

- [ ] **Step 3: 实现只包裹 ChatModel 的重试循环**

```ts
export interface RetryingModelOptions {
  maxRetries?: number;
  maxDelayMs?: number;
  baseDelayMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  observer?: ModelAttemptObserver;
}

export class RetryingChatModel implements ChatModel {
  public constructor(private readonly inner: ChatModel, options: RetryingModelOptions = {});
  public async *stream(messages: AgentMessage[], tools: Tool[], options: ModelCallOptions) {
    let emittedText = false;
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      await this.observer.record({ type: 'started', runId: options.runId, stepId: options.stepId, attempt });
      try {
        const stream = this.inner.stream(messages, tools, options);
        while (true) {
          const item = await stream.next();
          if (item.done) {
            await this.observer.record({ type: 'succeeded', runId: options.runId, stepId: options.stepId, attempt, usage: item.value.usage });
            return item.value;
          }
          if (item.value.type === 'text_delta') emittedText = true;
          yield item.value;
        }
      } catch (error) {
        const failure = asModelFailure(error, attempt);
        if (emittedText || !canRetry(failure, attempt, this.maxRetries)) {
          await this.observer.record({ type: 'failed', runId: options.runId, stepId: options.stepId, attempt, category: failure.details.category as ModelFailureCategory, retryable: failure.retryable });
          throw withAttempts(failure, attempt);
        }
        const delayMs = retryDelay(failure, attempt, this.baseDelayMs, this.maxDelayMs, this.random);
        await this.observer.record({ type: 'retry_scheduled', runId: options.runId, stepId: options.stepId, attempt, category: failure.details.category as ModelFailureCategory, delayMs });
        await this.sleep(delayMs, options.signal);
      }
    }
    throw new ModelFailure('protocol', 'Retry loop ended unexpectedly.', false);
  }
}
```

`retryDelay` 对服务端 Retry-After 超过 `maxDelayMs` 的情况抛原失败，不截断后提前请求。Transport 把 fetch `TypeError` 归为 network；其他未知异常规范化为不可重试的 `ModelFailure('protocol', 'Model request failed.', false)`，不得把原错误正文放入 details。timeout 只有 `details.phase` 为 `connect` 或 `first_byte` 时可重试，`idle`、`overall` 和 `run_deadline` 不重试。observer 是审计边界，异常向上传播并使 Run 失败，避免在没有任何记录的情况下静默继续。

- [ ] **Step 4: 运行重试和 transport 测试**

Run: `pnpm vitest run test/retrying-model.test.ts test/openai-model-http.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交重试装饰器**

```bash
git add src/model/retrying-model.ts test/retrying-model.test.ts
git commit -m "feat: add observable bounded model retries"
```

---

### Task 8: 组装 DeepSeek 配置并完成 Harness 闭环验收

**Files:**
- Create: `src/bootstrap/deepseek-model.ts`
- Modify: `src/index.ts`
- Create: `test/openai-harness.integration.test.ts`
- Create: `docs/architecture/15-openai-compatible-model.md`
- Modify: `docs/implementation-status.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: `OpenAICompatibleChatModel`、`RetryingChatModel`、可选 `ModelAttemptObserver`、现有 `createReadonlyInspectionRuntime`/MCP fixture。
- Produces: `createDeepSeekChatModel(config): ChatModel`；包公开导出和端到端协议验收。

- [ ] **Step 1: 写组合工厂和两轮 Harness 集成测试**

```ts
it('runs raw model tool calls through admission, MCP and evidence storage', async () => {
  const modelServer = await startSequenceSseServer([
    [
      data({ choices: [{ index: 0, delta: { content: '我先查结算指标。' } }] }),
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tc-1', function: {
        name: 'metrics.settlement', arguments: '{"window":"5m"}',
      } }] }, finish_reason: 'tool_calls' }] }),
      done(),
    ],
    [
      data({ choices: [{ index: 0, delta: { content: '失败率已超过阈值。' }, finish_reason: 'stop' }] }),
      done(),
    ],
  ]);
  const runtime = await createReadonlyInspectionRuntime({
    model: createDeepSeekChatModel({ baseUrl: modelServer.url, apiKey: 'test', model: 'deepseek-chat' }),
    metricsMcpUrl: metricsServer.url,
  });
  const result = await runtime.agent.reply({ message: '检查结算失败率', profileId: 'group-buy-market' });
  expect(result).toMatchObject({ status: 'completed', finalText: '我先查结算指标。失败率已超过阈值。' });
  expect(await runtime.evidenceStore.get('ev-1')).toMatchObject({ source: 'prometheus' });
  expect(modelServer.requests[1].messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'assistant', content: '我先查结算指标。' }),
    expect.objectContaining({ role: 'tool', tool_call_id: 'tc-1' }),
  ]));
});
```

工厂测试断言默认 baseUrl=`https://api.deepseek.com`、model=`deepseek-chat`、重试包装存在；apiKey 为空立即抛配置错误，且错误不含 key 值。

- [ ] **Step 2: 运行闭环测试确认失败**

Run: `pnpm vitest run test/openai-harness.integration.test.ts`

Expected: FAIL，DeepSeek 组合工厂和公开导出尚不存在。

- [ ] **Step 3: 实现显式配置工厂和公开导出**

```ts
export interface DeepSeekModelConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  observer?: ModelAttemptObserver;
  fetch?: typeof fetch;
}

export function createDeepSeekChatModel(config: DeepSeekModelConfig): ChatModel {
  if (config.apiKey.trim().length === 0) throw new Error('DeepSeek API key is required.');
  const transport = new OpenAICompatibleChatModel({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? 'https://api.deepseek.com',
    model: config.model ?? 'deepseek-chat',
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
  return new RetryingChatModel(transport, {
    ...(config.observer === undefined ? {} : { observer: config.observer }),
  });
}
```

从 `src/index.ts` 导出工厂、adapter、retry decorator、错误和 observer 类型，不导出 wire 内部类型。

- [ ] **Step 4: 写实现文档并明确未验证项**

`docs/architecture/15-openai-compatible-model.md` 必须记录：模块边界、请求映射、ToolResult 白名单、SSE/DONE 规则、timeout/deadline、retry matrix、attempt observer、环境组装示例，以及“本地协议已验收；真实 DeepSeek API 未验收”。`docs/implementation-status.md` 将模型能力标为“本地协议完成/线上待密钥验收”，`docs/README.md` 增加索引。

- [ ] **Step 5: 运行模型子系统和全量质量门**

Run: `pnpm vitest run test/model-harness-contract.test.ts test/openai-formatter.test.ts test/openai-sse.test.ts test/openai-assembler.test.ts test/openai-model-http.test.ts test/retrying-model.test.ts test/openai-harness.integration.test.ts`

Expected: 所有模型相关测试 PASS。

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

Expected: 四条命令退出码均为 0；测试进程无悬挂 server/timer；构建不新增运行时依赖。

- [ ] **Step 6: 检查 secrets 和变更范围**

Run: `rg -n "sk-[A-Za-z0-9]|apiKey\s*[:=]\s*['\"][^'\"]+" src test docs --glob '!docs/superpowers/plans/2026-09-06-openai-compatible-model.md'`

Expected: 不出现真实密钥；测试中仅有明确的 `test-key`/`test` 假值。

Run: `git status --short`

Expected: 只包含本计划文件表中的目标改动和执行前已经存在的用户改动；不得纳入 `.workbuddy/` 或其他无关文件。

- [ ] **Step 7: 提交组合、验收和文档**

```bash
git add src/bootstrap/deepseek-model.ts src/index.ts test/openai-harness.integration.test.ts docs/architecture/15-openai-compatible-model.md docs/implementation-status.md docs/README.md
git commit -m "feat: integrate deepseek compatible model runtime"
```

---

## Review Gates

每个任务提交前，reviewer 必须确认：

1. 核心 `agent/` 没有引入具体 HTTP、DeepSeek、LangSmith 或环境变量依赖。
2. adapter 内没有重试，retry decorator 内没有 HTTP/SSE 解析。
3. 任何失败路径都不会把部分文本误标为成功；`length` 绝不返回完成结果。
4. 给模型的 ToolResult 保留四道闸门纠错字段，同时排除任意非白名单 details。
5. 所有 timeout、Abort、retry 和 observer 测试使用可控时钟/等待器或本地 server，不依赖公网和真实时间长等待。
6. 成功重试和最终失败均有尝试级审计；前端公共 EventType 未被顺手扩充。
7. 真实 DeepSeek 未在线测试时，文档不得写成“DeepSeek 已验证”。

## Deferred Follow-ups

以下内容明确不属于本计划，不得在实现中顺手加入：多模型 fallback、compact model、reasoning_content、JSON response_format、图片输入、Prompt/Renderer 策略、模型发现、真实 DeepSeek 在线 smoke test。它们应在本增量稳定后分别形成设计决策和独立计划。
