import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ImpactSurfaceAssessment, ResolvedProfileSnapshot, Tool } from '../src/contracts/index.js';
import { finding } from '../src/guard/guard-engine.js';
import { DeterministicRiskPolicy } from '../src/guard/risk-policy.js';

const policy = new DeterministicRiskPolicy();
const unavailable: ImpactSurfaceAssessment = { status: 'unavailable', reasonCode: 'provider_down', evidenceIds: [] };
const available: ImpactSurfaceAssessment = {
  status: 'available', capturedAt: '2026-09-12T00:00:00.000Z', expiresAt: '2026-09-12T00:05:00.000Z',
  affectedUsers: 0, errorRate: 0.01, baselineErrorRate: 0.01, currentQps: 10, peakQps: 20,
  downstreamHealthy: true, quality: 'complete', evidenceIds: [],
};

function profile(serviceLevel: ResolvedProfileSnapshot['serviceLevel'] = 'S1'): ResolvedProfileSnapshot {
  return {
    profileId: 'profile', revision: 'profile/v1', digest: 'sha256:v1:profile', serviceName: 'service', serviceLevel,
    timezone: 'UTC', allowedActions: ['action.drain'], forbiddenActions: ['action.drop'], changeFreezePeriods: [],
    impactPolicy: { unavailable: { S0: 'deny', S1: 'deny', S2: 'confirm', S3: 'confirm' } },
    policyVersion: 'risk/v2', capturedAt: '2026-09-12T00:00:00.000Z', source: 'resolved',
  };
}

function tool(kind: Tool['kind'], overrides: Partial<Tool> = {}): Tool {
  return { name: kind === 'action' ? 'action.drain' : 'query', description: kind, kind, inputSchema: z.object({}), ...overrides };
}

function evaluate(overrides: Partial<Parameters<DeterministicRiskPolicy['evaluate']>[0]> = {}) {
  return policy.evaluate({
    tool: tool('evidence'), profile: profile(), impact: available, findings: [], unavailableGuardians: [], ...overrides,
  });
}

describe('DeterministicRiskPolicy', () => {
  it('allows ordinary evidence with no findings', () => {
    expect(evaluate()).toMatchObject({ disposition: 'allow', severity: 'SAFE', requireConfirmation: false, policyVersion: 'risk/v2' });
  });

  it('requires confirmation for an allowed action instead of treating allowlist as preauthorization', () => {
    expect(evaluate({ tool: tool('action') })).toMatchObject({ disposition: 'confirm', requireConfirmation: true });
  });

  it('denies an unlisted or forbidden action even when another rule would only confirm', () => {
    expect(evaluate({ tool: tool('action', { name: 'action.unknown' }), findings: [finding('bash.destructive-command', 'CRITICAL', 'confirmable', 'action.unknown')] })).toMatchObject({ disposition: 'deny' });
    expect(evaluate({ tool: tool('action', { name: 'action.drop' }) })).toMatchObject({ disposition: 'deny' });
  });

  it('denies sensitive boundaries and confirms other high-risk findings', () => {
    expect(evaluate({ findings: [finding('mcp.sensitive-input', 'CRITICAL', 'sensitive', 'mcp.query')] })).toMatchObject({ disposition: 'deny' });
    expect(evaluate({ findings: [finding('profile.change-freeze', 'HIGH', 'frozen', 'action.drain')] })).toMatchObject({ disposition: 'deny' });
    expect(evaluate({ findings: [finding('bash.destructive-command', 'CRITICAL', 'destructive', 'bash')] })).toMatchObject({ disposition: 'deny' });
    expect(evaluate({ findings: [finding('risk.high', 'HIGH', 'needs review', 'query')] })).toMatchObject({ disposition: 'confirm', requireConfirmation: true });
  });

  it('allows evidence with unavailable impact but denies S1 action and confirms S3 action', () => {
    expect(evaluate({ impact: unavailable })).toMatchObject({ disposition: 'allow' });
    expect(evaluate({ tool: tool('action'), impact: unavailable })).toMatchObject({ disposition: 'deny' });
    expect(evaluate({ tool: tool('action', { name: 'action.drain' }), impact: unavailable, profile: profile('S3') })).toMatchObject({ disposition: 'confirm' });
  });

  it('treats unavailable Profile/Bash guardians as fail-closed', () => {
    expect(evaluate({ tool: tool('action'), unavailableGuardians: ['profile-policy'] })).toMatchObject({ disposition: 'deny' });
    expect(evaluate({ unavailableGuardians: ['bash-policy'] })).toMatchObject({ disposition: 'confirm' });
  });
});
