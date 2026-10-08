import process from 'node:process';

// Explicit opt-in is checked before loading SDKs, reading credentials or sending.
if (process.env.AGENTOPS_TRACE_PROBE !== '1') {
  process.stderr.write(`${JSON.stringify({ status: 'precheck_failed', code: 'PRECHECK_TRACE_PROBE_NOT_ENABLED', modelRequestsSent: 0 })}\n`);
  process.exitCode = 1;
} else {
  try {
    const { readLangSmithEventConfig } = await import('../../dist/bootstrap/langsmith.js');
    const config = readLangSmithEventConfig(process.env);
    if (!config.enabled) throw new Error('TRACE_PROBE_CONFIG_INVALID');
    const { runLangSmithTraceProbe } = await import('../../dist/acceptance/langsmith-trace-probe.js');
    const result = await runLangSmithTraceProbe({ authorization: 'explicit-probe', config });
    process.stdout.write(`${JSON.stringify({ ...result, modelRequestsSent: 0 })}\n`);
    if (result.status !== 'verified') process.exitCode = 1;
  } catch {
    process.stderr.write(`${JSON.stringify({ status: 'precheck_failed', code: 'TRACE_PROBE_CONFIG_INVALID', modelRequestsSent: 0 })}\n`);
    process.exitCode = 1;
  }
}
