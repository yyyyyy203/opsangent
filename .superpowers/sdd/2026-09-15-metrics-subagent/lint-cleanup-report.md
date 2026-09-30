# TypeScript lint cleanup report

## Scope

- Modified only `test/metrics-source-report-collector.test.ts`.
- Modified only `test/source-report-collector.test.ts`.
- No production files, runtime behavior, or external worktrees were changed.

## Changes

- Added explicit tuple types to the affected `it.each` cases:
  - metric fact cases use `[number, number, status, sourceStatus]` tuples;
  - invalid metric fact cases use `[string, SettlementMetricFact]`;
  - request validation cases use `[string, SourceSubagentRequest]`;
  - malformed observation cases use `[string, unknown]`;
  - unsafe-key cases use `[string]`.
- Replaced the nine `toThrow(expect.objectContaining(...))` calls that triggered `@typescript-eslint/no-unsafe-argument` with a strictly typed local helper. The helper catches `unknown`, preserves the same expected error properties, and asserts that an exception was thrown.
- No `any`, `eslint-disable`, rule changes, or assertion weakening was introduced.

## Verification

- `node node_modules/typescript/bin/tsc --noEmit` — passed.
- `node node_modules/eslint/bin/eslint.js .` — passed.
- `git diff --check` — passed; only line-ending normalization warnings were reported by Git.
- Focused Vitest command:
  `node node_modules/vitest/vitest.mjs run test/metrics-source-report-collector.test.ts test/source-report-collector.test.ts`
  — blocked before test execution by `spawn EPERM` while Vitest attempted to load `vitest.config.ts` through esbuild. No test assertion failure was reported.

## Commit

The final commit hash is recorded in the handoff response after the commit is created.
