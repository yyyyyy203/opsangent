import type { Tool, ToolCallReturn, ToolInputSchema } from '../../contracts/index.js';

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolExecutor {
  call(name: string, input: Record<string, unknown>, signal: AbortSignal): ToolCallReturn;
}

export function adaptMcpTool(
  descriptor: McpToolDescriptor,
  validate: ToolInputSchema['validate'],
  executor?: McpToolExecutor,
): Tool {
  return {
    name: `mcp.${descriptor.name}`,
    description: descriptor.description ?? `MCP tool ${descriptor.name}`,
    kind: 'evidence',
    inputSchema: { jsonSchema: descriptor.inputSchema, validate },
    ...(executor === undefined ? {} : {
      call: (input, options) => executor.call(descriptor.name, input, options.signal),
    }),
    isConcurrencySafe: () => true,
    userFacingLabel: () => `调用 MCP：${descriptor.name}`,
  };
}
