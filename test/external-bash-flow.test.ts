import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { systemClock } from '../src/contracts/index.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

describe('external Bash HITL flow', () => {
  it('confirms, pauses for host execution, ingests result and resumes', async () => {
    let sequence = 0;
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'bash-1', name: 'bash', input: { command: 'pnpm test', cwd: 'D:\\agentops' } }] },
        { text: '巡检完成', toolCalls: [] },
      ]),
      workspaceRoots: ['D:\\agentops'],
      ids: { next: (prefix) => `${prefix}-${++sequence}` },
      actionMode: 'dry_run',
    });

    const first = await runtime.agent.reply({ message: '检查项目', profileId: 'group-buy-market' });
    expect(first.status).toBe('awaiting_confirmation');
    await runtime.hitl.decide({
      runId: first.runId,
      toolCallId: 'bash-1',
      confirmed: true,
      actor: 'tester',
      decidedAt: systemClock.now().toISOString(),
    });

    const second = await drain(runtime.agent.resumeStream(first.runId));
    expect(second.status).toBe('paused');
    const paused = await runtime.checkpoints.load(first.runId);
    expect(paused?.pendingInterrupt?.interruptType).toBe('external_tool_execution');

    await runtime.externalTools.submit({
      runId: first.runId,
      toolCallId: 'bash-1',
      response: { blocks: [{ type: 'text', text: 'tests passed' }] },
    });
    const final = await drain(runtime.agent.resumeStream(first.runId));
    expect(final.status).toBe('completed');
    expect(final.finalText).toBe('巡检完成');
  });
});

async function drain<T>(stream: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
