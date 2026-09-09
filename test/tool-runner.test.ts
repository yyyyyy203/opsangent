import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { Tool } from '../src/contracts/index.js';
import { DefaultToolRunner } from '../src/tool/tool-runner.js';

describe('DefaultToolRunner', () => {
  it('exposes each ToolResponseChunk through stream and returns the final response', async () => {
    const tool: Tool = {
      name: 'streaming', description: 'test', kind: 'evidence', inputSchema: z.object({}),
      call: async function* () {
        yield { type: 'progress' as const, message: 'half', percent: 50 };
        yield { type: 'text_delta' as const, delta: 'partial' };
        return { blocks: [{ type: 'text' as const, text: 'done' }] };
      },
    };
    const stream = new DefaultToolRunner().stream(tool, {}, {
      runId: 'run-1', stepId: 'step-1', signal: new AbortController().signal, mode: 'execute',
    });
    const chunks: string[] = [];
    while (true) {
      const item = await stream.next();
      if (item.done) {
        expect(item.value.blocks).toEqual([{ type: 'text', text: 'done' }]);
        break;
      }
      chunks.push(item.value.type);
    }
    expect(chunks).toEqual(['progress', 'text_delta']);
  });

  it('forwards streaming progress and returns the final response', async () => {
    const tool: Tool = {
      name: 'streaming', description: 'test', kind: 'evidence', inputSchema: z.object({}),
      call: async function* () {
        await Promise.resolve();
        yield { type: 'progress' as const, message: 'half', percent: 50 };
        return { blocks: [{ type: 'text' as const, text: 'done' }] };
      },
      isConcurrencySafe: () => true,
    };
    const chunks: string[] = [];
    const response = await new DefaultToolRunner().execute(tool, {}, {
      runId: 'run-1', stepId: 'step-1', signal: new AbortController().signal, mode: 'execute',
    }, { onChunk: (chunk) => { chunks.push(chunk.type); } });
    expect(chunks).toEqual(['progress']);
    expect(response.blocks).toEqual([{ type: 'text', text: 'done' }]);
  });
});
