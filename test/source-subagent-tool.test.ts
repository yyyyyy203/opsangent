import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { SourceSubagentFailure } from '../src/application/source-subagent-runner.js';
import { createSourceSubagentTool } from '../src/tool/adapters/source-subagent-tool-adapter.js';
import type {
  AgentEventEnvelopeV2,
  Clock,
  EventPublisherV2Like,
  IdGenerator,
  SourceSubagentDescriptor,
  SourceSubagentResult,
  ToolResponseChunk,
  ToolResponse,
} from '../src/contracts/index.js';

const inputSchema = z.object({
  profileId: z.string().min(1),
  service: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  question: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).optional(),
}).strict();

const request = {
  profileId: 'group-buy-market',
  service: 'checkout',
  start: '2026-09-14T00:00:00.000Z',
  end: '2026-09-14T01:00:00.000Z',
  question: '查找结算失败原因',
};

describe('source subagent Tool adapter', () => {
  it('creates the canonical evidence Tool and fails closed on host scope mismatch', async () => {
    const tool = createSourceSubagentTool(descriptor(async function* () { await Promise.resolve(); yield* [] as ToolResponseChunk[]; return completeResult(); }));
    expect(tool.name).toBe('logs_subagent');
    expect(tool.kind).toBe('evidence');
    expect(tool.source).toBe('subagent');
    expect(tool.recoveryPolicy).toBe('verify_before_retry');
    expect(tool.isConcurrencySafe?.({})).toBe(false);

    await expect(drain(tool.call?.(request, options({ profileId: 'other-profile' })))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(drain(tool.call?.({ ...request, extra: true }, options()))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(drain(tool.call?.({ ...request, start: 'not-a-time' }, options()))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps the same child Run identity across a retry and emits a bounded lifecycle', async () => {
    const events: AgentEventEnvelopeV2[] = [];
    let attempts = 0;
    const tool = createSourceSubagentTool(descriptor(async function* () {
      await Promise.resolve();
      yield* [] as ToolResponseChunk[];
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('temporary'), { code: 'MCP_TIMEOUT', retryable: true });
      return completeResult();
    }, {
      lifecycle: lifecycle(events),
      retry: { maxAttempts: 2, shouldRetry: () => true, delayMs: () => 0, sleep: () => Promise.resolve() },
    }));

    const result = await drain(tool.call?.(request, options()));
    expect(result.evidenceIds).toEqual(['evidence-1']);
    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      'SUBAGENT_STARTED', 'SUBAGENT_RETRY_SCHEDULED', 'SUBAGENT_COMPLETED',
    ]);
    expect(events[0]?.payload).toMatchObject({ childRunId: 'child:parent-1:tool-1', parentRunId: 'parent-1' });
    expect(events[0]).toMatchObject({ runId: 'child:parent-1:tool-1', parentRunId: 'parent-1', toolCallId: 'tool-1', stepId: 'step-1' });
    expect(events[1]?.payload).toMatchObject({ childRunId: 'child:parent-1:tool-1', attempt: 1, reasonCode: 'MCP_TIMEOUT' });
  });

  it('does not retry after a child has exposed a response chunk', async () => {
    let attempts = 0;
    const tool = createSourceSubagentTool(descriptor(async function* () {
      await Promise.resolve();
      attempts += 1;
      yield { type: 'text_delta', delta: 'partial child output' };
      throw Object.assign(new Error('temporary'), { code: 'MCP_TIMEOUT', retryable: true });
    }, {
      retry: { maxAttempts: 3, shouldRetry: () => true, delayMs: () => 0, sleep: () => Promise.resolve() },
    }));

    await expect(drain(tool.call?.(request, options()))).rejects.toMatchObject({ code: 'MCP_TIMEOUT' });
    expect(attempts).toBe(1);
  });

  it('returns partial evidence normally and marks unavailable as an error', async () => {
    const partial = createSourceSubagentTool(descriptor(async function* () {
      await Promise.resolve();
      yield* [] as ToolResponseChunk[];
      return { ...completeResult(), status: 'partial', coverage: 0.5, missingEvidence: ['下一页不可用'] };
    }));
    const partialResult = await drain(partial.call?.(request, options()));
    expect(partialResult.isError).toBeUndefined();
    expect(partialResult.blocks[0]).toMatchObject({ type: 'json' });

    const unavailable = createSourceSubagentTool(descriptor(async function* () {
      await Promise.resolve();
      yield* [] as ToolResponseChunk[];
      return { ...completeResult(), status: 'unavailable', evidenceIds: [], coverage: 0 };
    }));
    const unavailableResult = await drain(unavailable.call?.(request, options()));
    expect(unavailableResult.isError).toBe(true);
    expect(unavailableResult.evidenceIds).toEqual([]);
  });

  it('keeps observed evidence as partial after retry exhaustion', async () => {
    let attempts = 0;
    const partialResult: SourceSubagentResult = {
      ...completeResult(),
      status: 'partial',
      coverage: 0.5,
      missingEvidence: ['日志聚合未完成'],
    };
    const tool = createSourceSubagentTool(descriptor(async function* () {
      await Promise.resolve();
      yield* [] as ToolResponseChunk[];
      attempts += 1;
      if (attempts === 1) throw new SourceSubagentFailure('MCP_SERVER_ERROR', 'child failed after capture', true, partialResult);
      throw new SourceSubagentFailure('BUDGET_EXCEEDED', 'child budget exhausted', false);
    }, {
      maxAttempts: 2,
      retry: { maxAttempts: 2, shouldRetry: () => true, delayMs: () => 0, sleep: () => Promise.resolve() },
    }));

    const result = await drain(tool.call?.(request, options()));

    expect(attempts).toBe(2);
    expect(result.isError).toBeUndefined();
    expect(result.evidenceIds).toEqual(['evidence-1']);
    expect(result.blocks[0]).toMatchObject({ type: 'json', value: { status: 'partial', coverage: 0.5 } });
  });
});

