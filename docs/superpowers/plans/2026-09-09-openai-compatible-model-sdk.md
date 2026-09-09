# OpenAI-compatible Model Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a production-boundary OpenAI-compatible streaming `ChatModel`, with DeepSeek as the first configuration target, while preserving the existing Agent Harness, four-gate tool admission, Event/Message V2, retry and LangSmith observability contracts.

**Architecture:** The adapter is composed as `OpenAICompatibleChatModel -> RetryingChatModel -> EventedChatModel -> AgentHarness`. The official `openai` package owns HTTP/SSE framing and `[DONE]` handling inside `src/model/openai-compatible/client.ts`; project-owned formatter, assembler and error classifier keep provider types out of the core contracts, preserve raw tool arguments, validate finish/usage, and expose only safe structured failures. The existing retry decorator remains the single retry authority and will honor terminal, fallback-only, retryable and aborted dispositions.

**Tech Stack:** TypeScript, Node.js 20, pnpm, `openai`, Zod 3, `zod-to-json-schema`, Vitest, existing Event/Message V2 and LangSmith projector.

**Spec:** `docs/superpowers/specs/2026-09-06-openai-compatible-model-design.md`

## Global Constraints

- Use the existing `ChatModel` AsyncGenerator contract; do not add a second Agent loop or a public tool-argument-delta event.
- Keep `openai` SDK imports inside `src/model/openai-compatible`; `contracts`, `agent`, `tool`, and `event` must not import SDK types.
- Use the existing `toolInputJsonSchema()` from `src/tool/schema.ts`; do not introduce a second Zod-to-JSON-Schema conversion path.
- Return incomplete or invalid model protocol as structured `MODEL_ERROR`; never silently convert malformed tool arguments into `{}`.
- Preserve the full raw arguments string in `RawToolCall`; four-gate admission remains responsible for parse repair, schema validation, and semantic validation.
- The SDK must use `maxRetries: 0`; `RetryingChatModel` is the only retry authority.
- First version enforces the parent `AbortSignal` and absolute `ModelCallOptions.deadline`; it does not add first-byte or idle timers.
- API keys, request bodies, response bodies, internal URLs, customer data and raw evidence must not enter events, errors, checkpoints or model messages.
- All new fields are optional and additive; no existing EventType, message block, ToolResponse or SQLite schema is removed or renamed.
- Before completion run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Changes are scoped to `D:\agentops\.worktrees\event-message-v2`; do not modify `D:\xfg\group-buy-market`.

## File Map

Create:

- `src/model/openai-compatible/types.ts` — provider-neutral wire request/chunk types used between formatter, client and assembler.
- `src/model/openai-compatible/formatter.ts` — deterministic `AgentMessage`/`Tool` to Chat Completions conversion and safe ToolResult rendering.
- `src/model/openai-compatible/assembler.ts` — text/tool/usage/finish aggregation and protocol validation.
- `src/model/openai-compatible/client.ts` — sole `openai` SDK boundary, injected fetch/headers, successful response content-type and byte-limit enforcement.
- `src/model/openai-compatible/error-classifier.ts` — SDK/HTTP/Abort errors to sanitized `ModelFailure` with four dispositions.
- `src/model/openai-compatible/model.ts` — transport-only `ChatModel` AsyncGenerator implementation.
- `src/model/openai-compatible/index.ts` — public adapter exports without SDK types.
- `test/openai-compatible-formatter.test.ts` — pure request mapping and safe rendering tests.
- `test/openai-compatible-assembler.test.ts` — interleaved delta and finish/usage tests.
- `test/openai-compatible-client.test.ts` — local HTTP/SSE client contract tests.
- `test/openai-compatible-error-classifier.test.ts` — four-disposition error and retry policy tests.
- `test/openai-compatible-model.test.ts` — adapter cancellation, deadline and raw-call tests.

Modify:

