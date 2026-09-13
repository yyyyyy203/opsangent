import type { AgentContext, ToolExecutionResult } from '../contracts/index.js';
import { DefaultToolResultCompactor } from './tool-result-compactor.js';
import type { CompressionResult, ContextCompressor, ToolResultCompactor } from './types.js';

export interface RuleBasedCompressorOptions {
  maxMessagesBeforeL1: number;
  maxSerializedBytesBeforeL2: number;
  keepRecentMessages: number;
  toolResultCompactor?: ToolResultCompactor;
}

export class RuleBasedContextCompressor implements ContextCompressor {
  private readonly toolResultCompactor: ToolResultCompactor;

  public constructor(private readonly options: RuleBasedCompressorOptions) {
    this.toolResultCompactor = options.toolResultCompactor ?? new DefaultToolResultCompactor();
  }

  public compress(context: AgentContext): Promise<CompressionResult> {
    const serializedBytes = Buffer.byteLength(JSON.stringify(context.messages), 'utf8');
    if (serializedBytes >= this.options.maxSerializedBytesBeforeL2) {
      const protectedMessages = context.messages.filter((message) => message.blocks.some((block) => (
        block.type === 'tool_result' && ['interrupted', 'success'].includes(block.result.status)
      )));
      const recent = context.messages.slice(-this.options.keepRecentMessages);
      const unique = new Map([...protectedMessages, ...recent].map((message) => [message.id, message]));
      return Promise.resolve({
        context: { ...context, messages: [...unique.values()], contextVersion: context.contextVersion + 1 },
        decision: { level: 'L2', reason: 'serialized_context_bytes' },
      });
    }

    if (context.messages.length >= this.options.maxMessagesBeforeL1) {
      return Promise.resolve({
        context: {
          ...context,
          messages: context.messages.slice(-this.options.keepRecentMessages),
          contextVersion: context.contextVersion + 1,
        },
        decision: { level: 'L1', reason: 'message_count' },
      });
    }
    return Promise.resolve({ context, decision: { level: 'none', reason: 'below_thresholds' } });
  }

  public async pruneToolResult(result: ToolExecutionResult): Promise<ToolExecutionResult> {
    return this.toolResultCompactor.compact(result).result;
  }
}
