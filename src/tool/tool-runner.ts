import type { Tool, ToolCallOptions, ToolResponse, ToolResponseChunk } from '../contracts/index.js';

export interface ToolRunnerCallbacks {
  onChunk?: (chunk: ToolResponseChunk) => Promise<void> | void;
}

export interface ToolRunner {
  stream(
    tool: Tool,
    input: Record<string, unknown>,
    options: ToolCallOptions,
  ): AsyncGenerator<ToolResponseChunk, ToolResponse>;
  execute(
    tool: Tool,
    input: Record<string, unknown>,
    options: ToolCallOptions,
    callbacks?: ToolRunnerCallbacks,
  ): Promise<ToolResponse>;
}

export class DefaultToolRunner implements ToolRunner {
  public async *stream(
    tool: Tool,
    input: Record<string, unknown>,
    options: ToolCallOptions,
  ): AsyncGenerator<ToolResponseChunk, ToolResponse> {
    if (tool.call === undefined) throw new Error(`Tool requires external execution: ${tool.name}`);
    const returned = tool.call(input, options);
    if (isAsyncGenerator(returned)) {
      let completed = false;
      try {
        while (true) {
          const item = await returned.next();
          if (item.done) {
            completed = true;
            return item.value;
          }
          yield item.value;
        }
      } finally {
        if (!completed) await returned.return(undefined as unknown as ToolResponse).catch(() => undefined);
      }
    }
    return await returned;
  }

  public async execute(
    tool: Tool,
    input: Record<string, unknown>,
    options: ToolCallOptions,
    callbacks: ToolRunnerCallbacks = {},
  ): Promise<ToolResponse> {
    const stream = this.stream(tool, input, options);
    while (true) {
      const item = await stream.next();
      if (item.done) return item.value;
      await callbacks.onChunk?.(item.value);
    }
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