- `package.json`, `pnpm-lock.yaml` — add the `openai` runtime dependency.
- `src/contracts/model.ts` — add optional `ModelUsage.cachedInputTokens` and `ModelResponse.finishReason`.
- `src/contracts/event-v2/lifecycle.ts` — add optional cached input usage to V2 schemas.
- `src/model/model-failure.ts` — add structured disposition and fallback eligibility without changing `AgentError.code`.
- `src/model/retrying-model.ts` — prevent fallback for terminal/aborted failures and cap Retry-After-derived waits.
- `src/model/evented-model.ts` — forward finish reason and derive cache hit from cached input usage.
- `src/index.ts` — export the adapter public entry point.
- `src/bootstrap/index.ts` — export the production adapter factory.
- `src/bootstrap/openai-compatible.ts` — parse explicit adapter options and compose the client/model boundary.
- `docs/implementation-status.md`, `docs/README.md` — record local protocol completion and remaining real-provider validation.

## Task 1: Add the SDK dependency and lock the public model/usage contracts

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`
- Modify: `src/contracts/model.ts`
- Modify: `src/contracts/event-v2/lifecycle.ts`
- Test: `test/model-events-v2.test.ts`, `test/event-v2-lifecycle.test.ts`

**Interfaces:**

- Produces `ModelUsage`, `ModelResponse.finishReason?: string`, and `UsagePayloadV2.cachedInputTokens?: number`.
- Keeps `ModelStreamEvent` unchanged; no partial tool-call event is added.

- [ ] **Step 1: Write the failing contract assertions**

Add assertions that a model result can carry `finishReason: 'tool_calls'` and `usage.cachedInputTokens`, and that V2 `MODEL_CALL_COMPLETED` and `MESSAGE_COMPLETED` accept the optional cached field while old payloads still parse.

```ts
expect(parseEventV2Payload('MODEL_CALL_COMPLETED', {
  provider: 'openai-compatible', model: 'test', attempt: 1,
  usage: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 12 },
  durationMs: 10, finishReason: 'stop',
})).toMatchObject({ usage: { cachedInputTokens: 12 }, finishReason: 'stop' });
expect(parseEventV2Payload('MESSAGE_COMPLETED', {
  messageId: 'message-1', completedAt: '2026-09-09T00:00:00.000Z',
  usage: { cachedInputTokens: 12 },
})).toMatchObject({ usage: { cachedInputTokens: 12 } });
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm test -- test/model-events-v2.test.ts test/event-v2-lifecycle.test.ts`

Expected: FAIL because the usage schemas and `ModelResponse` type do not yet accept `cachedInputTokens`/`finishReason`.

- [ ] **Step 3: Add the additive types and schemas**

Define one exported `ModelUsage` interface in `src/contracts/model.ts` and use it in `ModelResponse` and the usage stream event. Add optional `cachedInputTokens` to V2 usage schema/interface. Add optional `finishReason` to `ModelResponse`; do not alter the `ModelStreamEvent` union or any existing required field.

- [ ] **Step 4: Install and lock the SDK**

Run: `pnpm add openai`

Expected: `package.json` contains a runtime `openai` dependency and `pnpm-lock.yaml` records its resolved package graph.

- [ ] **Step 5: Run the focused tests and typecheck**

Run: `pnpm test -- test/model-events-v2.test.ts test/event-v2-lifecycle.test.ts` and `pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the contract baseline**

```bash
git add package.json pnpm-lock.yaml src/contracts/model.ts src/contracts/event-v2/lifecycle.ts test/model-events-v2.test.ts test/event-v2-lifecycle.test.ts
git commit -m "feat: extend model usage contract"
```

## Task 2: Implement deterministic OpenAI request formatting

**Files:**

- Create: `src/model/openai-compatible/types.ts`
- Create: `src/model/openai-compatible/formatter.ts`
- Test: `test/openai-compatible-formatter.test.ts`

**Interfaces:**

```ts
export interface OpenAICompatibleRequest {
  model: string;
  messages: readonly OpenAICompatibleMessage[];
  stream: true;
  stream_options?: { include_usage: true };
  tools?: readonly OpenAICompatibleTool[];
}

export function formatChatRequest(
  messages: readonly AgentMessage[],
  tools: readonly Tool[],
  options: { model: string; includeUsage: boolean },
): OpenAICompatibleRequest;

export function renderToolResultForModel(result: ToolExecutionResult): string;
```

- [ ] **Step 1: Write failing formatter tests**

Cover system/user/assistant/tool role conversion, stable key ordering, raw arguments byte-for-byte preservation, multiple tool results, optional tools/usage, tool schema conversion through `toolInputJsonSchema`, and removal of metadata/artifact URI/internal error details from model-facing tool results.

