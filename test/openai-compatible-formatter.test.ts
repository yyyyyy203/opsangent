import { describe, expect, it } from 'vitest';
import type { AgentMessage, Tool, ToolExecutionResult } from '../src/contracts/index.js';
import { formatChatRequest, renderToolResultForModel } from '../src/model/openai-compatible/formatter.js';

function message(role: AgentMessage['role'], blocks: AgentMessage['blocks'], id = `${role}-1`): AgentMessage {
  return { id, role, blocks, createdAt: '2026-09-09T00:00:00.000Z' };
}

const readToolSchema = {
  jsonSchema: {
    type: 'object',
    properties: { window: { type: 'string' } },
    required: ['window'],
  },
  validate: (input: Record<string, unknown>) => ({ valid: true as const, value: input }),
};

const readTool: Tool = {
  name: 'metrics.query',
  description: 'Query metrics.',
  kind: 'evidence',
  inputSchema: readToolSchema,
};

function result(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return {
    toolCallId: 'tc-1',
    toolName: 'metrics.query',
    status: 'success',
    startedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('OpenAI-compatible request formatter', () => {
  it('maps roles, joins text blocks, and serializes context summaries deterministically', () => {
    const request = formatChatRequest([
      message('system', [
        { type: 'text', text: 'system one' },
        { type: 'text', text: 'system two' },
        {
          type: 'context_summary',
          summary: {
            unresolvedRisks: ['risk'],
            hypotheses: ['hypothesis'],
            confirmedFacts: ['fact'],
            missingEvidence: ['evidence'],
            pendingActionIds: ['pending'],
            executedActionIds: ['executed'],
          },
        },
      ]),
      message('user', [{ type: 'text', text: 'inspect' }], 'user-1'),
      message('assistant', [{ type: 'text', text: 'thinking' }], 'assistant-1'),
    ], [], { model: 'deepseek-chat', includeUsage: true });

    expect(request).toEqual({
      model: 'deepseek-chat',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        {
          role: 'system',
          content: 'system one\nsystem two\n{"confirmedFacts":["fact"],"executedActionIds":["executed"],"hypotheses":["hypothesis"],"missingEvidence":["evidence"],"pendingActionIds":["pending"],"unresolvedRisks":["risk"]}',
        },
        { role: 'user', content: 'inspect' },
        { role: 'assistant', content: 'thinking' },
      ],
    });
  });

  it('preserves malformed raw tool arguments byte-for-byte and emits tool-call-only assistants with empty content', () => {
    const request = formatChatRequest([
      message('assistant', [
        { type: 'tool_call', call: { id: 'tc-0', name: 'metrics.query', input: { window: '5m', limit: 2 } } },
        { type: 'raw_tool_call', call: { id: 'tc-1', name: 'metrics.query', arguments: '{"window":}' } },
      ]),
    ], [readTool], { model: 'deepseek-chat', includeUsage: false });

    expect(request.messages).toEqual([{
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'tc-0', type: 'function', function: { name: 'metrics.query', arguments: '{"limit":2,"window":"5m"}' } },
        { id: 'tc-1', type: 'function', function: { name: 'metrics.query', arguments: '{"window":}' } },
      ],
    }]);
    expect(request.tools).toEqual([{
      type: 'function',
      function: {
        name: 'metrics.query',
        description: 'Query metrics.',
        parameters: readToolSchema.jsonSchema,
      },
    }]);
    expect(request).not.toHaveProperty('stream_options');
  });

  it('expands every tool result into a separate safe tool message', () => {
    const first = result({
      response: {
        blocks: [
          { type: 'text', text: 'safe result' },
          { type: 'json', value: { b: 2, a: 1 } },
          { type: 'evidence_ref', evidenceId: 'e-1' },
          { type: 'artifact', uri: 'file:///secret/internal.log', mediaType: 'text/plain' },
        ],
        evidenceIds: ['e-1'],
        metadata: { apiKey: 'must-not-leak' },
      },
    });
    const second = result({ toolCallId: 'tc-2', status: 'failed', error: {
      code: 'TOOL_ARGUMENTS_PARSE_FAILED',
      message: 'Arguments need correction.',
      retryable: false,
      details: {
        gate: 2,
        reason: 'invalid JSON',
        retryableByModel: true,
        expectedSchema: { type: 'object' },
        issues: [{ path: ['window'], message: 'required' }],
        correctionChainId: 'chain-1',
        remainingModelRetries: 1,
        internalUrl: 'http://secret.local',
      },
    } });

    const request = formatChatRequest([
      message('tool', [{ type: 'tool_result', result: first }]),
      message('tool', [{ type: 'tool_result', result: second }], 'tool-2'),
    ], [], { model: 'deepseek-chat', includeUsage: true });

    expect(request.messages).toEqual([
      { role: 'tool', tool_call_id: 'tc-1', content: '{"blocks":[{"text":"safe result","type":"text"},{"type":"json","value":{"a":1,"b":2}},{"evidenceId":"e-1","type":"evidence_ref"}],"status":"success"}' },
      { role: 'tool', tool_call_id: 'tc-2', content: '{"error":{"code":"TOOL_ARGUMENTS_PARSE_FAILED","details":{"correctionChainId":"chain-1","expectedSchema":{"type":"object"},"gate":2,"issues":[{"message":"required","path":["window"]}],"reason":"invalid JSON","remainingModelRetries":1,"retryableByModel":true},"message":"Arguments need correction.","retryable":false},"status":"failed"}' },
    ]);
    expect(request.messages.map((item) => JSON.stringify(item))).not.toContain('must-not-leak');
    expect(request.messages.map((item) => JSON.stringify(item))).not.toContain('secret.local');
  });

  it('renders only safe fields from a tool result', () => {
    expect(renderToolResultForModel(result({
      response: {
        blocks: [{ type: 'artifact', uri: 'file:///private/path' }],
        metadata: { secret: 'no' },
      },
    }))).toBe('{"status":"success"}');
  });

  it('rejects unrepresentable messages before a request is sent', () => {
    expect(() => formatChatRequest([
      message('tool', [{ type: 'text', text: 'not a tool result' }]),
    ], [], { model: 'test', includeUsage: false })).toThrowError(/tool/i);
    expect(() => formatChatRequest([
      message('assistant', [{ type: 'raw_tool_call', call: { id: '', name: 'metrics.query', arguments: '{}' } }]),
    ], [], { model: 'test', includeUsage: false })).toThrowError(/tool/i);
  });
});
