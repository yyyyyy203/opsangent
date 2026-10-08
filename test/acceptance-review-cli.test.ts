import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateAcceptance } from '../src/acceptance/evaluator.js';
import type { AcceptanceReport } from '../src/acceptance/types.js';
import { createAcceptanceFixture } from './fixtures/acceptance-cases.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reviewScript = join(repositoryRoot, 'apps', 'acceptance', 'review.mjs');
const realModelScript = join(repositoryRoot, 'apps', 'acceptance', 'real-model.mjs');
const traceProbeScript = join(repositoryRoot, 'apps', 'acceptance', 'trace-probe.mjs');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('acceptance review CLI', () => {
  it.each([
    { AGENTOPS_TRACE_PROBE: '0', code: 'PRECHECK_TRACE_PROBE_NOT_ENABLED' },
    { AGENTOPS_TRACE_PROBE: '1', LANGSMITH_TRACING: 'false', code: 'TRACE_PROBE_CONFIG_INVALID' },
  ])('gates the standalone Trace CLI before network without requiring model config', async ({ code, ...env }) => {
    const directory = await createTemporaryDirectory();
    const result = await runNodeScript(traceProbeScript, [], directory, { ...env, AGENTOPS_MODEL_API_KEY: '' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'precheck_failed', code, modelRequestsSent: 0 });
    expect(await readFile(join(directory, 'fetch-count.txt'), 'utf8')).toBe('0');
  });
  it('keeps validated local diagnostics through review without network or source mutation', async () => {
    const report = evaluateAcceptance(createAcceptanceFixture('settlement_failure'));
    const diagnostics = { modelDecisions: [{ runId: report.runId, stepId: 'step-1', phase: 'query', maxOutputTokens: 512 }],
      traceRequests: [{ route: 'multipart', phase: 'headers', outcome: 'http_error', elapsedMs: 10, httpStatus: 422 }] };
    const paths = await createReportFiles({ ...report, diagnostics });
    const result = await runReview(['--report', paths.reportPath, '--decision', 'rejected', '--unsupported-claims', '0'], paths.directory);
    expect(result.status).toBe(0);
    const reviewed = JSON.parse(await readFile(join(paths.directory, `${report.runId}.reviewed.json`), 'utf8')) as AcceptanceReport;
    expect(reviewed.diagnostics).toEqual(diagnostics);
    expect(reviewed.verdict).toBe('failed');
    expect(await readFile(paths.reportPath, 'utf8')).toBe(paths.originalContents);
    expect(await readFile(paths.fetchCountPath, 'utf8')).toBe('0');
  });

  it.each([
    { modelDecisions: [], traceRequests: [], body: 'PRIVATE_DIAGNOSTIC_CANARY' },
    { modelDecisions: [{ runId: 'sk-abcdefghijklmnopqrstuvwx', stepId: 's', phase: 'query', maxOutputTokens: 512 }], traceRequests: [] },
    { modelDecisions: [], traceRequests: Array(65).fill({ route: 'info', phase: 'complete', outcome: 'ok', elapsedMs: 0 }) },
  ])('rejects unsafe local diagnostics with a fixed code', async (diagnostics) => {
    const paths = await createReportFiles({ ...evaluateAcceptance(createAcceptanceFixture('settlement_failure')), diagnostics });
    const result = await runReview(['--report', paths.reportPath, '--decision', 'approved', '--unsupported-claims', '0'], paths.directory);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('REVIEW_REPORT_INVALID');
    expect(result.stderr).not.toContain('PRIVATE_DIAGNOSTIC_CANARY');
    expect(await readFile(paths.fetchCountPath, 'utf8')).toBe('0');
  });
  it('requires explicit smoke opt-in before loading configuration or making network requests', async () => {
    const directory = await createTemporaryDirectory();
    const result = await runNodeScript(realModelScript, [], directory, { AGENTOPS_REAL_MODEL_SMOKE: '0' });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      status: 'precheck_failed',
      code: 'PRECHECK_SMOKE_NOT_ENABLED',
      model_http_sent: 0,
      parent_run_created: false,
    });
    expect(result.stderr).not.toContain('REVIEW_CREDENTIAL_CANARY');
    expect(await readFile(join(directory, 'fetch-count.txt'), 'utf8')).toBe('0');
  });

  it('accepts the separator that pnpm forwards before review options', async () => {
    const directory = await createTemporaryDirectory();
    const result = await runReview(['--', '--help'], directory);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: pnpm acceptance:review');
    expect(result.stderr).toBe('');
    expect(await readFile(join(directory, 'fetch-count.txt'), 'utf8')).toBe('0');
  });

  it('records human review without exposing the report narrative or overriding unavailable remote verification', async () => {
    const report = evaluateAcceptance({
      ...createAcceptanceFixture('settlement_failure'),
      traceVerification: { status: 'unavailable', checkedSpanCount: 0 },
    });
    const reportWithPrivateFields = {
      ...report,
      finalMessage: 'PRIVATE_REPORT_CONTENT_CANARY',
      credential: 'REVIEW_CREDENTIAL_CANARY',
    };
    const paths = await createReportFiles(reportWithPrivateFields);
    const result = await runReview([
      '--report', paths.reportPath,
      '--decision', 'approved',
      '--unsupported-claims', '0',
    ], paths.directory);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('PRIVATE_REPORT_CONTENT_CANARY');
    expect(result.stdout).not.toContain('REVIEW_CREDENTIAL_CANARY');
    expect(result.stderr).not.toContain('PRIVATE_REPORT_CONTENT_CANARY');
    expect(result.stderr).not.toContain('REVIEW_CREDENTIAL_CANARY');
    const summary = JSON.parse(result.stdout) as { runId: string; verdict: string; outputFile: string };
    expect(summary).toMatchObject({ runId: report.runId, verdict: 'review_required', outputFile: `${report.runId}.reviewed.json` });
    expect(await readFile(paths.reportPath, 'utf8')).toBe(paths.originalContents);
    const reviewed = JSON.parse(await readFile(join(paths.directory, summary.outputFile), 'utf8')) as Record<string, unknown>;
    expect(reviewed).not.toHaveProperty('finalMessage');
    expect(reviewed).not.toHaveProperty('credential');
    expect(reviewed['manualReview']).toEqual({ status: 'approved', unsupportedClaimCount: 0 });
    expect(await readFile(paths.fetchCountPath, 'utf8')).toBe('0');
  });

  it('retains failure metadata and not_run checks without allowing approval to pass them', async () => {
    const report = evaluateAcceptance(createAcceptanceFixture('settlement_failure'));
    const paths = await createReportFiles({ ...report,
      checks: report.checks.map((check) => ({ ...check, passed: false, status: 'not_run' })),
      failures: [{ runId: report.runId, code: 'MODEL_ERROR', category: 'output_truncated' }], verdict: 'failed',
      outputBudget: { limit: 5120, reserved: 512, settled: 400, available: 4208, reservations: 2, settlements: 1, rejected: 0 },
    });
    const result = await runReview(['--report', paths.reportPath, '--decision', 'approved', '--unsupported-claims', '0'], paths.directory);
    expect(result.status).toBe(0);
    const reviewed = JSON.parse(await readFile(join(paths.directory, `${report.runId}.reviewed.json`), 'utf8')) as AcceptanceReport;
    expect(reviewed.failures).toEqual([{ runId: report.runId, code: 'MODEL_ERROR', category: 'output_truncated' }]);
    expect(reviewed.checks.every((check) => check.status === 'not_run')).toBe(true);
    expect(reviewed.verdict).toBe('failed');
    expect(reviewed.outputBudget).toMatchObject({ reserved: 512, settled: 400, available: 4208 });
  });

  it('reads a V1 report for history but upgrades approval with the new outcome gate as not_run', async () => {
    const current = evaluateAcceptance(createAcceptanceFixture('settlement_failure'));
    const legacy = {
      ...current,
      schemaVersion: 1,
      sourceFingerprint: undefined,
      checks: current.checks.filter((check) => check.code !== 'SCENARIO_OUTCOME_VALID' && check.code !== 'SOURCE_FINGERPRINT_VALID'),
    };
    const paths = await createReportFiles(legacy);
    const result = await runReview(['--report', paths.reportPath, '--decision', 'approved', '--unsupported-claims', '0'], paths.directory);
    expect(result.status).toBe(0);
    const reviewed = JSON.parse(await readFile(join(paths.directory, `${current.runId}.reviewed.json`), 'utf8')) as AcceptanceReport;
    expect(reviewed.schemaVersion).toBe(2);
    expect(reviewed.checks.find((check) => check.code === 'SCENARIO_OUTCOME_VALID'))
      .toEqual({ code: 'SCENARIO_OUTCOME_VALID', passed: false, status: 'not_run' });
    expect(reviewed.checks.find((check) => check.code === 'SOURCE_FINGERPRINT_VALID'))
      .toEqual({ code: 'SOURCE_FINGERPRINT_VALID', passed: false, status: 'not_run' });
    expect(reviewed.verdict).toBe('failed');
  });

  it('does not let an approved review override a failed trace verification', async () => {
    const report = evaluateAcceptance({
      ...createAcceptanceFixture('settlement_failure'),
      traceVerification: { status: 'failed', checkedSpanCount: 1 },
    });
    const paths = await createReportFiles(report);
    const result = await runReview([
      '--report', paths.reportPath,
      '--decision', 'approved',
      '--unsupported-claims', '0',
    ], paths.directory);

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as { verdict: string };
    expect(summary.verdict).toBe('failed');
  });

  it.each([
    { name: 'unknown decision', args: ['--report', 'REPORT', '--decision', 'maybe', '--unsupported-claims', '0'] },
    { name: 'negative unsupported-claim count', args: ['--report', 'REPORT', '--decision', 'rejected', '--unsupported-claims', '-1'] },
    { name: 'approval with unsupported claims', args: ['--report', 'REPORT', '--decision', 'approved', '--unsupported-claims', '1'] },
  ])('rejects $name with a fixed error code', async ({ args }) => {
    const report = evaluateAcceptance(createAcceptanceFixture('settlement_failure'));
    const paths = await createReportFiles(report);
    const result = await runReview(args.map((argument) => argument === 'REPORT' ? paths.reportPath : argument), paths.directory);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('REVIEW_ARGUMENTS_INVALID');
    expect(result.stderr).not.toContain(paths.originalContents);
  });

  it('rejects a relative report path before trying to read it', async () => {
    const paths = await createReportFiles(evaluateAcceptance(createAcceptanceFixture('settlement_failure')));
    const result = await runReview([
      '--report', 'relative-report.json',
      '--decision', 'rejected',
      '--unsupported-claims', '0',
    ], paths.directory);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('REVIEW_ARGUMENTS_INVALID');
  });

  it('rejects an unsupported report schema without echoing its contents', async () => {
    const report = { ...evaluateAcceptance(createAcceptanceFixture('settlement_failure')), schemaVersion: 99 };
    const paths = await createReportFiles(report);
    const result = await runReview([
      '--report', paths.reportPath,
      '--decision', 'rejected',
      '--unsupported-claims', '1',
    ], paths.directory);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('REVIEW_REPORT_INVALID');
    expect(result.stderr).not.toContain(paths.originalContents);
  });
});

