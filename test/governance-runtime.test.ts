import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ImpactSurfaceAssessment, Tool } from '../src/contracts/index.js';
import { checkpointChecksum } from '../src/contracts/index.js';
import { StaticProfileResolver } from '../src/profiles/profile-resolver.js';
import type { ProfileDefinition } from '../src/profiles/profile-types.js';
import { BatchGovernanceEvaluator } from '../src/guard/governance-evaluator.js';
import { GuardianCoordinator } from '../src/guard/guardian-coordinator.js';
import { DeterministicRiskPolicy } from '../src/guard/risk-policy.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const profileDefinition: ProfileDefinition = {
  profileId: 'group-buy-market', revision: 'profile/v1', serviceName: 'settlement', serviceLevel: 'S1',
  timezone: 'Asia/Shanghai', allowedActions: ['action.drain'], forbiddenActions: ['action.drop'],
  changeFreezePeriods: [],
  impactPolicy: { unavailable: { S0: 'deny', S1: 'deny', S2: 'confirm', S3: 'confirm' } },
  policyVersion: 'risk/v2',
};

const availableImpact: ImpactSurfaceAssessment = {
  status: 'available', capturedAt: '2026-09-12T00:00:00.000Z', expiresAt: '2026-09-12T00:05:00.000Z',
  affectedUsers: 0, errorRate: 0.01, baselineErrorRate: 0.01, currentQps: 10, peakQps: 20,
  downstreamHealthy: true, quality: 'complete', evidenceIds: [],
};

const fixedClock = { now: () => new Date('2026-09-12T00:00:00.000Z') };

function evidenceTool(name: string, onCall?: () => void): Tool {
  return {
    name, description: name, kind: 'evidence', inputSchema: z.object({ value: z.string().optional() }),
    isConcurrencySafe: () => true,
    call: () => { onCall?.(); return { blocks: [{ type: 'text', text: name }] }; },
  };
}

function actionTool(name = 'action.drain', onCall?: () => void, inputSchema: Tool['inputSchema'] = z.object({})): Tool {
  return {
    name, description: name, kind: 'action', inputSchema,
    isConcurrencySafe: () => false,
    call: () => { onCall?.(); return { blocks: [{ type: 'text', text: name }] }; },
  };
}

async function profileSnapshot() {
  return new StaticProfileResolver([profileDefinition]).resolve({
    profileId: profileDefinition.profileId,
    capturedAt: '2026-09-12T00:00:00.000Z',
    signal: new AbortController().signal,
  });
}

