import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { Tool } from '../src/contracts/index.js';
import { DefaultToolRunner } from '../src/tool/tool-runner.js';

describe('DefaultToolRunner', () => {
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