```ts
it('keeps intermediately malformed raw arguments unchanged', () => {
  const request = formatChatRequest([{
    id: 'assistant-1', role: 'assistant', createdAt: '2026-09-09T00:00:00.000Z',
    blocks: [{ type: 'raw_tool_call', call: { id: 'tc-1', name: 'metrics.query', arguments: '{"window":}' } }],
  }], [], { model: 'deepseek-chat', includeUsage: true });
  expect(request.messages[0]).toMatchObject({ role: 'assistant', tool_calls: [{ function: { arguments: '{"window":}' } }] });
});
```

- [ ] **Step 2: Run the formatter test to verify failure**

Run: `pnpm test -- test/openai-compatible-formatter.test.ts`

Expected: FAIL because the formatter module does not exist.

- [ ] **Step 3: Add provider-neutral wire types and deterministic helpers**

Model the supported Chat Completions request/message/tool shapes locally. Implement recursive stable JSON serialization with sorted object keys and preserve arrays. Reject unsupported roles, missing tool-call IDs, isolated tool results, and non-finite values with a protocol `ModelFailure` before a network request.

- [ ] **Step 4: Implement the message mapping**

Concatenate text blocks with newlines; append `context_summary` as stable JSON; map assistant `tool_call` input using stable JSON; map assistant `raw_tool_call` arguments without parse/restringify; emit one `tool` message per `tool_result` using its `toolCallId`. Use `content: ''` for assistant tool-call-only messages.

- [ ] **Step 5: Implement the safe ToolResult projection**

Project only `status`, safe `text`/`json`, `evidence_ref`, and allowlisted correction fields (`error.code`, safe `error.message`, `gate`, `reason`, `retryableByModel`, `expectedSchema`, `issues`, `correctionChainId`, `remainingModelRetries`). Do not include `metadata`, artifact URI, local path, arbitrary infrastructure details or raw evidence text.

- [ ] **Step 6: Implement tool schema mapping**

Call `toolInputJsonSchema(tool)` once per registered tool and emit `{ type: 'function', function: { name, description, parameters } }` in the given Toolkit order. Omit `tools` when the input list is empty and omit `stream_options` when `includeUsage` is false.

- [ ] **Step 7: Run formatter tests and lint**

Run: `pnpm test -- test/openai-compatible-formatter.test.ts` and `pnpm lint`

Expected: PASS with no `any` or unsafe provider data leakage.

- [ ] **Step 8: Commit the formatter**

```bash
git add src/model/openai-compatible/types.ts src/model/openai-compatible/formatter.ts test/openai-compatible-formatter.test.ts
git commit -m "feat: format openai-compatible model requests"
```

## Task 3: Implement stream assembly with interleaved tool-call support

**Files:**

- Modify: `src/model/openai-compatible/types.ts`
- Create: `src/model/openai-compatible/assembler.ts`
- Test: `test/openai-compatible-assembler.test.ts`

**Interfaces:**

```ts
export interface OpenAICompatibleChoice {
  index: number;
  delta?: {
    content?: string | null;
    tool_calls?: readonly OpenAICompatibleToolCallDelta[];
  };
  finish_reason?: string | null;
}

export interface OpenAICompatibleToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAICompatibleUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
}

export interface OpenAICompatibleStreamChunk {
  choices: readonly OpenAICompatibleChoice[];
  usage?: OpenAICompatibleUsage | null;
}

export class OpenAIStreamAssembler {
  public accept(chunk: OpenAICompatibleStreamChunk): ModelStreamEvent[];
  public finish(): ModelResponse;
}
```

- [ ] **Step 1: Write failing assembler tests**

Cover text deltas, two tool calls whose argument fragments arrive in alternating index order, same-index fragments, usage-only chunks, `prompt_tokens_details.cached_tokens`, missing identity, multiple choices, conflicting identity, `length`, unknown finish reason, and empty response.

```ts
it('does not cross-contaminate interleaved tool arguments', () => {
  const assembler = new OpenAIStreamAssembler();
  assembler.accept({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tc-0', type: 'function', function: { name: 'a', arguments: '{"x":' } }, { index: 1, id: 'tc-1', type: 'function', function: { name: 'b', arguments: '{"y":' } }] } }] });
  assembler.accept({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }, { index: 0, function: { arguments: '1}' } }] } }] });
  assembler.accept({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] });
  expect(assembler.finish().rawToolCalls).toEqual([
    { id: 'tc-0', name: 'a', arguments: '{"x":1}' },
    { id: 'tc-1', name: 'b', arguments: '{"y":2}' },
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm test -- test/openai-compatible-assembler.test.ts`

