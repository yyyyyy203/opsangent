import { describe, expect, it } from 'vitest';
import { isSafeLangSmithExportBody } from '../src/acceptance/langsmith-export-safety.js';

function uploadBody(metadata: Record<string, unknown>): string {
  return JSON.stringify({
    post: [{
      id: 'run-id-1',
      name: 'agent.run',
      run_type: 'chain',
      trace_id: 'trace-id-1',
      parent_run_id: null,
      inputs: { profile: 'simulation' },
      outputs: { status: 'completed' },
      extra: { metadata },
    }],
  });
}

describe('LangSmith upload privacy allowlist', () => {
  it('accepts normal approved metadata while rejecting the readback-only ls_run_depth field', () => {
    expect(isSafeLangSmithExportBody(uploadBody({ agentRunId: 'run-id-1', spanKey: 'root' }))).toBe(true);
    expect(isSafeLangSmithExportBody(uploadBody({ agentRunId: 'run-id-1', ls_run_depth: 0 }))).toBe(false);
  });
});