interface ReportFiles {
  readonly directory: string;
  readonly reportPath: string;
  readonly originalContents: string;
  readonly fetchCountPath: string;
}

interface ChildResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function createReportFiles(report: unknown): Promise<ReportFiles> {
  const directory = await createTemporaryDirectory();
  const runId = (report as { runId: string }).runId;
  const reportPath = join(directory, `${runId}.json`);
  const originalContents = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, originalContents, { encoding: 'utf8', mode: 0o600 });
  return { directory, reportPath, originalContents, fetchCountPath: join(directory, 'fetch-count.txt') };
}

async function runReview(arguments_: readonly string[], directory: string): Promise<ChildResult> {
  return runNodeScript(reviewScript, arguments_, directory);
}

async function runNodeScript(
  scriptPath: string,
  arguments_: readonly string[],
  directory: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ChildResult> {
  const paths = await createNetworkProbe(directory);
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(paths.preloadPath).href,
    scriptPath,
    ...arguments_,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      ACCEPTANCE_REVIEW_FETCH_COUNT_PATH: paths.fetchCountPath,
      AGENTOPS_MODEL_API_KEY: 'REVIEW_CREDENTIAL_CANARY',
      LANGSMITH_API_KEY: 'REVIEW_CREDENTIAL_CANARY',
      ...extraEnv,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agentops-review-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createNetworkProbe(directory: string): Promise<{ preloadPath: string; fetchCountPath: string }> {
  const preloadPath = join(directory, 'fetch-probe.mjs');
  const fetchCountPath = join(directory, 'fetch-count.txt');
  await writeFile(preloadPath, [
    "import { writeFileSync } from 'node:fs';",
    'let fetchCount = 0;',
    "globalThis.fetch = async () => { fetchCount += 1; throw new Error('NETWORK_BLOCKED_FOR_TEST'); };",
    "process.on('exit', () => writeFileSync(process.env.ACCEPTANCE_REVIEW_FETCH_COUNT_PATH, String(fetchCount)));",
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  return { preloadPath, fetchCountPath };
}
