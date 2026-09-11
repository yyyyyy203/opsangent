import { describe, expect, it } from 'vitest';
import { checkpointChecksum } from '../src/contracts/stable-json.js';
import { parseAgentContext } from '../src/storage/durable-codec.js';

const timestamp = '2026-09-11T00:00:00.000Z';

function legacyContext(profileId = 'group-buy-market'): Record<string, unknown> {
  return {
    runId: 'run-1',
    status: 'running',
    stage: 'evidence_collection',
    profileId,
    messages: [],
    pendingToolCalls: [],
    confirmedToolCallIds: [],
    rejectedToolCallIds: [],
    executedActions: [],
    evidenceIds: [],
    missingEvidence: [],
    budget: {
      startedAt: timestamp,
      maxIterations: 8,
      iteration: 1,
      maxToolCalls: 16,
      toolCallsUsed: 0,
      maxDurationMs: 60_000,
    },
    contextVersion: 1,
  };
}

function governanceSnapshot(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profile: {
      profileId: 'group-buy-market',
      revision: 'profile/v7',
      digest: 'profile-digest-v7',
      serviceName: 'settlement',
      serviceLevel: 'S1',
      timezone: 'Asia/Shanghai',
      allowedActions: ['action.drain'],
      forbiddenActions: ['action.drop'],
      changeFreezePeriods: [],
      impactPolicy: {
        unavailable: { S0: 'deny', S1: 'deny', S2: 'confirm', S3: 'confirm' },
      },
      policyVersion: 'risk/v4',
      capturedAt: timestamp,
      source: 'resolved',
    },
    loop: {
      history: [],
      consecutiveCount: 0,
      level: 'none',
      blockedSignatures: [],
    },
    compression: {
      summaryVersion: 0,
      lastLevel: 'none',
      sourceMessageIds: [],
      protectedMessageIds: [],
      offloadedEvidenceIds: [],
    },
  };
}

describe('governance checkpoint contract', () => {
  it('migrates a legacy checkpoint into conservative governance defaults', () => {
    const parsed = parseAgentContext(legacyContext());

    expect(parsed).toMatchObject({
      governance: {
        schemaVersion: 1,
        profile: {
          profileId: 'group-buy-market',
          revision: 'legacy/v1',
          digest: checkpointChecksum({
            kind: 'legacy_profile_snapshot',
            profileId: 'group-buy-market',
            schemaVersion: 1,
            source: 'legacy_checkpoint',
          }),
          serviceName: 'group-buy-market',
          serviceLevel: 'S0',
          timezone: 'UTC',
          allowedActions: [],
          forbiddenActions: [],
          capturedAt: timestamp,
          source: 'legacy_checkpoint',
        },
        loop: { history: [], consecutiveCount: 0, level: 'none', blockedSignatures: [] },
        compression: {
          summaryVersion: 0,
          lastLevel: 'none',
          sourceMessageIds: [],
          protectedMessageIds: [],
          offloadedEvidenceIds: [],
        },
      },
    });
  });

  it('keeps an already persisted governance snapshot byte-for-byte stable', () => {
    const context = { ...legacyContext(), governance: governanceSnapshot() };

    expect(parseAgentContext(context).governance).toEqual(governanceSnapshot());
  });
});
