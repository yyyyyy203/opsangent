import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentContext, AgentEvent, Clock, Tool, ToolLifecycleFact } from '../src/contracts/index.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { EventBus } from '../src/event/event-bus.js';
import { EventFactory } from '../src/event/event-factory.js';
import { GuardEngine } from '../src/guard/guard-engine.js';
import { ControlHookExecutor } from '../src/hooks/control-hook-executor.js';
import { LifecycleObserverExecutor } from '../src/hooks/lifecycle-observer-executor.js';
import { PolicyDenyHook } from '../src/hooks/policy-deny-hook.js';
import type { ControlHook, HookResult } from '../src/hooks/types.js';
import { HookRegistry } from '../src/hooks/hook-registry.js';
import { HookExecutor } from '../src/hooks/hook-executor.js';
import { NoopObservability } from '../src/observability/noop-observability.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { InMemoryCheckpointStore } from '../src/storage/in-memory-checkpoint-store.js';
import { ToolExecutionPipeline } from '../src/tool/execution-pipeline.js';
import { DefaultToolRunner } from '../src/tool/tool-runner.js';
import { Toolkit } from '../src/tool/toolkit.js';

const timestamp = '2026-09-09T12:00:00.000Z';

function context(): AgentContext {
  return {
    runId: 'run-hooks', sessionId: 'session-hooks', replyId: 'reply-hooks', streamId: 'stream-hooks',
    status: 'running', stage: 'evidence_collection', profileId: 'test', messages: [],
    pendingToolCalls: [], confirmedToolCallIds: [], rejectedToolCallIds: [], executedActions: [],
    evidenceIds: [], missingEvidence: [],
    budget: {
      startedAt: timestamp, maxIterations: 5, iteration: 1, maxToolCalls: 10, toolCallsUsed: 1,
      maxDurationMs: 60_000,
    },
    contextVersion: 1,
  };
}

function clock(): Clock {
  return { now: () => new Date(timestamp) };
}

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'inspect', description: 'inspect evidence', kind: 'evidence', inputSchema: z.object({}),
    call: () => ({ blocks: [{ type: 'text', text: 'ok' }] }),
    ...overrides,
  };
}

function pipeline(
  registered: Tool,
  controls?: ControlHookExecutor,
  observers?: LifecycleObserverExecutor,
): ToolExecutionPipeline {
  const toolkit = new Toolkit();
  toolkit.register(registered);
  return new ToolExecutionPipeline(
    toolkit,
    new GuardEngine([]),
    // Legacy hooks remain empty in these tests; control hooks are injected at
    // the end of the constructor to preserve existing callers.
    new HookExecutor([]),
    new DefaultToolRunner(),
    new InMemoryCheckpointStore(),
    new EventBus(),
    new EventFactory(clock()),
    new NoopObservability(),
    clock(),
    { actionMode: 'dry_run' },
    undefined,
    undefined,
    undefined,
    controls,
    observers,
  );
}

async function drain<T>(stream: AsyncGenerator<AgentEvent, T>): Promise<T> {
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}

