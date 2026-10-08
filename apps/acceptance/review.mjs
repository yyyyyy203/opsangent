#!/usr/bin/env node
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseAcceptanceDiagnostics } from '../../dist/acceptance/diagnostics.js';

const MAX_REPORT_BYTES = 256_000;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CASE_IDS = new Set(['normal', 'settlement_failure', 'low_sample', 'logs_offline', 'capture_window_mismatch']);
const CHECK_CODES_V1 = new Set([
  'SOURCE_ALLOWLIST', 'SOURCE_CALL_LIMIT', 'METRIC_FACT_VALID', 'SOURCE_WINDOW_VALID',
  'MISSING_EVIDENCE_VISIBLE', 'EVIDENCE_OWNERSHIP', 'TERMINAL_COMPLETE', 'MODEL_HTTP_BUDGET',
  'USAGE_CONSISTENT', 'PUBLIC_DATA_SAFE', 'TRACE_EXPORT_SAFE',
]);
const CHECK_CODES_V2 = new Set([...CHECK_CODES_V1, 'SCENARIO_OUTCOME_VALID', 'SOURCE_FINGERPRINT_VALID']);
const DIAGNOSTIC_CODES = new Set([
  'TRACE_QUEUE_FULL', 'TRACE_NETWORK_ERROR', 'TRACE_REQUEST_TIMEOUT', 'TRACE_FLUSH_TIMEOUT',
  'TRACE_HTTP_ERROR', 'TRACE_LOCAL_AUDIT_REJECTED',
  'TRACE_PARENT_MISSING', 'TRACE_PAYLOAD_DROPPED',
]);
const MODEL_FAILURE_CATEGORIES = new Set([
  'auth', 'rate_limit', 'server', 'network', 'timeout', 'protocol', 'aborted', 'context_length', 'output_truncated',
]);
const FAILURE_CODES = new Set([
  'ABORTED', 'BUDGET_EXCEEDED', 'CONFIRMATION_EXPIRED', 'INVALID_INPUT', 'LOOP_DETECTED', 'MODEL_ERROR',
  'STORAGE_ERROR', 'TOOL_ERROR', 'TOOL_NOT_FOUND', 'TOOL_ARGUMENTS_PARSE_FAILED', 'TOOL_ARGUMENTS_SCHEMA_INVALID',
  'TOOL_ARGUMENTS_SEMANTIC_INVALID', 'POLICY_DENIED', 'MCP_NETWORK_ERROR', 'MCP_TIMEOUT', 'MCP_RATE_LIMITED',
  'MCP_SERVER_ERROR', 'MCP_AUTH_ERROR', 'MCP_PROTOCOL_ERROR', 'CIRCUIT_OPEN', 'TIMEOUT', 'UNAVAILABLE', 'USER_REJECTED',
]);