Expected: FAIL because the assembler does not exist.

- [ ] **Step 3: Implement chunk validation and text output**

Accept only choice index `0`; reject more than one choice in a chunk. Emit `text_delta` only for non-empty content and track whether text or tool output was observed. Permit usage-only chunks after a finish chunk.

- [ ] **Step 4: Implement indexed tool aggregation**

Use a map keyed by `(choice.index, tool_call.index)`. Append only string argument fragments, preserve first non-empty ID/name, reject conflicting non-empty identity updates, and sort final calls by wire index. Never parse arguments in the assembler.

- [ ] **Step 5: Implement usage and finish validation**

Validate non-negative safe integer token counts, retain the last valid usage, map cached tokens, require `stop` or `tool_calls`, map `length` to retryable `false` `output_truncated`, reject unknown reasons and empty output, and return `ModelResponse` with `toolCalls: []`, `rawToolCalls`, `usage`, and `finishReason`.

- [ ] **Step 6: Run assembler tests**

Run: `pnpm test -- test/openai-compatible-assembler.test.ts`

Expected: PASS, including the alternating-index case.

- [ ] **Step 7: Commit the assembler**

```bash
git add src/model/openai-compatible/types.ts src/model/openai-compatible/assembler.ts test/openai-compatible-assembler.test.ts
git commit -m "feat: assemble streamed model tool calls"
```

## Task 4: Add sanitized four-disposition error handling and retry semantics

**Files:**

- Modify: `src/model/model-failure.ts`
- Modify: `src/model/retrying-model.ts`
- Create: `src/model/openai-compatible/error-classifier.ts`
- Modify: `src/model/model-attempt-observer.ts` if the usage type requires it
- Create: `test/openai-compatible-error-classifier.test.ts`
- Modify: `test/retrying-chat-model.test.ts`

**Interfaces:**

```ts
export type ModelFailureDisposition = 'retryable' | 'fallback_only' | 'terminal' | 'aborted';

export interface ModelFailureOptions { disposition?: ModelFailureDisposition }

export function classifyOpenAICompatibleError(
  error: unknown,
  options?: { transientForbiddenCodes?: readonly string[]; quotaCodes?: readonly string[] },
): ModelFailure;
```

- [ ] **Step 1: Write failing disposition tests**

In `test/openai-compatible-error-classifier.test.ts`, assert 402 and configured quota 429 are terminal and do not invoke fallback; 401/400 and non-transient 403 are fallback-only; ordinary 429/5xx/network errors are retryable; configured transient 403 is retryable; AbortError and an already-aborted signal are aborted and do not retry or fallback. In `test/retrying-chat-model.test.ts`, assert a Retry-After value above 2 seconds does not cause a pre-request wait.

- [ ] **Step 2: Run retry tests and verify failure**

Run: `pnpm test -- test/retrying-chat-model.test.ts test/openai-compatible-error-classifier.test.ts`

Expected: FAIL because disposition and classifier behavior are not implemented.

- [ ] **Step 3: Extend `ModelFailure` without breaking `AgentError`**

Add a disposition option with defaults that preserve current callers: retryable failures default to `retryable`, aborted failures to `aborted`, and other failures to `fallback_only`. Expose `fallbackAllowed` as a derived property and sanitize only category, disposition, status, attempts, retryAfterMs and phase into `details`.

- [ ] **Step 4: Implement provider error extraction and classification**

Read only status, code, type, retry-after and safe error names from SDK/API errors. Use status plus allowlisted provider codes: 402 and quota codes are terminal; 401/400 are fallback-only; 403 is retryable only when its code/type is in `transientForbiddenCodes`, otherwise fallback-only; ordinary 429 and 5xx are retryable; network errors are retryable; AbortError and caller/deadline cancellation are aborted. Never copy response body or error message into `details`.

- [ ] **Step 5: Update `RetryingChatModel`**

