import type { ToolResponse } from '../contracts/tool.js';
import type { McpToolDescriptor } from '../tool/adapters/mcp-tool-adapter.js';

/** No SDK types cross this boundary. */
export interface McpRequestOptions {
  networkAttemptBudget?: { remaining: number };
}

export interface McpConnection {
  connect(signal: AbortSignal, options?: McpRequestOptions): Promise<void>;
  listTools(signal: AbortSignal, options?: McpRequestOptions): Promise<McpToolDescriptor[]>;
  call(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResponse>;
  close(): Promise<void>;
}
