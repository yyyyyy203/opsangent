import { z } from 'zod';
import type { Tool } from '../../contracts/index.js';

export const bashInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  env: z.record(z.string()).optional(),
});

/**
 * Bash is deliberately external: the host owns the process sandbox, workspace policy,
 * output limits and credential boundary. Agent Core only performs policy and HITL.
 */
export function createExternalBashTool(): Tool {
  return {
    name: 'bash',
    description: 'Run a shell command in a host-controlled sandbox.',
    kind: 'utility',
    source: 'builtin',
    inputSchema: bashInputSchema,
    requireUserConfirm: true,
    trustedWhenInWorkspace: false,
    userFacingLabel: (input) => `执行命令：${typeof input.command === 'string' ? input.command : ''}`,
    isConcurrencySafe: () => false,
  };
}
