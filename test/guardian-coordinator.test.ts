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
    const coordinator = new GuardianCoordinator([{ id: 'legacy', inspect: async () => {
      inspected = true;
      return [];
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
      { id: 'broken', inspect: async () => { throw new Error('secret internal detail'); } },
      { id: 'healthy', inspect: async () => [finding('healthy.rule', 'LOW', 'ok', 'query')] },
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
});
