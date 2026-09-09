import type { ModelResponse, ModelStreamEvent, ModelUsage } from '../../contracts/model.js';
import { ModelFailure } from '../model-failure.js';
import type { OpenAICompatibleStreamChunk, OpenAICompatibleToolCallDelta, OpenAICompatibleUsage } from './types.js';

interface ToolAccumulator {
  wireIndex: number;
  arguments: string;
  id: string | undefined;
  name: string | undefined;
  type: string | undefined;
}

const SUCCESS_FINISH_REASONS = new Set(['stop', 'tool_calls']);

export class OpenAIStreamAssembler {
  private readonly toolCalls = new Map<number, ToolAccumulator>();
  private text = '';
  private sawText = false;
  private sawToolCall = false;
  private finishReason: string | undefined;
  private usage: ModelUsage | undefined;

  public accept(chunk: OpenAICompatibleStreamChunk): ModelStreamEvent[] {
    if (!isReadonlyArray<OpenAICompatibleStreamChunk['choices'][number]>(chunk.choices)) throw protocolFailure('Model stream choices must be an array.');
    if (chunk.choices.length > 1) throw protocolFailure('Only one model choice is supported.');

    const events: ModelStreamEvent[] = [];
    const choice = chunk.choices[0];
    if (choice !== undefined) {
      if (this.finishReason !== undefined) throw protocolFailure('Model stream emitted data after its finish reason.');
      if (choice.index !== 0) throw protocolFailure('Only model choice index 0 is supported.');
      const delta = choice.delta;
      if (delta !== undefined) this.acceptDelta(delta, events);
      this.acceptFinishReason(choice.finish_reason);
    }
    this.acceptUsage(chunk.usage);
    return events;
  }

  public finish(): ModelResponse {
    if (this.finishReason === undefined) throw protocolFailure('Model stream ended without a finish reason.');
    if (this.finishReason === 'length') throw new ModelFailure('output_truncated', 'Model output was truncated.', false);
    if (!SUCCESS_FINISH_REASONS.has(this.finishReason)) throw protocolFailure('Model stream returned an unsupported finish reason.');
    if (!this.sawText && !this.sawToolCall) throw protocolFailure('Model returned an empty response.');
    if (this.finishReason === 'tool_calls' && !this.sawToolCall) throw protocolFailure('Tool-call finish reason had no tool calls.');

    const rawToolCalls = [...this.toolCalls.values()]
      .sort((left, right) => left.wireIndex - right.wireIndex)
      .map((call) => ({
        id: requiredIdentity(call.id, 'tool call id'),
        name: requiredIdentity(call.name, 'tool name'),
        arguments: call.arguments,
      }));

    return {
      ...(this.sawText ? { text: this.text } : {}),
      toolCalls: [],
      ...(rawToolCalls.length === 0 ? {} : { rawToolCalls }),
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      finishReason: this.finishReason,
    };
  }

  private acceptDelta(
    delta: NonNullable<OpenAICompatibleStreamChunk['choices'][number]['delta']>,
    events: ModelStreamEvent[],
  ): void {
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string') throw protocolFailure('Model text delta must be a string.');
      if (delta.content.length > 0) {
        this.sawText = true;
        this.text += delta.content;
        events.push({ type: 'text_delta', delta: delta.content });
      }
    }
    if (delta.tool_calls !== undefined) {
      if (!isReadonlyArray<OpenAICompatibleToolCallDelta>(delta.tool_calls)) throw protocolFailure('Model tool calls must be an array.');
      for (const toolCall of delta.tool_calls) this.acceptToolCall(toolCall);
    }
  }

  private acceptToolCall(delta: OpenAICompatibleToolCallDelta): void {
    if (!Number.isSafeInteger(delta.index) || delta.index < 0) throw protocolFailure('Model tool-call index must be a non-negative integer.');
    this.sawToolCall = true;
    const current = this.toolCalls.get(delta.index) ?? {
      wireIndex: delta.index,
      arguments: '',
      id: undefined,
      name: undefined,
      type: undefined,
    };
    current.id = mergeIdentity(current.id, delta.id, 'tool call id');
    current.type = mergeIdentity(current.type, delta.type, 'tool call type');
    if (current.type !== undefined && current.type !== 'function') throw protocolFailure('Only function tool calls are supported.');
    const functionDelta = delta.function;
    if (functionDelta !== undefined) {
      if (typeof functionDelta !== 'object' || functionDelta === null || Array.isArray(functionDelta)) throw protocolFailure('Model function delta must be an object.');
      current.name = mergeIdentity(current.name, functionDelta.name, 'tool name');
      if (functionDelta.arguments !== undefined) {
        if (typeof functionDelta.arguments !== 'string') throw protocolFailure('Model tool-call arguments must be a string.');
        current.arguments += functionDelta.arguments;
      }
    }
    this.toolCalls.set(delta.index, current);
  }

  private acceptFinishReason(value: string | null | undefined): void {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || value.trim().length === 0) throw protocolFailure('Model finish reason must be a non-empty string.');
    this.finishReason = value;
  }

  private acceptUsage(value: OpenAICompatibleUsage | null | undefined): void {
    if (value === undefined || value === null) return;
    if (typeof value !== 'object' || Array.isArray(value)) throw protocolFailure('Model usage must be an object.');
    const inputTokens = tokenCount(value.prompt_tokens, 'prompt_tokens');
    const outputTokens = tokenCount(value.completion_tokens, 'completion_tokens');
    const details = value.prompt_tokens_details;
    if (details !== undefined && (typeof details !== 'object' || details === null || Array.isArray(details))) throw protocolFailure('Model usage details must be an object.');
    const cachedInputTokens = tokenCount(details?.cached_tokens, 'cached_tokens');
    const usage: ModelUsage = {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    };
    if (Object.keys(usage).length > 0) this.usage = usage;
  }
}

function mergeIdentity(current: string | undefined, next: string | undefined, label: string): string | undefined {
  if (next === undefined || next.trim().length === 0) return current;
  if (current !== undefined && current !== next) throw protocolFailure(`Conflicting ${label} in model stream.`);
  return current ?? next;
}

function requiredIdentity(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) throw protocolFailure(`Model stream is missing ${label}.`);
  return value;
}

function tokenCount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw protocolFailure(`Model usage ${label} must be a non-negative safe integer.`);
  return value;
}

function protocolFailure(message: string): ModelFailure {
  return new ModelFailure('protocol', message, false);
}

function isReadonlyArray<T>(value: unknown): value is readonly T[] {
  return Array.isArray(value);
}
