import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  Clock,
  LoopState,
  ModelCallOptions,
  ModelResponse,
  ModelStreamEvent,
  Tool,
  ToolCall,
  ToolExecutionRecord,
  ToolExecutionResult,
} from '../src/contracts/index.js';
import type { DiagnosisRunResult } from '../src/agent/types.js';
import { createInitialRunGovernanceState } from '../src/contracts/governance.js';
import {
  createLoopSignatures,
  isCountableLoopResult,
  isLoopCallBlocked,
  recordLoopSample,
  type LoopObservation,
} from '../src/agent/loop-detection/index.js';
import { admitToolBatch } from '../src/agent/admit-tool-batch.js';
import { ToolAdmission } from '../src/tool/admission.js';
import { toolInputDigest } from '../src/tool/schema.js';
import { Toolkit } from '../src/tool/toolkit.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const now = '2026-09-13T10:00:00.000Z';

function tool(): Tool {
  return {
    name: 'metrics.query',
    description: 'Read metrics.',
    kind: 'evidence',
    inputSchema: z.object({ service: z.string() }),
    isConcurrencySafe: () => true,
    call: () => Promise.resolve({
      blocks: [{ type: 'json' as const, value: { errorRate: 0.2, coverage: 1 } }],
    }),
  };
}

function call(id = 'call-1', service = 'settlement'): ToolCall {
  return { id, name: 'metrics.query', input: { service } };
}

function actionTool(onCall?: () => void): Tool {
  return {
    name: 'action.drain',
    description: 'Dry-run action.',
    kind: 'action',
    inputSchema: z.object({ service: z.string() }),
    isConcurrencySafe: () => false,
    call: () => {
      onCall?.();
      return Promise.resolve({ blocks: [{ type: 'text' as const, text: 'dry-run' }] });
    },
  };
}

function result(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return {
    toolCallId: 'call-1',
    toolName: 'metrics.query',
    status: 'success',
    response: {
      blocks: [{ type: 'json', value: {
        errorRate: 0.2,
        coverage: 1,
        requestId: 'request-random-1',
        capturedAt: '2026-09-13T09:59:59.000Z',
        raw: { sample: 'large raw payload' },
      } }, { type: 'evidence_ref', evidenceId: 'evidence-1' }],
      evidenceIds: ['evidence-1'],
    },
    startedAt: now,
    finishedAt: now,
    ...overrides,
  };
}

function observation(overrides: Partial<LoopObservation> = {}): LoopObservation {
  return {
    stage: 'evidence_collection',
    tool: tool(),
    call: call(),
    result: result(),
    stepId: 'step-1',
    recordedAt: now,
    ...overrides,
  };
}

function loopState(): LoopState {
  return { history: [], consecutiveCount: 0, level: 'none', blockedSignatures: [] };
}

function context(): AgentContext {
  return {
    runId: 'run-loop-admission',
    sessionId: 'session-loop-admission',
    replyId: 'reply-loop-admission',
    streamId: 'stream-loop-admission',
    status: 'running',
    stage: 'evidence_collection',
    profileId: 'group-buy-market',
    messages: [],
    pendingToolCalls: [],
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: [],
    missingEvidence: [],
    budget: {
      startedAt: now,
      maxIterations: 10,
      iteration: 1,
      maxToolCalls: 20,
      toolCallsUsed: 0,
      maxDurationMs: 120_000,
    },
    contextVersion: 1,
    governance: createInitialRunGovernanceState({ profileId: 'group-buy-market', capturedAt: now }),
  };
}

