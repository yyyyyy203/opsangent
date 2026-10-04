#!/usr/bin/env node
import process from 'node:process';
import { isAbsolute } from 'node:path';

const OPT_IN_NAME = 'AGENTOPS_REAL_MODEL_SMOKE';
const PUBLIC_ERROR_CODES = new Set([
  'PRECHECK_CONFIG_MISSING', 'PRECHECK_PATH_INVALID', 'PRECHECK_LANGSMITH_CONFIG_INVALID',
  'PRECHECK_OPTIONS_INVALID', 'PRECHECK_MODEL_CONFIG_INVALID', 'PRECHECK_LAB_NOT_READY',
  'PRECHECK_SNAPSHOT_TOO_CLOSE', 'PRECHECK_WEB_NOT_LOCAL', 'RUN_START_REJECTED',
  'RUN_ID_INVALID', 'RUN_TIMEOUT', 'RUN_NOT_COMPLETE', 'SNAPSHOT_INVALID',
  'ACCEPTANCE_REPORT_WRITE_FAILED', 'SMOKE_NOT_AUTHORIZED',
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
    const options = readAcceptanceOptions(process.env, readLangSmithEventConfig);
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
