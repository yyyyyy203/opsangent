import type {
  AgentMessage,
  ChatModel,
  ModelCallOptions,
  ModelResponse,
  ModelStreamEvent,
  Tool,
} from '../contracts/index.js';

export class ScriptedModel implements ChatModel {
  private index = 0;

  public constructor(private readonly responses: readonly ModelResponse[]) {}

  public async *stream(
    _messages: AgentMessage[],
    _tools: Tool[],
    options: ModelCallOptions,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse> {
    await Promise.resolve();
    if (options.signal.aborted) throw new Error('Model call aborted.');
    const response = this.responses[this.index];
    if (response === undefined) throw new Error('Scripted model has no remaining response.');
    this.index += 1;
    if (response.text !== undefined) yield { type: 'text_delta', delta: response.text };
    for (const call of response.toolCalls) yield { type: 'tool_call', call };
    return response;
  }
}