Check `failure.fallbackAllowed` before invoking fallback. Use `details.retryAfterMs` when choosing a delay, cap the delay at 2,000 ms, and skip retry scheduling when the provider explicitly asks for a longer wait. Preserve the existing rule that any exposed stream item prevents transparent retry.

- [ ] **Step 6: Run all retry/error tests**

Run: `pnpm test -- test/retrying-chat-model.test.ts test/openai-compatible-error-classifier.test.ts` and `pnpm typecheck`

Expected: PASS and existing fallback tests remain green.

- [ ] **Step 7: Commit error semantics**

```bash
git add src/model/model-failure.ts src/model/retrying-model.ts src/model/openai-compatible/error-classifier.ts src/model/model-attempt-observer.ts test/retrying-chat-model.test.ts test/openai-compatible-model.test.ts
git commit -m "feat: classify model failures for bounded retry"
```

## Task 5: Wrap the OpenAI SDK with injected transport and response boundaries

**Files:**

- Create: `src/model/openai-compatible/client.ts`
- Modify: `src/model/openai-compatible/types.ts`
- Create: `test/openai-compatible-client.test.ts`

**Interfaces:**

```ts
export interface OpenAICompatibleClient {
  stream(
    request: OpenAICompatibleRequest,
    options: { signal: AbortSignal; requestContext?: { runId?: string; stepId?: string } },
  ): AsyncIterable<OpenAICompatibleStreamChunk>;
}

export interface OpenAICompatibleClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  requestHeaders?: (input: { runId?: string; stepId?: string }) => HeadersInit;
}

export function createOpenAICompatibleClient(options: OpenAICompatibleClientOptions): OpenAICompatibleClient;
```

- [ ] **Step 1: Write failing local-server client tests**

Start a Node `http.createServer` in the test and assert normalized URL path, JSON request body, bearer authentication, injected trace headers, successful `text/event-stream` validation, non-SSE content-type rejection, response byte limit, and SDK `maxRetries: 0` behavior through a request-count assertion.

- [ ] **Step 2: Run the client tests and verify failure**

Run: `pnpm test -- test/openai-compatible-client.test.ts`

Expected: FAIL because the client module does not exist and the SDK dependency is not wired.

- [ ] **Step 3: Implement the SDK boundary**

Construct `OpenAI` with normalized `baseURL`, `apiKey`, injected fetch, and `maxRetries: 0`. Call `chat.completions.create()` with the formatted streaming request and pass the caller signal/request headers. Convert SDK chunks into local `OpenAICompatibleStreamChunk` values so SDK types do not cross the adapter boundary.

- [ ] **Step 4: Implement safe fetch wrapping**

For successful responses require a `content-type` beginning with `text/event-stream`; allow non-2xx responses through to the SDK error path for classification. Wrap the response body with a byte-counting stream and fail with sanitized protocol `ModelFailure` after `maxResponseBytes`. Do not read or retain full response bodies.

- [ ] **Step 5: Implement URL and credential validation**

Allow only `http:` and `https:` URLs without username, password, query or fragment. Remove only trailing slashes so path prefixes such as `/v1` remain. Reject blank API keys at construction without including the key in the error.

- [ ] **Step 6: Run client tests and lint**

Run: `pnpm test -- test/openai-compatible-client.test.ts` and `pnpm lint`

Expected: PASS.

- [ ] **Step 7: Commit the client boundary**

```bash
git add src/model/openai-compatible/client.ts src/model/openai-compatible/types.ts test/openai-compatible-client.test.ts
git commit -m "feat: add openai-compatible streaming client"
```

## Task 6: Implement the transport-only `ChatModel` AsyncGenerator

**Files:**

- Create: `src/model/openai-compatible/model.ts`
- Create: `src/model/openai-compatible/index.ts`
- Create: `test/openai-compatible-model.test.ts`

**Interfaces:**

```ts
export interface OpenAICompatibleChatModelOptions {
  model: string;
  includeUsage?: boolean;
}

export class OpenAICompatibleChatModel implements ChatModel {
  public constructor(
    client: OpenAICompatibleClient,
    options: OpenAICompatibleChatModelOptions,
  );

  public stream(
    messages: AgentMessage[], tools: Tool[], options: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse>;
}
```

- [ ] **Step 1: Write failing adapter tests**