describe('control hooks and lifecycle observers', () => {
  it('runs controls in the fixed order and short-circuits after the first interrupt', async () => {
    const order: string[] = [];
    const make = (id: string, result: HookResult = { type: 'continue' }): ControlHook => ({
      id,
      matches: () => true,
      beforeExecute: () => {
        order.push(id);
        return Promise.resolve(result);
      },
    });
    const executor = new ControlHookExecutor([
      make('risk-action'),
      make('custom-after'),
      make('policy-deny', { type: 'interrupt', interrupt: {
        hookId: 'policy-deny', interruptType: 'test', toolCallId: 'call-1', payload: {}, createdAt: timestamp,
      } }),
      make('evidence-budget'),
    ]);

    const result = await executor.runBefore({
      context: context(), stepId: 'step-1', toolCall: { id: 'call-1', name: 'inspect', input: {} },
      tool: tool(), input: {}, risk: { disposition: 'allow', severity: 'SAFE', requireConfirmation: false, findings: [], policyVersion: 'test' },
    });

    expect(order).toEqual(['evidence-budget', 'policy-deny']);
    expect(result.type).toBe('interrupt');
  });

  it('maps a denied risk decision to a stable POLICY_DENIED control result', async () => {
    const hook = new PolicyDenyHook();
    const result = await hook.beforeExecute({
      context: context(), stepId: 'step-1', toolCall: { id: 'call-1', name: 'inspect', input: {} },
      tool: tool(), input: {}, risk: { disposition: 'deny', severity: 'CRITICAL', requireConfirmation: false, findings: [], policyVersion: 'risk/v2' },
    });

    expect(result).toEqual({
      type: 'abort',
      error: { code: 'POLICY_DENIED', message: 'Tool call denied by policy.', retryable: false, details: { category: 'risk_policy' } },
    });
  });

  it('revalidates modified input and fails closed when the digest changes after risk evaluation', async () => {
    let executed = false;
    const registered = tool({
      inputSchema: z.object({ value: z.string() }),
      call: () => {
        executed = true;
        return { blocks: [{ type: 'text', text: 'unexpected' }] };
      },
    });
    const modifier: ControlHook = {
      id: 'modify-input',
      matches: () => true,
      beforeExecute: () => Promise.resolve({ type: 'continue', modifiedInput: { value: 'changed' } }),
    };
    const result = await drain(pipeline(registered, new ControlHookExecutor([modifier]))
      .executeStream({ id: 'call-1', name: registered.name, input: { value: 'original' } }, context(), 'step-1', new AbortController().signal));

    expect(result.type).toBe('completed');
    expect(result.result.status).toBe('failed');
    expect(result.result.error?.code).toBe('POLICY_DENIED');
    expect(result.result.error?.details).toMatchObject({ category: 'risk_policy', reason: 'input_changed_after_risk' });
    expect(executed).toBe(false);
  });

  it('delivers a final fact to observers and isolates observer failures', async () => {
    const facts: ToolLifecycleFact[] = [];
    const observers = new LifecycleObserverExecutor([
      { id: 'failing', observe: () => { throw new Error('observer failed'); } },
      { id: 'capture', observe: (fact) => { facts.push(fact); return Promise.resolve([]); } },
    ]);
    const registered = tool();
    const result = await drain(pipeline(registered, undefined, observers)
      .executeStream({ id: 'call-1', name: registered.name, input: {} }, context(), 'step-1', new AbortController().signal));

    expect(result.type).toBe('completed');
    expect(result.result.status).toBe('success');
    expect(result.effects).toEqual([]);
    expect(result.observerFailures).toEqual(['failing']);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      runId: 'run-hooks', stepId: 'step-1', toolCallId: 'call-1', toolName: 'inspect',
      outcome: 'success', result: { status: 'success', evidenceIds: [] },
    });
    expect(JSON.stringify(facts[0])).not.toContain('original');
  });

  it('notifies observers even when a control hook aborts execution', async () => {
    const facts: ToolLifecycleFact[] = [];
    const observers = new LifecycleObserverExecutor([
      { id: 'capture', observe: (fact) => { facts.push(fact); return Promise.resolve([]); } },
    ]);
    const abort: ControlHook = {
      id: 'abort-test', matches: () => true,
      beforeExecute: () => Promise.resolve({ type: 'abort', error: { code: 'ABORTED', message: 'cancelled', retryable: false } }),
    };
    const result = await drain(pipeline(tool(), new ControlHookExecutor([abort]), observers)
      .executeStream({ id: 'call-1', name: 'inspect', input: {} }, context(), 'step-1', new AbortController().signal));

    expect(result.result.status).toBe('aborted');
    expect(facts[0]?.outcome).toBe('aborted');
  });

  it('wires lifecycle observers through the runtime composition root', async () => {
    const facts: ToolLifecycleFact[] = [];
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'call-1', name: 'inspect', input: {} }] },
        { text: 'done', toolCalls: [] },
      ]),
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [tool()],
      lifecycleObservers: [{ id: 'test-capture', observe: (fact) => { facts.push(fact); return Promise.resolve([]); } }],
    });
    const durable = runtime.durableState;
    if (durable === undefined) throw new Error('Expected the default runtime to expose durable state.');
    const committedEffects: string[][] = [];
    const originalCommit = durable.transitions.commit.bind(durable.transitions);
    durable.transitions.commit = async (input) => {
      if (input.governanceEffects !== undefined && input.governanceEffects.length > 0) {
        committedEffects.push(input.governanceEffects.map((effect) => effect.type));
      }
      return originalCommit(input);
    };
    try {
      const result = await runtime.agent.reply({ message: 'inspect', profileId: 'test' });
      expect(result.status).toBe('completed');
      expect(facts).toHaveLength(1);
      expect(facts[0]?.result.status).toBe('success');
      expect(committedEffects).toContainEqual(['audit', 'checkpoint', 'memory_signal']);
    } finally {
      await runtime.close();
    }
  });

  it('fails closed on an unknown persisted interrupt and returns a model-visible terminal result', async () => {
    const external: Tool = {
      name: 'remote.inspect', description: 'remote evidence', kind: 'evidence', inputSchema: z.object({}),
    };
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'call-1', name: external.name, input: {} }] },
        { text: 'recovered', toolCalls: [] },
      ]),
      workspaceRoots: [],
      includeExternalBash: false,
      tools: [external],
    });
    try {
      const first = await runtime.agent.reply({ message: 'inspect', profileId: 'test' });
      expect(first.status).toBe('paused');
      const stored = await runtime.checkpoints.load(first.runId);
      if (stored === null || stored.pendingInterrupt === undefined) throw new Error('Expected a pending external interrupt.');
      stored.pendingInterrupt.hookId = 'unknown-hook';
      await runtime.checkpoints.save(stored);

      const resumed = await drain(runtime.agent.resumeStream(first.runId));
      expect(resumed.status).toBe('completed');
      const context = await runtime.checkpoints.load(first.runId);
      const results = context?.messages.flatMap((message) => message.blocks)
        .filter((block) => block.type === 'tool_result')
        .map((block) => block.result);
      expect(results?.some((result) => result.error?.code === 'POLICY_DENIED')).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});

