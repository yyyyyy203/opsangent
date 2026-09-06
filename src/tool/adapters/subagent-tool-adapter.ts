import type { Tool, ToolCallReturn } from '../../contracts/index.js';

export interface SubagentDescriptor {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  invoke?: (input: Record<string, unknown>, signal: AbortSignal) => ToolCallReturn;
  concurrencySafe?: boolean;
}

export function adaptSubagentTool(subagent: SubagentDescriptor): Tool {
  return {
    name: `subagent.${subagent.name}`,
    description: subagent.description,
    kind: 'utility',
    inputSchema: subagent.inputSchema,
    ...(subagent.invoke === undefined ? {} : {
      call: (input, options) => subagent.invoke?.(input, options.signal) as ToolCallReturn,
    }),
    userFacingLabel: () => `委派子 Agent：${subagent.name}`,
    isConcurrencySafe: () => subagent.concurrencySafe === true,
  };
}
