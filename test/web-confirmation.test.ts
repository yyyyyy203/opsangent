import { describe, expect, it, vi } from 'vitest';
import type { AgentContext, Clock, StoredRunCheckpoint } from '../src/index.js';
import { WebConfirmationService } from '../src/application/web-confirmation-service.js';
import { HitlService } from '../src/application/hitl-service.js';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { startInspectionHttpServer } from '../src/api/http-server.js';

const timestamp = '2026-10-01T00:00:00.000Z';
const clock: Clock = { now: () => new Date(timestamp) };

function stored(revision: number, status: AgentContext['status'] = 'awaiting_confirmation'): StoredRunCheckpoint {
  return {
    revision,
    savedAt: timestamp,
    checksum: 'sha256:v1:test',
    context: {
      status,
      pendingInterrupt: {
        hookId: 'risk-action', interruptType: 'confirmation', toolCallId: 'call-1', payload: { summary: 'Review action' }, createdAt: timestamp,
      },
    } as unknown as AgentContext,
  };
}

describe('WebConfirmationService', () => {
  it('binds the decision to the loaded checkpoint revision and returns the new revision', async () => {
    const before = stored(7);
    const after = stored(8, 'running');
    const checkpoints = { load: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after), save: vi.fn() };
    const hitl = { decideWithResult: vi.fn().mockResolvedValue('approved') } as unknown as HitlService;
    const service = new WebConfirmationService(hitl, checkpoints, clock, 'browser-operator');

    await expect(service.decide('run-1', { toolCallId: 'call-1', confirmed: true, expectedRevision: 7 }))
      .resolves.toEqual({ outcome: 'approved', revision: 8 });
    expect(hitl.decideWithResult).toHaveBeenCalledWith({
      runId: 'run-1', toolCallId: 'call-1', confirmed: true, expectedRevision: 7,
      actor: 'browser-operator', decidedAt: timestamp,
    });
  });

  it('rejects stale revisions before invoking the HITL mutation', async () => {
    const hitl = { decideWithResult: vi.fn() } as unknown as HitlService;
    const service = new WebConfirmationService(hitl, { load: vi.fn().mockResolvedValue(stored(8)), save: vi.fn() }, clock);

    await expect(service.decide('run-1', { toolCallId: 'call-1', confirmed: true, expectedRevision: 7 }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT', statusCode: 409 });
    expect(hitl.decideWithResult).not.toHaveBeenCalled();
  });

  it('preserves expired as a result state rather than reporting approval', async () => {
    const hitl = { decideWithResult: vi.fn().mockResolvedValue('expired') } as unknown as HitlService;
    const checkpoints = { load: vi.fn().mockResolvedValueOnce(stored(2)).mockResolvedValueOnce(stored(3, 'running')), save: vi.fn() };
    const service = new WebConfirmationService(hitl, checkpoints, clock);

    await expect(service.decide('run-1', { toolCallId: 'call-1', confirmed: true, expectedRevision: 2 }))
      .resolves.toEqual({ outcome: 'expired', revision: 3 });
  });

  it('exposes confirmation commands as an explicit HTTP command, without resuming automatically', async () => {
    const runtime = createAgentRuntime({ model: new ScriptedModel([]), workspaceRoots: [] });
    const decide = vi.fn().mockResolvedValue({ outcome: 'rejected', revision: 4 });
    const server = await startInspectionHttpServer({
      agent: runtime.agent,
      events: runtime.eventStreamV2,
      queries: { getRun: vi.fn().mockResolvedValue({ runId: 'run-1' }) } as never,
      confirmation: { decide },
    });
    try {
      const response = await fetch(`${server.url}/runs/run-1/confirmation`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolCallId: 'call-1', confirmed: false, expectedRevision: 3, reason: 'reject' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: 'rejected', revision: 4 });
      expect(decide).toHaveBeenCalledWith('run-1', { toolCallId: 'call-1', confirmed: false, expectedRevision: 3, reason: 'reject' });
    } finally {
      await server.close();
    }
  });
});