describe('HookRegistry', () => {
  it('validates static interrupt identity and expiration without retaining resume handlers', () => {
    const registry = new HookRegistry(['risk-action', 'external-tool-execution']);
    expect(registry.validate({
      hookId: 'risk-action', interruptType: 'risk_confirmation', toolCallId: 'call-1', payload: {}, createdAt: timestamp,
      expiresAt: '2026-09-09T12:01:00.000Z',
    }, new Date(timestamp))).toEqual({ valid: true });
    expect(registry.validate({
      hookId: 'unknown', interruptType: 'risk_confirmation', toolCallId: 'call-1', payload: {}, createdAt: timestamp,
    }, new Date(timestamp))).toMatchObject({ valid: false, reason: 'unknown_hook' });
    expect(registry.validate({
      hookId: 'risk-action', interruptType: 'risk_confirmation', toolCallId: 'call-1', payload: {}, createdAt: timestamp,
      expiresAt: '2026-09-09T11:59:00.000Z',
    }, new Date(timestamp))).toMatchObject({ valid: false, reason: 'expired' });
  });

  it('keeps built-in identity unique when a legacy Hook reuses a built-in id', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'done', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      hooks: [{ id: 'risk-action', matches: () => false }],
    });
    try {
      expect(runtime.hookRegistry.has('risk-action')).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
