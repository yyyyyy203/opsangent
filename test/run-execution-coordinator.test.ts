import { describe, expect, it, vi } from 'vitest';
import type { AgentContext, CheckpointStore, DiagnosisRunResult, DiagnosisAgent, ReplyOptions } from '../src/index.js';
import { RunExecutionCoordinator } from '../src/application/run-execution-coordinator.js';

function result(runId: string, status: AgentContext['status'] = 'completed'): DiagnosisRunResult {
  return { runId, status, finalText: '', contextVersion: 1 };
}

function checkpointStore(contexts: Map<string, AgentContext>): CheckpointStore {
  return {
    load: vi.fn(async (runId: string) => {
      const context = contexts.get(runId);
      return context === undefined ? null : structuredClone(context);
    }),
    save: vi.fn(async () => undefined),
    hasExecuted: vi.fn(async () => false),
    recordExecuted: vi.fn(async () => undefined),
  };
}

function fakeAgent(
  onReply: (options: ReplyOptions) => AsyncGenerator<never, DiagnosisRunResult>,
  onResume: (runId: string) => AsyncGenerator<never, DiagnosisRunResult>,
): DiagnosisAgent {
  return {
    reply: vi.fn(async (options) => {
      const stream = onReply(options);
      return (await stream.next()).value!;
    }),
    replyStream: vi.fn(onReply),
    resumeStream: vi.fn(onResume),
  };
}

describe('RunExecutionCoordinator', () => {
  it('registers a start before awaiting the agent and drains one stream for duplicate requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: ReplyOptions[] = [];
    const agent = fakeAgent(
      async function* (options) { calls.push(options); await gate; return result(options.runId!); },
      async function* (runId) { return result(runId); },
    );
    const coordinator = new RunExecutionCoordinator(agent, checkpointStore(new Map()));
    const options: ReplyOptions = { runId: 'run-1', message: 'inspect', profileId: 'group-buy-market' };

    const first = coordinator.start(options);
    const second = coordinator.start(options);

    expect(second).toBe(first);
    expect(coordinator.isActive('run-1')).toBe(true);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    release();
    await first;
    expect(coordinator.isActive('run-1')).toBe(false);
  });

  it('allows at most one concurrent resume and rejects an unknown Run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const contexts = new Map<string, AgentContext>([['paused', { status: 'paused' } as AgentContext]]);
    let resumeCalls = 0;
    const agent = fakeAgent(
      async function* (options) { return result(options.runId!); },
      async function* (runId) { resumeCalls += 1; await gate; return result(runId); },
    );
    const coordinator = new RunExecutionCoordinator(agent, checkpointStore(contexts));

    const first = coordinator.resume('paused');
    const second = coordinator.resume('paused');
    expect(second).toBe(first);
    await Promise.resolve();
    expect(resumeCalls).toBe(1);
    release();
    await first;

    await expect(coordinator.resume('missing')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND', statusCode: 404 });
  });

  it('rejects starting over an existing or terminal Run', async () => {
    const contexts = new Map<string, AgentContext>([
      ['running', { status: 'running' } as AgentContext],
      ['done', { status: 'completed' } as AgentContext],
    ]);
    const agent = fakeAgent(
      async function* (options) { return result(options.runId!); },
      async function* (runId) { return result(runId); },
    );
    const coordinator = new RunExecutionCoordinator(agent, checkpointStore(contexts));

    await expect(coordinator.start({ runId: 'running', message: 'inspect', profileId: 'group-buy-market' }))
      .rejects.toMatchObject({ code: 'RUN_CONFLICT', statusCode: 409 });
    await expect(coordinator.start({ runId: 'done', message: 'inspect', profileId: 'group-buy-market' }))
      .rejects.toMatchObject({ code: 'RUN_CONFLICT', statusCode: 409 });
  });
});
