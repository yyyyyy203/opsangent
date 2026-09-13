import type { AgentMessage, ChatModel, ModelCallOptions, ModelResponse, ModelStreamEvent, Tool } from '../contracts/index.js';
import type { ToolResultCompactor } from '../context-compressor/types.js';

/** Applies the L0 model view without mutating the durable AgentContext messages. */
export class CompactingChatModel implements ChatModel {
  public constructor(
    private readonly delegate: ChatModel,
    private readonly compactor: ToolResultCompactor,
  ) {}

  public stream(
    messages: AgentMessage[],
    tools: Tool[],
    options: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    return this.delegate.stream(compactMessages(messages, this.compactor), tools, options);
  }
}

function compactMessages(messages: readonly AgentMessage[], compactor: ToolResultCompactor): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool') return message;
    let changed = false;
    const blocks = message.blocks.map((block) => {
      if (block.type !== 'tool_result') return block;
      const compacted = compactor.compact(block.result).result;
      if (compacted === block.result) return block;
      changed = true;
      return { ...block, result: compacted };
    });
    return changed ? { ...message, blocks } : message;
  });
}
