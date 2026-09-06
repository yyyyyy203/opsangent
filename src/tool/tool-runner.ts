import type { Tool, ToolCallOptions, ToolResponse, ToolResponseChunk } from '../contracts/index.js';

export interface ToolRunnerCallbacks {
  onChunk?: (chunk: ToolResponseChunk) => Promise<void> | void;
}

export interface ToolRunner {
  execute(
    tool: Tool,
    input: Record<string, unknown>,
    options: ToolCallOptions,
    callbacks?: ToolRunnerCallbacks,
  ): Promise<ToolResponse>;
}

export class DefaultToolRunner implements ToolRunner {
  public async execute(
    tool: Tool,
    input: Record<string, unknown>,
    options: ToolCallOptions,
    callbacks: ToolRunnerCallbacks = {},
  ): Promise<ToolResponse> {
    if (tool.call === undefined) throw new Error(`Tool requires external execution: ${tool.name}`);
    const returned = tool.call(input, options);
    if (isAsyncGenerator(returned)) {
      while (true) {
        const item = await returned.next();
        if (item.done) return item.value;
        await callbacks.onChunk?.(item.value);
      }
    }
    return await returned;
  }
}

function isAsyncGenerator(
  value: ReturnType<NonNullable<Tool['call']>>,
): value is AsyncGenerator<ToolResponseChunk, ToolResponse> {
  return typeof value === 'object'
    && value !== null
    && Symbol.asyncIterator in value
    && typeof value[Symbol.asyncIterator] === 'function';
}
