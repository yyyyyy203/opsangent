import { describe, expect, it } from 'vitest';
import { createExternalBashTool } from '../src/tool/builtin/bash-tool.js';
import { toolInputJsonSchema, validateToolInput } from '../src/tool/schema.js';
import { BashGuardian } from '../src/guard/bash-guardian.js';

describe('tool schema and Bash guard', () => {
  it('validates input and exposes JSON Schema', () => {
    const tool = createExternalBashTool();
    expect(validateToolInput(tool, { command: 'pnpm test', cwd: 'D:\\agentops' }).valid).toBe(true);
    expect(toolInputJsonSchema(tool).type).toBe('object');
  });

  it('marks destructive commands as critical', async () => {
    const tool = createExternalBashTool();
    const findings = await new BashGuardian(['D:\\agentops']).inspect({
      runId: 'run-1',
      tool,
      toolCall: { id: 'call-1', name: 'bash', input: { command: 'git reset --hard', cwd: 'D:\\agentops' } },
    });
    expect(findings.some((item) => item.severity === 'CRITICAL')).toBe(true);
  });
});