describe('batch governance evaluation', () => {
  it('captures impact once and returns decisions in original call order', async () => {
    let captures = 0;
    const tools = [evidenceTool('query-1'), evidenceTool('query-2')];
    const evaluator = new BatchGovernanceEvaluator(
      {
        resolveTool: (name) => tools.find((tool) => tool.name === name),
        impactSurfaceProvider: { capture: () => { captures += 1; return Promise.resolve(availableImpact); } },
        guardianCoordinator: new GuardianCoordinator([]),
        riskPolicy: new DeterministicRiskPolicy(),
        clock: { now: () => new Date('2026-09-12T00:00:00.000Z') },
      },
    );
    const profile = await profileSnapshot();
    const calls = [
      { id: 'call-1', name: 'query-1', input: {} },
      { id: 'call-2', name: 'query-2', input: {} },
    ];

    const snapshot = await evaluator.evaluateBatch({
      runId: 'run-1', stepId: 'step-1', profile, calls,
      signal: new AbortController().signal, deadline: Date.now() + 1_000,
    });

    expect(captures).toBe(1);
    expect(snapshot.decisions.map((item) => item.toolCallId)).toEqual(['call-1', 'call-2']);
    expect(snapshot.decisions.every((item) => item.inputDigest.length > 0)).toBe(true);
  });

  it('digests the same schema-normalized input that the execution pipeline uses', async () => {
    const tool: Tool = {
      name: 'query-with-default', description: 'query', kind: 'evidence',
      inputSchema: z.object({ timeoutMs: z.number().default(30) }),
      call: () => ({ blocks: [{ type: 'text', text: 'ok' }] }),
    };
    const evaluator = new BatchGovernanceEvaluator({
      resolveTool: () => tool,
      impactSurfaceProvider: { capture: () => Promise.resolve(availableImpact) },
      guardianCoordinator: new GuardianCoordinator([]),
      riskPolicy: new DeterministicRiskPolicy(),
      clock: fixedClock,
    });
    const profile = await profileSnapshot();
    const snapshot = await evaluator.evaluateBatch({
      runId: 'run-1', stepId: 'step-1', profile,
      calls: [{ id: 'call-1', name: tool.name, input: {} }],
      signal: new AbortController().signal, deadline: Date.now() + 1_000,
    });

    expect(snapshot.decisions[0]?.inputDigest).toBe(checkpointChecksum({ timeoutMs: 30 }));
  });

  it('converts a hung impact provider into an unavailable snapshot at the deadline', async () => {
    let providerAborted = false;
    const evaluator = new BatchGovernanceEvaluator({
      resolveTool: () => evidenceTool('query-1'),
      impactSurfaceProvider: {
        capture: ({ signal }) => new Promise<ImpactSurfaceAssessment>((_resolve, reject) => {
          signal.addEventListener('abort', () => { providerAborted = true; reject(new Error('provider aborted')); }, { once: true });
        }),
      },
      guardianCoordinator: new GuardianCoordinator([]),
      riskPolicy: new DeterministicRiskPolicy(),
    });
    const profile = await profileSnapshot();
    const snapshot = await evaluator.evaluateBatch({
      runId: 'run-1', stepId: 'step-1', profile,
      calls: [{ id: 'call-1', name: 'query-1', input: {} }],
      signal: new AbortController().signal, deadline: Date.now() + 30,
    });

    expect(snapshot.impact).toEqual({ status: 'unavailable', reasonCode: 'impact_deadline_exceeded', evidenceIds: [] });
    expect(providerAborted).toBe(true);
  });

  it('propagates a parent Abort from Guardian evaluation before entering the ToolRunner', async () => {
    const controller = new AbortController();
    let guardianStarted = false;
    let executed = false;
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [{ id: 'call-1', name: 'query-1', input: {} }] }]),
      workspaceRoots: [], includeExternalBash: false, enableGovernance: true,
      profileResolver: new StaticProfileResolver([profileDefinition]),
      impactSurfaceProvider: { capture: () => Promise.resolve(availableImpact) },
      guardians: [{
        id: 'abort-parent',
        inspect: () => {
          guardianStarted = true;
          controller.abort();
          return Promise.resolve([]);
        },
      }],
      tools: [evidenceTool('query-1', () => { executed = true; })],
    });

    try {
      const result = await runtime.agent.reply({ message: 'inspect', profileId: profileDefinition.profileId, signal: controller.signal });

      expect(guardianStarted).toBe(true);
      expect(executed).toBe(false);
      expect(result.status).toBe('cancelled');
    } finally {
      await runtime.close();
    }
  });

  it('uses one impact capture for two safe tools in one runtime batch', async () => {
    let captures = 0;
    let executed = 0;
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [
        { id: 'call-1', name: 'query-1', input: {} }, { id: 'call-2', name: 'query-2', input: {} },
      ] }, { text: 'done', toolCalls: [] }]),
      workspaceRoots: [], includeExternalBash: false, enableGovernance: true,
      clock: fixedClock,
      profileResolver: new StaticProfileResolver([profileDefinition]),
       impactSurfaceProvider: { capture: () => { captures += 1; return Promise.resolve(availableImpact); } },
      tools: [evidenceTool('query-1', () => { executed += 1; }), evidenceTool('query-2', () => { executed += 1; })],
    });

    const result = await runtime.agent.reply({ message: 'inspect', profileId: profileDefinition.profileId });

    expect(result.status).toBe('completed');
    expect(captures).toBe(1);
    expect(executed).toBe(2);
  });

  it('denies an unlisted action before Hook or ToolRunner execution', async () => {
    let executed = false;
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [{ id: 'action-1', name: 'action.unknown', input: {} }] }, { text: 'done', toolCalls: [] }]),
      workspaceRoots: [], includeExternalBash: false, enableGovernance: true, actionMode: 'execute',
      clock: fixedClock,
      profileResolver: new StaticProfileResolver([profileDefinition]),
       impactSurfaceProvider: { capture: () => Promise.resolve(availableImpact) },
      tools: [actionTool('action.unknown', () => { executed = true; })],
    });

    const result = await runtime.agent.reply({ message: 'inspect', profileId: profileDefinition.profileId });
    const context = await runtime.checkpoints.load(result.runId);
    const toolResults = context?.messages.flatMap((message) => message.blocks).filter((block) => block.type === 'tool_result');

    expect(result.status).toBe('completed');
    expect(executed).toBe(false);
    expect(toolResults?.some((block) => block.type === 'tool_result' && block.result.error?.code === 'POLICY_DENIED')).toBe(true);
  });

  it('routes an allowed action through the existing confirmation Hook', async () => {
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ toolCalls: [{ id: 'action-1', name: 'action.drain', input: {} }] }]),
      workspaceRoots: [], includeExternalBash: false, enableGovernance: true,
      clock: fixedClock,
      profileResolver: new StaticProfileResolver([profileDefinition]),
       impactSurfaceProvider: { capture: () => Promise.resolve(availableImpact) },
      tools: [actionTool()],
    });

    const result = await runtime.agent.reply({ message: 'inspect', profileId: profileDefinition.profileId });

    expect(result.status).toBe('awaiting_confirmation');
  });

  it('resolves the Profile once, records its version, and reuses it on resume', async () => {
    let resolutions = 0;
    let captures = 0;
    let executed = 0;
    const staticResolver = new StaticProfileResolver([profileDefinition]);
    const resolver = {
      resolve: async (input: Parameters<StaticProfileResolver['resolve']>[0]) => {
        resolutions += 1;
        return staticResolver.resolve(input);
      },
    };
    const runtime = createAgentRuntime({
      model: new ScriptedModel([
        { toolCalls: [{ id: 'action-1', name: 'action.drain', input: {} }] },
        { text: 'done', toolCalls: [] },
      ]),
      workspaceRoots: [], includeExternalBash: false, enableGovernance: true, actionMode: 'execute', clock: fixedClock,
      profileResolver: resolver,
       impactSurfaceProvider: { capture: () => { captures += 1; return Promise.resolve(availableImpact); } },
      tools: [actionTool('action.drain', () => { executed += 1; }, z.object({ mode: z.string().default('safe') }))],
    });

    const first = await runtime.agent.reply({ message: 'inspect', profileId: profileDefinition.profileId });
    expect(first.status).toBe('awaiting_confirmation');
    expect(resolutions).toBe(1);
    const started = (await runtime.eventStoreV2.readRun(first.runId, 0, 20)).find((event) => event.type === 'RUN_STARTED');
    if (started?.type !== 'RUN_STARTED') throw new Error('RUN_STARTED event was not persisted.');
    expect(started.payload.versionSnapshot.profileRevision).toBe('profile/v1');
    expect(started.payload.versionSnapshot.profileDigest).toMatch(/^sha256:v1:[a-f0-9]{64}$/);
    expect(started.payload.versionSnapshot.policyVersion).toBe('risk/v2');

    await runtime.hitl.decide({
      runId: first.runId, toolCallId: 'action-1', confirmed: true, actor: 'tester',
      decidedAt: fixedClock.now().toISOString(),
    });
    const second = await drain(runtime.agent.resumeStream(first.runId));
    expect(second.status).toBe('completed');
    expect(resolutions).toBe(1);
    expect(captures).toBe(1);
    expect(executed).toBe(1);
  });
});

async function drain<T>(stream: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
