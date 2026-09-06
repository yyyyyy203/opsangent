# MCP read-only execution plan

**Goal:** Connect to MCP Streamable HTTP using the official SDK, expose only locally approved readonly tools, and enforce bounded retry/circuit behavior.

**Architecture:** SDK stays in infrastructure/mcp. A dependency-injected resilient executor handles attempts/deadlines and a shared source breaker. Local manifests pin schemas and capabilities before adapting remote tools. Dedicated bootstrap freezes a readonly registry, while the generic runtime retains its existing compatibility behavior.

**Spec:** ../../architecture/05-subagents-and-mcp.md and ../../architecture/10-reliability-and-evaluation.md.

## Constraints

Node 20; official @modelcontextprotocol/sdk pinned at 1.30.0 (registry engines >=18). Preserve ToolResponse and old generic runtime API. No automatic retries for action tools, permission failures or tool-returned business errors. SDK code must not enter Harness. No actual Prometheus/Elastic/Tempo availability is implied by local protocol tests.

## Tasks

- [x] Test and implement a dedicated readonly runtime: allowlisted local names, reject actions/Bash/external execution, prevent later registry mutation.
- [x] Test and implement bounded network attempts, deadline/cancellation, exponential jitter, source circuit with one half-open probe; injectable time/randomness and structured attempt events.
- [x] Add official SDK HTTP session adapter with explicit connection timeout, errors, cleanup and no arbitrary redirects; no advertised sampling or elicitation capability.
- [x] Implement manifest-driven discovery and exact structural schema matching; local schemas remain the validation authority and remote annotations do not grant permission.
- [x] Run a local official MCP server over a real TCP socket; verify initialize/list/call, rejected unlisted tools, schema drift and connection cleanup.
- [x] Run lint, typecheck, full test and build. Record implemented scope and remaining V1 work.

## Decision notes

The source circuit counts consecutive failed logical operations, rather than counting each retry as a separate outage. Authentication and local argument failures do not trip the breaker. Timeout/network/rate-limit/server failures do; successful half-open probe closes it. Local manifests explicitly require readOnly and idempotent before any call retries are allowed.