Use a fake injected client to test text streaming, raw tool-call return, `finishReason`, usage, deadline propagation, already-expired deadline without a client call, parent AbortSignal, consumer `return()` calling the upstream iterator’s `return`, and error classification after no output versus after a visible text delta.

```ts
it('returns raw tool calls and exposes only text deltas', async () => {
  const client = fakeClient([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tc-1', type: 'function', function: { name: 'metrics.query', arguments: '{"window":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"5m"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const result = await drainModel(new OpenAICompatibleChatModel(client, { model: 'test' }).stream([], [], callOptions()));
  expect(result.events).toEqual([]);
  expect(result.returnValue.rawToolCalls).toEqual([{ id: 'tc-1', name: 'metrics.query', arguments: '{"window":"5m"}' }]);
});

async function drainModel(stream: AsyncGenerator<ModelStreamEvent, ModelResponse>) {
  const events: ModelStreamEvent[] = [];
  while (true) {
    const item = await stream.next();
    if (item.done) return { events, returnValue: item.value };
    events.push(item.value);
  }
}

function callOptions(): ModelCallOptions {
  return { runId: 'run-1', stepId: 'step-1', signal: new AbortController().signal };
}

function fakeClient(chunks: readonly OpenAICompatibleStreamChunk[]): OpenAICompatibleClient {
  return { async *stream() { for (const chunk of chunks) yield chunk; } };
}
```

- [ ] **Step 2: Run adapter tests and verify failure**

Run: `pnpm test -- test/openai-compatible-model.test.ts`

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement request/deadline setup**

Format messages/tools once before network access. If `deadline` is present and not in the future, throw an aborted/deadline `ModelFailure` without calling the client. Otherwise combine the parent signal with one absolute-deadline controller and clear its timer in `finally`.

- [ ] **Step 4: Implement streaming delegation**

Call `client.stream()` with the formatted request, combined signal, and `{ runId: options.runId, stepId: options.stepId }` request context. For every chunk, pass it to `OpenAIStreamAssembler.accept()` and yield only returned text events. On normal completion return `assembler.finish()`. In `finally`, call `upstream.return?.()` and clear deadline resources so consumer cancellation closes the upstream stream.

- [ ] **Step 5: Implement error normalization**

Preserve existing `ModelFailure` instances; otherwise call `classifyOpenAICompatibleError`. If the caller signal or deadline is the cause, return disposition `aborted`. Do not wrap an already-yielded error in a retryable stream that could replay visible text.

- [ ] **Step 6: Run adapter tests and typecheck**

Run: `pnpm test -- test/openai-compatible-model.test.ts` and `pnpm typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the ChatModel adapter**

```bash
git add src/model/openai-compatible/model.ts src/model/openai-compatible/index.ts test/openai-compatible-model.test.ts
git commit -m "feat: implement openai-compatible chat model"
```

## Task 7: Complete V2 observability and runtime/bootstrap composition

**Files:**

- Modify: `src/model/evented-model.ts`
- Create: `src/bootstrap/openai-compatible.ts`
- Modify: `src/bootstrap/index.ts`, `src/index.ts`
- Modify: `test/model-events-v2.test.ts`
- Create: `test/openai-compatible-runtime.test.ts`

**Interfaces:**

```ts
export interface CreateOpenAICompatibleModelOptions extends OpenAICompatibleClientOptions {
  model: string;
  includeUsage?: boolean;
}

export function createOpenAICompatibleModel(
  options: CreateOpenAICompatibleModelOptions,
): ChatModel;
```

- [ ] **Step 1: Write failing V2 projection/runtime tests**

Assert that `EventedChatModel` includes `finishReason`, `cachedInputTokens`, and `cacheHit: true` when cached input tokens are positive. Assert the bootstrap factory can build a model against a local server while `createAgentRuntime` remains dependency-injected and the Harness receives the same raw tool calls.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm test -- test/model-events-v2.test.ts test/openai-compatible-runtime.test.ts`

Expected: FAIL because EventedChatModel does not forward the new fields and the bootstrap factory does not exist.

- [ ] **Step 3: Update EventedChatModel**

Pass `finishReason` to `MODEL_CALL_COMPLETED`; pass the expanded usage to model/message completion events; derive `cacheHit` only from `cachedInputTokens > 0`, without guessing when the field is absent. Keep event ordering unchanged.

- [ ] **Step 4: Add the bootstrap factory**

