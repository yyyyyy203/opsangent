import type { AgentContext, ToolExecutionResult } from '../contracts/index.js';
import type { CompressionResult, ContextCompressor } from './types.js';

export interface RuleBasedCompressorOptions {
  maxMessagesBeforeL1: number;
  maxSerializedBytesBeforeL2: number;
  keepRecentMessages: number;
}

export class RuleBasedContextCompressor implements ContextCompressor {
  public constructor(private readonly options: RuleBasedCompressorOptions) {}

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

  public pruneToolResult(result: ToolExecutionResult): Promise<ToolExecutionResult> {
    const text = JSON.stringify(result.response);
    if (text.length <= 4_000) return Promise.resolve(result);
    return Promise.resolve({
      ...result,
      response: {
        blocks: [{
          type: 'json',
          value: {
            pruned: true,
            originalBytes: Buffer.byteLength(text, 'utf8'),
            evidenceIds: result.response?.evidenceIds ?? [],
          },
        }],
        ...(result.response?.evidenceIds === undefined ? {} : { evidenceIds: result.response.evidenceIds }),
        ...(result.response?.metadata === undefined ? {} : { metadata: result.response.metadata }),
      },
    });
  }
}
