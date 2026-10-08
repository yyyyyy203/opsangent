#!/usr/bin/env node
import process from 'node:process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPT_IN_NAME = 'AGENTOPS_REAL_MODEL_SMOKE';
const PUBLIC_ERROR_CODES = new Set([
  'PRECHECK_CONFIG_MISSING', 'PRECHECK_PATH_INVALID', 'PRECHECK_LANGSMITH_CONFIG_INVALID',
  'PRECHECK_OPTIONS_INVALID', 'PRECHECK_MODEL_CONFIG_INVALID', 'PRECHECK_LAB_NOT_READY',
  'PRECHECK_TRACE_PROBE_FAILED',
  'PRECHECK_SNAPSHOT_TOO_CLOSE', 'PRECHECK_WEB_NOT_LOCAL', 'PRECHECK_SOURCE_FINGERPRINT_UNAVAILABLE', 'RUN_START_REJECTED',
  'RUN_ID_INVALID', 'RUN_TIMEOUT', 'RUN_NOT_COMPLETE', 'SNAPSHOT_INVALID',
  'ACCEPTANCE_REPORT_WRITE_FAILED', 'SMOKE_NOT_AUTHORIZED',
]);
const PUBLIC_FAILURE_PHASES = new Set([
  'trace_probe',
  'lab_start', 'lab_readiness', 'web_start', 'parent_run_start', 'run_poll', 'event_flush',
  'run_terminal_status', 'snapshot_read', 'public_boundary_check', 'trace_verification',
  'acceptance_evaluation', 'acceptance_report',
]);
const PUBLIC_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'paused', 'awaiting_confirmation']);
const PUBLIC_CAUSE_CODES = new Set([
  'EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENOTFOUND', 'ENOENT', 'EEXIST', 'EIO', 'SQLITE_BUSY', 'SQLITE_CANTOPEN', 'SQLITE_CORRUPT',
  'SQLITE_ERROR', 'SQLITE_READONLY', 'SQLITE_SCHEMA', 'ERR_DLOPEN_FAILED', 'ERR_MODULE_NOT_FOUND',
]);

class AcceptanceCliError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