class ReviewCliError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function main() {
  try {
    const options = parseReviewOptions(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Usage: pnpm acceptance:review -- --report <absolute-json-path> --decision approved|rejected --unsupported-claims <count>\n');
      return;
    }

    const report = await readSafeReport(options.reportPath);
    const { applyManualReview } = await import('../../dist/acceptance/evaluator.js');
    const reviewed = applyManualReview(report, {
      status: options.decision,
      unsupportedClaimCount: options.unsupportedClaimCount,
    });
    const outputPath = join(dirname(options.reportPath), `${reviewed.runId}.reviewed.json`);
    const serialized = `${JSON.stringify(reviewed, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REPORT_BYTES) throw new ReviewCliError('REVIEW_REPORT_INVALID');
    try {
      await writeFile(outputPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch {
      throw new ReviewCliError('REVIEW_OUTPUT_WRITE_FAILED');
    }

    process.stdout.write(`${JSON.stringify({
      status: 'reviewed',
      runId: reviewed.runId,
      decision: options.decision,
      unsupportedClaimCount: options.unsupportedClaimCount,
      verdict: reviewed.verdict,
      outputFile: basename(outputPath),
    })}\n`);
  } catch (error) {
    const code = error instanceof ReviewCliError ? error.code : 'REVIEW_INTERNAL_ERROR';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

function parseReviewOptions(args) {
  const forwardedArgs = args[0] === '--' ? args.slice(1) : args;
  let parsed;
  try {
    parsed = parseArgs({
      args: forwardedArgs,
      options: {
        report: { type: 'string' },
        decision: { type: 'string' },
        'unsupported-claims': { type: 'string' },
        help: { type: 'boolean' },
      },
      allowPositionals: false,
    });
  } catch {
    throw new ReviewCliError('REVIEW_ARGUMENTS_INVALID');
  }

  if (parsed.values.help === true && forwardedArgs.length === 1) return { help: true };
  const reportPath = parsed.values.report;
  const decision = parsed.values.decision;
  const countText = parsed.values['unsupported-claims'];
  if (typeof reportPath !== 'string' || reportPath.trim() === '' || !isAbsolute(reportPath)
    || reportPath.includes('\0') || (decision !== 'approved' && decision !== 'rejected')
    || typeof countText !== 'string' || !/^(0|[1-9]\d*)$/u.test(countText)) {
    throw new ReviewCliError('REVIEW_ARGUMENTS_INVALID');
  }
  const unsupportedClaimCount = Number(countText);
  if (!Number.isSafeInteger(unsupportedClaimCount)
    || (decision === 'approved' && unsupportedClaimCount !== 0)) {
    throw new ReviewCliError('REVIEW_ARGUMENTS_INVALID');
  }
  return { help: false, reportPath, decision, unsupportedClaimCount };
}

async function readSafeReport(reportPath) {
  let info;
  try {
    info = await lstat(reportPath);
  } catch {
    throw new ReviewCliError('REVIEW_REPORT_READ_FAILED');
  }
  if (!info.isFile() || info.size > MAX_REPORT_BYTES) throw new ReviewCliError('REVIEW_REPORT_INVALID');

  let contents;
  try {
    contents = await readFile(reportPath, 'utf8');
  } catch {
    throw new ReviewCliError('REVIEW_REPORT_READ_FAILED');
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new ReviewCliError('REVIEW_REPORT_INVALID');
  }
  if (!isAcceptanceReport(value)) throw new ReviewCliError('REVIEW_REPORT_INVALID');
  return value;
}

function isAcceptanceReport(value) {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || !CASE_IDS.has(value.caseId)
    || !isReportText(value.codeRevision) || !isReportText(value.profileRevision)
    || !isReportText(value.snapshotId) || typeof value.runId !== 'string' || !RUN_ID_PATTERN.test(value.runId)
    || !Array.isArray(value.childRunIds) || !value.childRunIds.every((id) => typeof id === 'string' && RUN_ID_PATTERN.test(id))) {
    return false;
  }
  const checkCodes = value.schemaVersion === 1 ? CHECK_CODES_V1 : CHECK_CODES_V2;
  if (!Array.isArray(value.checks) || value.checks.length !== checkCodes.size) return false;
  const seenCheckCodes = new Set();
  for (const check of value.checks) {
    if (!isRecord(check) || !checkCodes.has(check.code) || typeof check.passed !== 'boolean'
      || seenCheckCodes.has(check.code)) return false;
    if (check.status !== undefined && (!['passed', 'failed', 'not_run'].includes(check.status)
      || (check.status === 'passed') !== check.passed)) return false;
    seenCheckCodes.add(check.code);
  }
  if (seenCheckCodes.size !== checkCodes.size || !isBudget(value.budget) || !isUsage(value.usage)
    || !isExportDiagnostics(value.exportDiagnostics) || !isTraceVerification(value.traceVerification)
    || !isManualReview(value.manualReview)
    || !['passed', 'failed', 'review_required'].includes(value.verdict)) return false;
  if (value.failures !== undefined) {
    const runIds = new Set([value.runId, ...value.childRunIds]);
    if (!Array.isArray(value.failures) || value.failures.length > 100 || !value.failures.every((failure) =>
      isRecord(failure) && Object.keys(failure).every((key) => ['runId', 'code', 'category'].includes(key))
      && runIds.has(failure.runId) && FAILURE_CODES.has(failure.code)
      && (failure.category === undefined || MODEL_FAILURE_CATEGORIES.has(failure.category)))) return false;
  }
  if (value.outputBudget !== undefined && !isOutputBudget(value.outputBudget)) return false;
  if (value.diagnostics !== undefined) {
    try { parseAcceptanceDiagnostics(value.diagnostics); }
    catch { return false; }
  }
  if (value.schemaVersion === 2 && !isFingerprint(value.sourceFingerprint)) {
    const outcome = value.checks.find((check) => check.code === 'SCENARIO_OUTCOME_VALID');
    const fingerprintCheck = value.checks.find((check) => check.code === 'SOURCE_FINGERPRINT_VALID');
    if (value.verdict !== 'failed' || outcome?.passed !== false || fingerprintCheck?.passed !== false) return false;
  }
  return true;
}

function isFingerprint(value) {
  return typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
}

function isOutputBudget(value) {
  const keys = ['limit', 'reserved', 'settled', 'available', 'reservations', 'settlements', 'rejected'];
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => isCount(value[key]))
    && value.limit >= 1 && value.limit <= 5120 && value.reserved + value.settled + value.available === value.limit
    && value.settlements <= value.reservations;
}

function isBudget(value) {
  return isRecord(value) && isCount(value.limit) && value.limit >= 1 && value.limit <= 10
    && isCount(value.attempted) && isCount(value.sent) && value.sent <= value.limit
    && isCount(value.rejected) && value.attempted === value.sent + value.rejected;
}

function isUsage(value) {
  return isRecord(value) && ['complete', 'partial', 'unavailable'].includes(value.completeness)
    && optionalCount(value.inputTokens) && optionalCount(value.outputTokens) && optionalCount(value.cachedInputTokens);
}

function isExportDiagnostics(value) {
  if (!isRecord(value) || !isCount(value.pending) || !isCount(value.dropped) || !isRecord(value.counts)) return false;
  return Object.entries(value.counts).every(([code, count]) => DIAGNOSTIC_CODES.has(code) && isCount(count));
}

function isTraceVerification(value) {
  return isRecord(value) && ['verified', 'failed', 'unavailable'].includes(value.status)
    && isCount(value.checkedSpanCount);
}

function isManualReview(value) {
  if (!isRecord(value)) return false;
  if (value.status === 'pending') return true;
  return (value.status === 'approved' || value.status === 'rejected') && isCount(value.unsupportedClaimCount);
}

function isReportText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function optionalCount(value) {
  return value === undefined || isCount(value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

await main();
