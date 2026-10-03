import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { createOpenAICompatibleModel } from '../src/bootstrap/openai-compatible.js';
import { createMetricsSubagentTool } from '../src/bootstrap/metrics-subagent.js';
import { settlementMetricsLabProfile } from '../src/profiles/settlement.js';

describe('metrics OpenAI-compatible nested loop', () => {
  it('uses separate SDK clients and exposes exactly two child tools', async () => {
    const now = Date.parse('2026-09-15T00:05:00.000Z');
    const start = new Date(now - 300_000).toISOString();
    const end = new Date(now).toISOString();
    const bodies: Array<Record<string, unknown>> = [];
    const calls = { parent: 0, child: 0 };
    const server = createServer((incoming, response) => {
      let raw = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { raw += chunk; });
      incoming.on('end', () => {
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed)) throw new Error('request body must be an object');
        const body = parsed;
        bodies.push(body);
        const names = (body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
        if (names.some((name) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name))) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { code: 'invalid_function_name', message: 'invalid tool name' } }));
          return;
        }
        const isParent = names.includes('metrics_subagent');
        const turn = isParent ? ++calls.parent : ++calls.child;
        const toolName = isParent ? 'metrics_subagent' : turn === 1 ? 'metrics_settlement' : 'source_report';
        const args = isParent ? { profileId: 'simulation', service: 'checkout', start, end, question: '调查结算' }
          : turn === 1 ? { service: 'checkout' }
            : { summary: '完成', findings: [{ kind: 'observation', statement: '已读取', evidenceIds: ['e-1'] }],
              businessTraceIds: [], missingEvidence: [] };
        const events = isParent && turn === 2 || !isParent && turn === 3
          ? [{ choices: [{ index: 0, delta: { content: '完成' }, finish_reason: 'stop' }] }]
          : [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `${toolName}-${turn}`, type: 'function',
            function: { name: toolName, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no server address');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    try {
      const metrics = createMetricsSubagentTool({ profile: settlementMetricsLabProfile,
        clock: { now: () => new Date(now) },
        settlementTool: { name: 'metrics.settlement', description: 'settlement', kind: 'evidence', source: 'mcp',
          inputSchema: z.object({ service: z.literal('checkout') }).strict(),
          call: () => ({ blocks: [{ type: 'json', value: { status: 'healthy', total: 100, failed: 0,
            failureRate: 0, threshold: 0.05, minSamples: 20, service: 'checkout', environment: 'simulation',
            start: (now - 300_000) / 1_000, end: now / 1_000 } }, { type: 'evidence_ref', evidenceId: 'e-1' }],
            evidenceIds: ['e-1'], metadata: { sourceEvidence: { schemaVersion: 1, source: 'metrics',
            evidenceId: 'e-1', state: 'committed', coverage: 1, timeRange: { start, end }, missingEvidence: [] },
              rawOnly: 'raw-only-marker' } }),
        },
        childAgentFactory: { create: (input) => createAgentRuntime({
          model: createOpenAICompatibleModel({ baseUrl, apiKey: 'test-api-key', model: 'deepseek-chat' }),
          workspaceRoots: [], includeExternalBash: false, tools: [...input.tools],
        }).agent },
      });
      const parent = createAgentRuntime({
        model: createOpenAICompatibleModel({ baseUrl, apiKey: 'test-api-key', model: 'deepseek-chat' }),
        workspaceRoots: [], includeExternalBash: false, sourceSubagentTools: [metrics],
      });
      const result = await parent.agent.reply({ message: '检查结算', profileId: 'simulation' });
      expect(result.status).toBe('completed');
      expect(calls).toEqual({ parent: 2, child: 3 });
      expect(bodies).toHaveLength(5);
      expect(bodies.map((body) => (body.tools as Array<{ function: { name: string } }>)
        .map((tool) => tool.function.name))).toEqual([
        ['metrics_subagent'], ['metrics_settlement', 'source_report'],
        ['metrics_settlement', 'source_report'], ['metrics_settlement', 'source_report'], ['metrics_subagent'],
      ]);
      expect(JSON.stringify(bodies)).not.toContain('raw-only-marker');
      const context = await parent.checkpoints.load(result.runId);
      const response = context?.messages.flatMap((message) => message.blocks)
        .find((block) => block.type === 'tool_result' && block.result.toolName === 'metrics_subagent');
      if (response?.type !== 'tool_result') throw new Error('parent metrics result missing');
      const responseBlock = response.result.response?.blocks[0] as unknown;
      if (!isRecord(responseBlock) || responseBlock.type !== 'json' || !isRecord(responseBlock.value)) {
        throw new Error('parent metrics response block must be JSON');
      }
      expect(responseBlock.value).toMatchObject({ source: 'metrics', status: 'complete', evidenceIds: ['e-1'] });
      if (typeof responseBlock.value.summary !== 'string') throw new Error('parent metrics summary missing');
      expect(responseBlock.value.summary).toContain('失败率 0.00%');
      await parent.close();
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