describe('Loop Detection signatures and policy', () => {
  it('ignores random identity, timestamps and raw payloads when building a signature', () => {
    const first = createLoopSignatures(observation());
    const second = createLoopSignatures(observation({
      call: call('call-2'),
      result: result({
        toolCallId: 'call-2',
        startedAt: '2026-09-13T10:00:01.000Z',
        finishedAt: '2026-09-13T10:00:02.000Z',
        response: {
          blocks: [{ type: 'json', value: {
            errorRate: 0.2,
            coverage: 1,
            requestId: 'request-random-2',
            capturedAt: '2026-09-13T10:01:59.000Z',
            raw: { sample: 'different raw payload' },
          } }, { type: 'evidence_ref', evidenceId: 'evidence-2' }],
          evidenceIds: ['evidence-2'],
        },
      }),
    }));

    expect(second.callSignature).toBe(first.callSignature);
    expect(second.signature).toBe(first.signature);
    expect(second.signatureDigest).toBe(first.signatureDigest);
  });

  it('counts only terminal results and only the stable already_executed skip', () => {
    expect(isCountableLoopResult(result({ status: 'success' }))).toBe(true);
    expect(isCountableLoopResult(result({ status: 'failed' }))).toBe(true);
    expect(isCountableLoopResult(result({ status: 'timeout' }))).toBe(true);
    expect(isCountableLoopResult(result({ status: 'aborted' }))).toBe(false);
    expect(isCountableLoopResult(result({ status: 'interrupted' }))).toBe(false);
    expect(isCountableLoopResult(result({ status: 'awaiting_external' }))).toBe(false);
    expect(isCountableLoopResult(result({
      status: 'skipped',
      response: { blocks: [{ type: 'json', value: { reason: 'already_executed' } }] },
    }))).toBe(true);
    expect(isCountableLoopResult(result({
      status: 'skipped',
      response: { blocks: [{ type: 'json', value: { reason: 'replan_after_evidence' } }] },
    }))).toBe(false);
  });

  it('emits WARN, HARD and FORCE_BREAK at three, five and seven consecutive matches', () => {
    let state = loopState();
    const interventions: string[] = [];
    for (let count = 1; count <= 7; count += 1) {
      const decision = recordLoopSample(state, observation({ call: call(`call-${count}`), result: result({ toolCallId: `call-${count}` }) }));
      state = decision.state;
      if (decision.intervention !== undefined) interventions.push(decision.intervention.action);
      expect(state.consecutiveCount).toBe(count);
    }

    expect(interventions).toEqual(['hint_injected', 'signature_blocked', 'run_terminated']);
    expect(state.level).toBe('force_break');
    expect(state.blockedSignatures).toHaveLength(1);
    expect(state.history).toHaveLength(7);
  });

  it('resets the consecutive counter for a different signature and leaves ignored results unchanged', () => {
    const first = recordLoopSample(loopState(), observation());
    const different = recordLoopSample(first.state, observation({ call: call('different', 'catalog') }));
    expect(different.state.consecutiveCount).toBe(1);
    expect(different.state.level).toBe('none');

    const ignored = recordLoopSample(different.state, observation({ result: result({ status: 'aborted' }) }));
    expect(ignored.state).toEqual(different.state);
    expect(ignored.intervention).toBeUndefined();
  });

  it('blocks the normalized call signature after HARD without using the tool call id', () => {
    let state = loopState();
    for (let count = 1; count <= 5; count += 1) {
      state = recordLoopSample(state, observation({ call: call(`call-${count}`), result: result({ toolCallId: `call-${count}` }) })).state;
    }
    const blocked = createLoopSignatures(observation({ call: call('new-model-id') })).callSignature;
    expect(isLoopCallBlocked(state, blocked)).toBe(true);
  });
});