function descriptor(
  runnerFactory: () => AsyncGenerator<ToolResponseChunk, SourceSubagentResult>,
  overrides: Partial<SourceSubagentDescriptor> = {},
): SourceSubagentDescriptor {
  return {
    publicToolName: 'logs_subagent',
    subagentType: 'logs',
    description: '调查指定服务的日志证据并返回结构化来源报告。',
    inputSchema,
    runner: { run: () => runnerFactory() },
    childRunId: (execution) => `child:${execution.parentRunId}:${execution.parentToolCallId}`,
    ...overrides,
  };
}

function completeResult(): SourceSubagentResult {
  return {
    source: 'logs', status: 'complete', summary: '发现异常日志。',
    findings: [{ kind: 'observation', statement: '发现超时', evidenceIds: ['evidence-1'] }],
    evidenceIds: ['evidence-1'], businessTraceIds: ['trace-1'], missingEvidence: [], coverage: 1,
    toolCallsUsed: 2, durationMs: 100,
  };
}

function options(overrides: { profileId?: string } = {}) {
  return {
    toolCallId: 'tool-1', runId: 'parent-1', stepId: 'step-1',
    profileId: overrides.profileId ?? 'group-buy-market',
    signal: new AbortController().signal, mode: 'execute' as const,
    remainingToolCalls: 8,
  };
}

function lifecycle(events: AgentEventEnvelopeV2[]): NonNullable<SourceSubagentDescriptor['lifecycle']> {
  const clock: Clock = { now: () => new Date('2026-09-14T00:00:00.000Z') };
  const ids: IdGenerator = { next: (prefix) => `${prefix}-1` };
  const publisher: EventPublisherV2Like = {
    publish: (event) => {
      const stored = { ...event, sequence: events.length + 1 } as AgentEventEnvelopeV2;
      events.push(stored);
      return Promise.resolve(stored);
    },
  };
  return { factory: new EventFactoryV2(clock, ids), publisher, ids, correlationId: (runId) => `run:${runId}` };
}

async function drain(value: ReturnType<NonNullable<SourceSubagentDescriptor['runner']['run']>> | ReturnType<NonNullable<ReturnType<typeof createSourceSubagentTool>['call']>> | undefined): Promise<ToolResponse> {
  if (value === undefined || typeof value !== 'object' || !(Symbol.asyncIterator in value)) throw new Error('expected Tool stream');
  const stream = value as AsyncGenerator<{ type: 'progress'; message: string; percent?: number } | { type: 'text_delta'; delta: string } | { type: 'event'; name: string; payload: Record<string, unknown> }, ToolResponse>;
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
