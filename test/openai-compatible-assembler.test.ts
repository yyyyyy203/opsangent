import { describe, expect, it } from 'vitest';
import type { OpenAICompatibleStreamChunk } from '../src/model/openai-compatible/types.js';
import { OpenAIStreamAssembler } from '../src/model/openai-compatible/assembler.js';
import { ModelFailure } from '../src/model/model-failure.js';

describe('OpenAI-compatible stream assembler', () => {
  it('emits text deltas and returns usage and finish reason', () => {
    const assembler = new OpenAIStreamAssembler();
    expect(assembler.accept({ choices: [{ index: 0, delta: { content: 'hello' } }] })).toEqual([
      { type: 'text_delta', delta: 'hello' },
    ]);
    expect(assembler.accept({ choices: [{ index: 0, delta: { content: ' world' } }] })).toEqual([
      { type: 'text_delta', delta: ' world' },
    ]);
    assembler.accept({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    assembler.accept({ choices: [], usage: {
      prompt_tokens: 20,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 12 },
    } });

    expect(assembler.finish()).toEqual({
      text: 'hello world',
      toolCalls: [],
      usage: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 12 },
      finishReason: 'stop',
    });
  });

  it('does not cross-contaminate interleaved tool arguments', () => {
    const assembler = new OpenAIStreamAssembler();
    assembler.accept({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'tc-0', type: 'function', function: { name: 'a', arguments: '{"x":' } },
      { index: 1, id: 'tc-1', type: 'function', function: { name: 'b', arguments: '{"y":' } },
    ] } }] });
    assembler.accept({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 1, function: { arguments: '2}' } },
      { index: 0, function: { arguments: '1}' } },
    ] } }] });
    assembler.accept({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] });

    expect(assembler.finish().rawToolCalls).toEqual([
      { id: 'tc-0', name: 'a', arguments: '{"x":1}' },
      { id: 'tc-1', name: 'b', arguments: '{"y":2}' },
    ]);
  });

  it('keeps same-index argument fragments in arrival order', () => {
    const assembler = new OpenAIStreamAssembler();
    assembler.accept({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'tc-1', function: { name: 'metrics.query', arguments: '{"window"' } },
    ] } }] });
    assembler.accept({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, function: { arguments: ':"5m"}' } },
    ] } }] });
    assembler.accept({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] });

    expect(assembler.finish().rawToolCalls).toEqual([
      { id: 'tc-1', name: 'metrics.query', arguments: '{"window":"5m"}' },
    ]);
  });

  it('rejects multiple choices and conflicting identities', () => {
    const multiple = new OpenAIStreamAssembler();
    expect(() => multiple.accept({ choices: [
      { index: 0, delta: { content: 'a' } },
      { index: 0, delta: { content: 'b' } },
    ] })).toThrow(ModelFailure);

    const conflicting = new OpenAIStreamAssembler();
    conflicting.accept({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'tc-1', function: { name: 'first', arguments: '{}' } },
    ] } }] });
    expect(() => conflicting.accept({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'tc-2', function: { name: 'first' } },
    ] } }] })).toThrow(ModelFailure);
  });

  it('rejects missing tool identity and invalid finish reasons', () => {
    const missingIdentity = new OpenAIStreamAssembler();
    missingIdentity.accept({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, function: { arguments: '{}' } },
    ] } }] });
    missingIdentity.accept({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] });
    expect(() => missingIdentity.finish()).toThrow(ModelFailure);

    const unknown = new OpenAIStreamAssembler();
    unknown.accept({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'vendor_done' }] });
    expect(() => unknown.finish()).toThrow(ModelFailure);
  });

  it('maps length to a non-retryable output-truncated failure', () => {
    const assembler = new OpenAIStreamAssembler();
    assembler.accept({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'length' }] });
    expect(() => assembler.finish()).toThrowError(ModelFailure);
    try {
      assembler.finish();
    } catch (error) {
      expect(error).toMatchObject({
        retryable: false,
        details: { category: 'output_truncated' },
      });
    }
  });

  it('rejects a successful empty response and accepts usage-only tail chunks', () => {
    const empty = new OpenAIStreamAssembler();
    empty.accept({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    expect(() => empty.finish()).toThrow(ModelFailure);

    const tail = new OpenAIStreamAssembler();
    tail.accept({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] });
    tail.accept({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(tail.finish().usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it('rejects a non-zero choice index', () => {
    const assembler = new OpenAIStreamAssembler();
    const chunk: OpenAICompatibleStreamChunk = { choices: [{ index: 1, delta: { content: 'wrong choice' } }] };
    expect(() => assembler.accept(chunk)).toThrow(ModelFailure);
  });
});