Validate explicit options, call `createOpenAICompatibleClient`, and return `OpenAICompatibleChatModel`. Do not read environment variables inside the adapter; an application may read environment variables before calling this factory. Use `provider: 'openai-compatible'` and the configured model when composing `createAgentRuntime` outside this helper.

- [ ] **Step 5: Export only project contracts and adapter types**

Export `OpenAICompatibleChatModel`, its option types, `createOpenAICompatibleClient`, `createOpenAICompatibleModel`, formatter and assembler public functions. Do not export OpenAI SDK classes or SDK-specific error types.

- [ ] **Step 6: Run focused tests**

Run: `pnpm test -- test/model-events-v2.test.ts test/openai-compatible-runtime.test.ts` and `pnpm typecheck`

Expected: PASS, with existing V2 event order tests unchanged.

- [ ] **Step 7: Commit runtime composition**

```bash
git add src/model/evented-model.ts src/bootstrap/openai-compatible.ts src/bootstrap/index.ts src/index.ts test/model-events-v2.test.ts test/openai-compatible-runtime.test.ts
git commit -m "feat: compose openai-compatible model runtime"
```

## Task 8: Run the real local HTTP integration matrix and update status documentation

**Files:**

- Modify: `test/openai-compatible-client.test.ts`, `test/openai-compatible-model.test.ts`, `test/openai-compatible-runtime.test.ts`
- Modify: `docs/implementation-status.md`, `docs/README.md`

- [ ] **Step 1: Add the local HTTP matrix**

Use one local server fixture with deterministic responses for text, interleaved tool calls, usage-only tail chunks, invalid/empty output, missing DONE, malformed content type, 400, 401, 402, quota 429, ordinary 429, conditional 403, 503, network close, Retry-After and delayed cancellation. Assert request count, error category/disposition, raw argument preservation, V2 usage and LangSmith attempt identity.

- [ ] **Step 2: Add the Harness two-turn scenario**

Return a first response with a `metrics.settlement` function call and a second response with a natural-language diagnosis. Assert the four admission gates receive the raw arguments, the tool result is included in the second request, `TEXT_DELTA` and V2 model/message events retain their existing order, and no adapter-specific event bypasses the Evented layer.

- [ ] **Step 3: Run the focused integration suite**

Run: `pnpm test -- test/openai-compatible-client.test.ts test/openai-compatible-assembler.test.ts test/openai-compatible-model.test.ts test/openai-compatible-runtime.test.ts test/retrying-chat-model.test.ts`

Expected: PASS without contacting a real provider.

- [ ] **Step 4: Update implementation status**

Record “OpenAI-compatible local protocol adapter implemented and locally verified”; explicitly state that no real DeepSeek credential/API acceptance was performed. Record that images, reasoning content, model discovery and provider-specific extensions remain out of scope.

- [ ] **Step 5: Run the complete required checks**

Run:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands exit 0; report any environment-gated Prometheus test separately.

- [ ] **Step 6: Commit the verified implementation and docs**

```bash
git add test/openai-compatible-client.test.ts test/openai-compatible-assembler.test.ts test/openai-compatible-model.test.ts test/openai-compatible-runtime.test.ts docs/implementation-status.md docs/README.md
git commit -m "feat: verify openai-compatible model adapter"
```

## Task 9: Push and perform the requested shutdown

**Files:**

- No source changes; verify the complete worktree.

- [ ] **Step 1: Verify branch and worktree**

Run: `git status --short --branch` and `git log -1 --oneline`

Expected: clean `codex/event-message-v2` worktree with the final implementation commit at `HEAD`.

- [ ] **Step 2: Push the exact branch**

Run: `git push origin codex/event-message-v2`

Expected: remote `origin/codex/event-message-v2` advances to the final verified commit; do not push directly to `main`.

- [ ] **Step 3: Verify remote synchronization**

Run: `git status --short --branch`

Expected: no `[ahead N]` or `[behind N]` marker.

- [ ] **Step 4: Schedule immediate Windows shutdown after the push result is recorded**

Run: `shutdown.exe /s /t 15 /c "opsangent implementation and GitHub push completed"`

Expected: Windows reports shutdown scheduled in 15 seconds, leaving enough time for the final user-facing handoff. This is executed only after all checks and push synchronization succeed.
