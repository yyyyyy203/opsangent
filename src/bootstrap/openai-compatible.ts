import type { ChatModel } from '../contracts/model.js';
import { createOpenAICompatibleClient, type OpenAICompatibleClientOptions } from '../model/openai-compatible/client.js';
import { OpenAICompatibleChatModel, type OpenAICompatibleChatModelOptions } from '../model/openai-compatible/model.js';

export interface CreateOpenAICompatibleModelOptions extends OpenAICompatibleClientOptions, OpenAICompatibleChatModelOptions {}

export function createOpenAICompatibleModel(options: CreateOpenAICompatibleModelOptions): ChatModel {
  const client = createOpenAICompatibleClient(options);
  return new OpenAICompatibleChatModel(client, {
    model: options.model,
    ...(options.includeUsage === undefined ? {} : { includeUsage: options.includeUsage }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.transientForbiddenCodes === undefined ? {} : { transientForbiddenCodes: options.transientForbiddenCodes }),
    ...(options.quotaCodes === undefined ? {} : { quotaCodes: options.quotaCodes }),
  });
}