if (process.env[OPT_IN_NAME] !== '1') {
  process.stderr.write(`${JSON.stringify({
    status: 'precheck_failed',
    code: 'PRECHECK_SMOKE_NOT_ENABLED',
    model_http_sent: 0,
    parent_run_created: false,
  })}\n`);
  process.exitCode = 1;
} else {
  try {
    const { readLangSmithEventConfig } = await import('../../dist/bootstrap/langsmith.js');
    const options = { ...readAcceptanceOptions(process.env, readLangSmithEventConfig) };
    const { createSourceFingerprint } = await import('../../dist/acceptance/source-fingerprint.js');
    try {
      options.sourceFingerprint = await createSourceFingerprint(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
    } catch {
      throw new AcceptanceCliError('PRECHECK_SOURCE_FINGERPRINT_UNAVAILABLE');
    }
    const { runRealModelAcceptance } = await import('../../dist/acceptance/real-model-runner.js');
    const report = await runRealModelAcceptance(options);
    process.stdout.write(`${JSON.stringify({
      status: 'completed',
      runId: report.runId,
      verdict: report.verdict,
      modelRequestsSent: report.budget.sent,
      usage: report.usage,
      traceVerification: report.traceVerification.status,
      manualReview: report.manualReview.status,
      reportFile: `${report.runId}.json`,
    })}\n`);
    if (report.verdict === 'failed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${toPublicErrorCode(error)}\n`);
    const diagnostics = await toPublicFailureDiagnostics(error);
    if (diagnostics !== undefined) process.stderr.write(`${JSON.stringify(diagnostics)}\n`);
    process.exitCode = 1;
  }
}

function readAcceptanceOptions(env, readLangSmithEventConfig) {
  const model = requiredValue(env, 'AGENTOPS_MODEL');
  const modelConfig = {
    baseUrl: requiredValue(env, 'AGENTOPS_MODEL_BASE_URL'),
    apiKey: requiredValue(env, 'AGENTOPS_MODEL_API_KEY'),
    model,
  };
  const modelIdentity = {
    provider: env['AGENTOPS_MODEL_PROVIDER']?.trim() || 'openai-compatible',
    model,
  };
  let langSmithConfig;
  try {
    langSmithConfig = readLangSmithEventConfig(env);
  } catch {
    throw new AcceptanceCliError('PRECHECK_LANGSMITH_CONFIG_INVALID');
  }

  return {
    authorization: 'explicit-smoke',
    dataDirectory: requiredAbsolutePath(env, 'AGENTOPS_ACCEPTANCE_DATA_DIR'),
    workspaceRoot: requiredAbsolutePath(env, 'AGENTOPS_ACCEPTANCE_WORKSPACE_ROOT'),
    artifactDirectory: requiredAbsolutePath(env, 'AGENTOPS_ACCEPTANCE_ARTIFACT_DIR'),
    modelConfig,
    modelIdentity,
    langSmithConfig,
    lab: {
      elasticsearchUrl: env['AGENTOPS_ELASTICSEARCH_URL']?.trim() || 'http://127.0.0.1:19200',
      prometheusUrl: env['AGENTOPS_LOGS_LAB_PROMETHEUS_URL']?.trim() || 'http://127.0.0.1:19290',
      labCursorSecret: requiredValue(env, 'AGENTOPS_LOGS_LAB_CURSOR_SECRET'),
      evidenceCursorSecret: requiredValue(env, 'AGENTOPS_EVIDENCE_CURSOR_SECRET'),
    },
    codeRevision: requiredValue(env, 'AGENTOPS_ACCEPTANCE_CODE_REVISION'),
    profileRevision: requiredValue(env, 'AGENTOPS_ACCEPTANCE_PROFILE_REVISION'),
  };
}

function requiredValue(env, name) {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) throw new AcceptanceCliError('PRECHECK_CONFIG_MISSING');
  return value;
}

function requiredAbsolutePath(env, name) {
  const value = requiredValue(env, name);
  if (!isAbsolute(value) || value.includes('\0')) throw new AcceptanceCliError('PRECHECK_PATH_INVALID');
  return value;
}

function toPublicErrorCode(error) {
  if (error instanceof AcceptanceCliError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && PUBLIC_ERROR_CODES.has(error.code)) return error.code;
  return 'ACCEPTANCE_FAILED';
}

async function toPublicFailureDiagnostics(error) {
  if (typeof error !== 'object' || error === null || !('diagnostics' in error)) return undefined;
  const value = error.diagnostics;
  if (typeof value !== 'object' || value === null
    || value.schemaVersion !== 1
    || typeof value.failureId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.failureId)
    || typeof value.code !== 'string' || !PUBLIC_ERROR_CODES.has(value.code)
    || typeof value.phase !== 'string' || !PUBLIC_FAILURE_PHASES.has(value.phase)
    || !Number.isSafeInteger(value.modelRequestsSent) || value.modelRequestsSent < 0
    || typeof value.parentRunCreated !== 'boolean'
    || typeof value.persisted !== 'boolean') return undefined;

  const result = {
    status: 'failed',
    code: value.code,
    phase: value.phase,
    modelRequestsSent: value.modelRequestsSent,
    parentRunCreated: value.parentRunCreated,
    failureId: value.failureId,
    persisted: value.persisted,
  };
  if (Number.isSafeInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) {
    result.httpStatus = value.httpStatus;
  }
  if (['TRACE_PROBE_CONFIG_INVALID', 'TRACE_PROBE_UPLOAD_FAILED', 'TRACE_PROBE_QUERY_UNAVAILABLE',
    'TRACE_PROBE_MISMATCH', 'TRACE_PROBE_DEADLINE'].includes(value.probeCode)) result.probeCode = value.probeCode;
  if (value.diagnostics !== undefined) {
    try {
      const { parseAcceptanceDiagnostics } = await import('../../dist/acceptance/diagnostics.js');
      result.diagnostics = parseAcceptanceDiagnostics(value.diagnostics);
    } catch { return undefined; }
  }
  if (typeof value.runStatus === 'string' && PUBLIC_TERMINAL_STATUSES.has(value.runStatus)) {
    result.runStatus = value.runStatus;
  }
  if (typeof value.causeCode === 'string' && PUBLIC_CAUSE_CODES.has(value.causeCode)) {
    result.causeCode = value.causeCode;
  }
  return result;
}
