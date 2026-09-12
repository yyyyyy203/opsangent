import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  ImpactSurfaceAssessment,
  ResolvedProfileSnapshot,
  Tool,
  GovernanceGuardInput,
} from '../src/contracts/index.js';
import { finding } from '../src/guard/guard-engine.js';
import { GuardianCoordinator } from '../src/guard/guardian-coordinator.js';

const profile: ResolvedProfileSnapshot = {
  profileId: 'group-buy-market', revision: 'profile/v1', digest: 'sha256:v1:profile',
  serviceName: 'settlement', serviceLevel: 'S1', timezone: 'Asia/Shanghai',
  allowedActions: ['action.drain'], forbiddenActions: ['action.drop'], changeFreezePeriods: [],
  impactPolicy: { unavailable: { S0: 'deny', S1: 'deny', S2: 'confirm', S3: 'confirm' } },
  policyVersion: 'risk/v2', capturedAt: '2026-09-12T00:00:00.000Z', source: 'resolved',
};

const impact: ImpactSurfaceAssessment = {
  status: 'available', capturedAt: '2026-09-12T00:00:00.000Z', expiresAt: '2026-09-12T00:05:00.000Z',
  affectedUsers: 0, errorRate: 0.01, baselineErrorRate: 0.01, currentQps: 10, peakQps: 20,
  downstreamHealthy: true, quality: 'complete', evidenceIds: [],
};

const tool: Tool = { name: 'query', description: 'query', kind: 'evidence', inputSchema: z.object({}) };

function input(overrides: Partial<GovernanceGuardInput> = {}): GovernanceGuardInput {
  return {
    runId: 'run-1', stepId: 'step-1', tool, toolCall: { id: 'call-1', name: tool.name, input: {} },
    profile, impact, signal: new AbortController().signal, deadline: Date.now() + 1_000,
    ...overrides,
  };
}

describe('GuardianCoordinator', () => {
  it('treats a missing matches method as a matching legacy Guardian', async () => {
    let inspected = false;
    const coordinator = new GuardianCoordinator([{ id: 'legacy', inspect: () => {
      inspected = true;
      return Promise.resolve([]);
    } }]);

    const result = await coordinator.inspect(input());

    expect(inspected).toBe(true);
    expect(result).toEqual({ findings: [], unavailableGuardians: [] });
  });

  it('keeps findings in Guardian registration order when promises settle out of order', async () => {
    const coordinator = new GuardianCoordinator([
      { id: 'first', inspect: async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return [finding('first.rule', 'LOW', 'first', 'query')]; } },
      { id: 'second', inspect: async () => { await Promise.resolve(); return [finding('second.rule', 'HIGH', 'second', 'query')]; } },
    ]);

    const result = await coordinator.inspect(input());

    expect(result.findings.map((item) => item.ruleId)).toEqual(['first.rule', 'second.rule']);
  });

  it('isolates a rejected Guardian and emits a safe unavailable finding', async () => {
    const coordinator = new GuardianCoordinator([
      { id: 'broken', inspect: () => Promise.reject(new Error('secret internal detail')) },
      { id: 'healthy', inspect: () => Promise.resolve([finding('healthy.rule', 'LOW', 'ok', 'query')]) },
    ]);

    const result = await coordinator.inspect(input());

    expect(result.unavailableGuardians).toEqual(['broken']);
    expect(result.findings.map((item) => item.ruleId)).toEqual(['guard.unavailable', 'healthy.rule']);
    expect(result.findings[0]?.description).not.toContain('secret internal detail');
  });

  it('turns a hung Guardian into the same unavailable result at its deadline', async () => {
    const coordinator = new GuardianCoordinator([{ id: 'hung', inspect: () => new Promise(() => undefined) }], { guardianTimeoutMs: 5 });

    const result = await coordinator.inspect(input({ deadline: Date.now() + 100 }));

    expect(result.unavailableGuardians).toEqual(['hung']);
    expect(result.findings[0]).toMatchObject({ ruleId: 'guard.unavailable', toolName: 'query' });
  });

  it('cancels the child Guardian signal after a timeout', async () => {
    let childAborted = false;
    const coordinator = new GuardianCoordinator([{
      id: 'hung',
      inspect: (candidate) => new Promise(() => {
        const signal = (candidate as GovernanceGuardInput).signal;
        signal.addEventListener('abort', () => { childAborted = true; }, { once: true });
      }),
    }], { guardianTimeoutMs: 5 });

    await coordinator.inspect(input({ deadline: Date.now() + 100 }));

    expect(childAborted).toBe(true);
  });

  it('propagates parent Abort instead of converting it into an unavailable Guardian', async () => {
    const controller = new AbortController();
    const coordinator = new GuardianCoordinator([{
      id: 'abort-aware',
      inspect: () => new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('guardian stopped')), { once: true });
      }),
    }]);
    const pending = coordinator.inspect(input({ signal: controller.signal }));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
  });

  it('does not start a Guardian when the batch deadline has already expired', async () => {
    const now = new Date('2026-09-12T00:00:00.000Z');
    let inspected = false;
    const coordinator = new GuardianCoordinator([{
      id: 'expired',
      inspect: () => {
        inspected = true;
        return Promise.resolve([]);
      },
    }], { clock: { now: () => now } });

    const result = await coordinator.inspect(input({ deadline: now.getTime() - 1 }));

    expect(inspected).toBe(false);
    expect(result.unavailableGuardians).toEqual(['expired']);
  });
});