describe('Loop Detection Admission and Harness integration', () => {
  it('rejects a HARD-blocked call before ToolRunner execution', () => {
    const registered = tool();
    const toolkit = new Toolkit();
    toolkit.register(registered);
    const admission = new ToolAdmission(toolkit);
    const state = loopState();
    const callSignature = createLoopSignatures(observation()).callSignature;
    state.blockedSignatures.push(callSignature);
    const admitted = admitToolBatch(
      [call('new-id')],
      context(),
      admission,
      { now: () => new Date(now) } satisfies Clock,
      new AbortController().signal,
      (candidate) => isLoopCallBlocked(state, createLoopSignatures(observation({ call: candidate })).callSignature),
    );

    expect(admitted.calls).toEqual([]);
    expect(admitted.rejected[0]).toMatchObject({
      toolCallId: 'new-id',
      error: { code: 'LOOP_DETECTED', details: { category: 'loop_detection' } },
    });
  });

  it('terminates a parallel batch at FORCE_BREAK while persisting ordered LoopState and events', async () => {
    const runtime = createAgentRuntime({
      model: {
        async *stream() {
          await Promise.resolve();
          const calls = Array.from({ length: 7 }, (_, index) => call(`parallel-${index + 1}`));
          for (const item of calls) yield { type: 'tool_call' as const, call: item };
          return { toolCalls: calls };
        },
      },
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [tool()],
    });
    const stream = runtime.agent.replyStream({
      runId: 'parallel-loop-run',
      message: 'inspect',
      profileId: 'group-buy-market',
    });
    const events: AgentEvent[] = [];
    let resultValue: { status: AgentContext['status']; runId: string } | undefined;
    while (true) {
      const item = await stream.next();
      if (item.done) {
        resultValue = item.value;
        break;
      }
      events.push(item.value);
    }

    const checkpoint = await runtime.durableState?.checkpoints.load('parallel-loop-run');
    expect(resultValue).toMatchObject({ runId: 'parallel-loop-run', status: 'failed' });
    expect(checkpoint?.context.governance?.loop).toMatchObject({
      consecutiveCount: 7,
      level: 'force_break',
    });
    expect(checkpoint?.context.governance?.loop.history.map((sample) => sample.toolName)).toEqual([
      'metrics.query', 'metrics.query', 'metrics.query', 'metrics.query', 'metrics.query', 'metrics.query', 'metrics.query',
    ]);
    expect(checkpoint?.context.pendingToolBatch).toBeUndefined();
    expect(checkpoint?.context.failure?.code).toBe('LOOP_DETECTED');
    expect(checkpoint?.context.missingEvidence).toContain('loop_detection:metrics.query');
    expect(events.some((event) => event.type === 'RUN_FAILED')).toBe(true);

    const storedEvents = await runtime.eventStoreV2.readRun('parallel-loop-run', 0, 100);
    const loops = storedEvents.filter((event) => event.type === 'LOOP_DETECTED');
    expect(loops.map((event) => event.type === 'LOOP_DETECTED' ? event.payload.repeatCount : -1)).toEqual([3, 5, 7]);
    expect(storedEvents.filter((event) => event.type === 'TOOL_RESULT')).toHaveLength(7);
    await runtime.close();
  });

  it('does not wait for a deferred action callback in a mixed query/action batch', async () => {
    let actionCalls = 0;
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [
          { id: 'action-1', name: 'action.drain', input: { service: 'settlement' } },
          { id: 'query-1', name: 'metrics.query', input: { service: 'settlement' } },
        ] },
        { text: 'replanned', toolCalls: [] },
      ]),
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [tool(), actionTool(() => { actionCalls += 1; })],
    });

    const resultValue = await runtime.agent.reply({
      runId: 'mixed-loop-run',
      message: 'inspect',
      profileId: 'group-buy-market',
    });

    expect(resultValue.status).toBe('completed');
    expect(actionCalls).toBe(0);
    expect((await runtime.eventStoreV2.readRun('mixed-loop-run', 0, 100))
      .filter((event) => event.type === 'TOOL_RESULT')).toHaveLength(2);
    await runtime.close();
  });

  it('uses the hard-stop provider hint after HARD and keeps the hint out of persisted history', async () => {
    const responses: ModelResponse[] = [
      ...Array.from({ length: 5 }, (_, index) => ({ toolCalls: [call(`sequential-${index + 1}`)] })),
      { toolCalls: [call('blocked-after-hard')] },
      { text: 'done', toolCalls: [] },
    ];
    const requestOptions: ModelCallOptions[] = [];
    const requests: AgentMessage[][] = [];
    const model = {
      async *stream(messages: AgentMessage[], _tools: Tool[], options: ModelCallOptions): AsyncGenerator<ModelStreamEvent, ModelResponse> {
        await Promise.resolve();
        requestOptions.push(options);
        requests.push(structuredClone(messages));
        const response = responses.shift();
        if (response === undefined) throw new Error('No scripted response remains.');
        if (response.text !== undefined) yield { type: 'text_delta', delta: response.text };
        return response;
      },
    };
    const runtime = createAgentRuntime({
      model,
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [tool()],
    });

    const resultValue = await runtime.agent.reply({
      runId: 'hard-hint-run',
      message: 'inspect',
      profileId: 'group-buy-market',
      maxIterations: 7,
    });

    expect(resultValue.status).toBe('completed');
    const checkpoint = await runtime.durableState?.checkpoints.load('hard-hint-run');
    expect(requests[4]?.some((message) => message.id.startsWith('loop-hint:'))).toBe(true);
    expect(requestOptions[6]?.toolChoice).toBe('none');
    expect(requests[6]?.some((message) => message.id.startsWith('loop-hint:'))).toBe(true);
    expect(checkpoint?.context.messages.some((message) => message.id.startsWith('loop-hint:'))).toBe(false);
    expect(checkpoint?.context.governance?.loop).toMatchObject({ consecutiveCount: 5, level: 'hard' });
    await runtime.close();
  });

  it('continues loop counting from a terminal execution recovered from a checkpoint', async () => {
    const registered = tool();
    const recoveredCall = call('recovered-call');
    let priorState = loopState();
    for (let count = 1; count <= 4; count += 1) {
      priorState = recordLoopSample(priorState, observation({
        tool: registered,
        call: call(`prior-${count}`),
        result: result({ toolCallId: `prior-${count}` }),
      })).state;
    }

    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'recovered', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [registered],
    });
    const durable = runtime.durableState;
    if (durable === undefined) throw new Error('Expected default durable state.');

    const seeded = context();
    seeded.runId = 'recovered-loop-run';
    seeded.governance = { ...seeded.governance!, loop: priorState };
    seeded.pendingToolBatch = {
      batchId: 'recovered-batch',
      stepId: 'step-recovered',
      calls: [recoveredCall],
      completedResults: [],
      state: 'executing',
      createdAt: now,
    };
    seeded.pendingToolCalls = [recoveredCall];

    const firstCheckpoint = await durable.checkpoints.save(seeded, null);
    const prepared: ToolExecutionRecord = {
      toolCallId: recoveredCall.id,
      runId: seeded.runId,
      stepId: 'step-recovered',
      toolName: recoveredCall.name,
      toolKind: registered.kind,
      inputDigest: toolInputDigest(registered, recoveredCall),
      state: 'prepared',
      preparedAt: now,
    };
    const terminal = result({ toolCallId: recoveredCall.id });
    await durable.executions.prepare(prepared);
    const terminalCheckpoint = await durable.stateUnitOfWork.commitToolResult({
      expectedRevision: firstCheckpoint.revision,
      context: seeded,
      execution: prepared,
      result: terminal,
    });
    const withoutInlineResult = await durable.checkpoints.load(seeded.runId);
    if (withoutInlineResult === null || withoutInlineResult.context.pendingToolBatch === undefined) {
      throw new Error('Expected seeded pending batch.');
    }
    withoutInlineResult.context.pendingToolBatch.completedResults = [];
    await durable.checkpoints.save(withoutInlineResult.context, terminalCheckpoint.revision);

    const resumed = await drainAgent(runtime.agent.resumeStream(seeded.runId));
    expect(resumed.status).toBe('completed');
    const checkpoint = await durable.checkpoints.load(seeded.runId);
    expect(checkpoint?.context.governance?.loop).toMatchObject({ consecutiveCount: 5, level: 'hard' });
    expect((await runtime.eventStoreV2.readRun(seeded.runId, 0, 100))
      .filter((event) => event.type === 'LOOP_DETECTED')
      .map((event) => event.type === 'LOOP_DETECTED' ? event.payload.repeatCount : -1)).toEqual([5]);
    await runtime.close();
  });
});

async function drainAgent(stream: AsyncGenerator<AgentEvent, DiagnosisRunResult>): Promise<DiagnosisRunResult> {
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
