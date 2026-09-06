# Metrics lab implementation plan

**Goal:** A repeatable metrics-only slice: simulator → real Prometheus scrape → readonly MCP → Harness Tool pipeline → deterministic failure-rate finding with evidence reference.

**Spec:** ../../architecture/09-simulator-and-apps.md.

## Decisions

The first lab uses an explicit 300-second snapshot window with 100 settlements and 15 failures. Snapshot counts are gauges, not counters queried with increase: this makes exact fixture counts reproducible without scrape extrapolation. Timestamp metrics describe the actual simulated window; a maximum age prevents stale windows being accepted. Actual business Counter profiles remain separate future work.

Only a metrics finding is produced; no MySQL root-cause claim is possible without logs/Trace. Threshold 5% and minimum sample 20 come from Profile, never model arguments. The model has a service-scoped tool, not arbitrary PromQL or simulator controls. Scenario names and answers are absent from telemetry labels/tool descriptions.

## Tasks

- [x] Implement and test deterministic event snapshots, exposition, normal/failure/low-sample scenes and administration separated from query access.
- [x] Implement Prometheus HTTP query/response validation with fixed Profile selectors, consistent query timestamp, cardinality and staleness checks; no data produces inconclusive.
- [x] Provide a readonly MCP server with one allowlisted service query, using the official SDK; calculate exact rates in deterministic local Profile code.
- [x] Bind it through existing MCP client and Harness, persist EvidenceStore references before returning findings.
- [x] Add local app entry and Prometheus Compose config; execute real scrape/query validation when Docker is available.
- [ ] Run all quality checks, record actual backend evidence and remaining V1 gaps.

Docker availability is verified independently. HTTP test doubles do not count as real Prometheus acceptance. Preserve existing changes and do not modify group-buy-market.

## Incremental verification (2026-09-06)

Snapshot generator and deterministic assessment implemented and exported, with 15 tests covering fixed windows, scenario reset, counts, sample minimum, threshold equality and invalid rules. All four quality commands pass: 9 files / 55 tests. Task 1 remains incomplete because HTTP exposition and separated administration are not yet implemented. Docker Server 29.1.2 is reachable; no real Prometheus acceptance run has occurred yet.

Second increment: scrape-only HTTP server and dedicated Compose config implemented. Real Prometheus accepted all three scenarios through the query adapter; reproducible opt-in test added. Latest four quality checks pass, 12 files / 76 tests with real backend enabled. Task 1 still awaits administration API, task 5 awaits app entry, and MCP/EvidenceStore/Harness integration is still pending. See architecture/13 for reproduction and security boundaries.

Third increment: local official SDK stateless MCP server and evidence Tool binding implemented. Retry authority stays in the existing client executor, with upstream errors decoded inside that boundary. Raw evidence is saved before returning references. Actual Prometheus acceptance now includes MCP HTTP, Harness/Pipeline and evidence retrieval in all three scenarios. Four quality commands pass: 14 files / 84 tests with real backend enabled. Error DTO normalization fixes lost custom Error fields on checkpoint cloning without changing public fields. Administration/app entry and complete V1 remain pending; see architecture/14.

Fourth increment: loopback administration API and startMetricsLab lifecycle composition implemented. Scrape, administration and MCP remain separate surfaces; administration is never registered as an Agent Tool. Package scripts start/stop the dedicated backend and launch the compiled local app. Real-backend suite now contains 16 files / 87 tests. Frontend pages, actual LLM, source Subagent and durable storage remain outside this plan.
