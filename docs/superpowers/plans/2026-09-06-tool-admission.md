# Tool admission implementation plan

**Goal:** Four-gate admission and bounded LLM correction integrated into the Harness.

**Spec:** ../../architecture/04-tool-system.md

**Architecture:** RawToolCall is separate from normalized ToolCall. Deterministic admission owns parsing, strict schema and semantic checks. Harness owns persisted correction limits. Pipeline uses normalized input for Guard. Batch execution isolates errors and preserves original order.

**Constraints:** Node 20, TypeScript, pnpm, Zod; preserve ToolResponse. Optional rawToolCalls and correction ledger default empty; raw_tool_call is an additive message block requiring Formatter support. No Git exists; changes are made in user-designated D:/agentops.

## Tasks

- [ ] Write test/tool-admission.test.ts for parse repair, malformed optional input, duplicate keys, schema errors, correction feedback, exhausted new IDs, budgets and cancellation; run failing tests.
- [ ] Extend contracts/{tool,model,message,context,errors}.ts, keeping existing ToolCall.input.
- [ ] Add tool/json-arguments.ts with a bounded JSON tokenizer, duplicate-key detection and syntax-only repair outside strings.
- [ ] Add tool/admission.ts: existence, parse, strict Schema, injected semantic policy; output accepted call or structured rejection.
- [ ] Integrate Harness correction state and paired messages. Conservative V1 correction key is tool name per Run; exhausted keys remain blocked across resume.
- [ ] Integrate Pipeline semantics and normalized Guard input; count all calls, including rejected calls, without double charging.
- [ ] Correct batch allSettled/error isolation/order and serial writes, test valid siblings execute once.
- [ ] Run lint, typecheck, test, build and document verified scope and remaining roadmap.

Each task uses failing behavior tests before production edits. No new external dependency is required. Full MCP, SQLite, simulator and Web deployment belong to subsequent independently verified milestones.
