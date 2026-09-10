import { describe, expect, it } from 'vitest';
import type { Clock, EvidenceRecord, IdGenerator } from '../src/contracts/index.js';
import { EventFactoryV2 } from '../src/event/v2/event-factory.js';
import { EventPublisherV2, InMemoryProjectionFailureSink } from '../src/event/v2/event-publisher.js';
import { InMemoryEventMessageStore } from '../src/event/v2/in-memory-event-store.js';
import { ReplayBufferV2 } from '../src/event/v2/replay-buffer.js';
import { DefaultEvidenceRecorder } from '../src/application/evidence-recorder.js';
import { InMemoryEvidenceStore } from '../src/storage/in-memory-evidence-store.js';

const clock: Clock = { now: () => new Date('2026-09-10T00:00:00.000Z') };
let sequence = 0;
const ids: IdGenerator = { next: (prefix) => `${prefix}-${++sequence}` };

function request(): {
  record: EvidenceRecord;
  stepId: string;
  toolCallId: string;
  coverage: number;
  publicSummary: string;
} {
  return {
    record: {
      evidenceId: 'evidence-1',
      runId: 'run-1',
      source: 'metric',
      summary: { failureRate: 0.15 },
      raw: { marker: 'private-raw-evidence-marker' },
      businessTraceIds: [],
      capturedAt: '2026-09-10T00:00:00.000Z',
    },
    stepId: 'step-1',
    toolCallId: 'call-1',
    coverage: 1,
    publicSummary: '结算失败率超过阈值。',
  };
}

describe('DefaultEvidenceRecorder', () => {
  it('persists and reads back Evidence before publishing one safe EVIDENCE_COLLECTED event', async () => {
    const evidence = new InMemoryEvidenceStore();
    const eventStore = new InMemoryEventMessageStore();
    const publisher = new EventPublisherV2(eventStore, new ReplayBufferV2({ maxEvents: 10, maxBytes: 10_000 }), new InMemoryProjectionFailureSink());
    const observedAfterPersist: boolean[] = [];
    publisher.subscribe({
      name: 'evidence-order',
      project: async (event) => {
        if (event.type === 'EVIDENCE_COLLECTED') observedAfterPersist.push(await evidence.get('evidence-1') !== null);
      },
    });
    const recorder = new DefaultEvidenceRecorder({
      evidence,
      events: { factory: new EventFactoryV2(clock, ids), publisher, store: eventStore, correlationId: (runId) => `run:${runId}` },
    });

    const saved = await recorder.capture(request());
    await recorder.capture(request());
    const events = await eventStore.readRun('run-1', 0, 10);
    const collected = events.filter((event) => event.type === 'EVIDENCE_COLLECTED');

    expect(saved).toMatchObject({ evidenceId: 'evidence-1', toolCallId: 'call-1', raw: { marker: 'private-raw-evidence-marker' } });
    expect(observedAfterPersist).toEqual([true]);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ payload: { evidenceIds: ['evidence-1'], coverage: 1, source: 'metric' } });
    expect(JSON.stringify(collected)).not.toContain('private-raw-evidence-marker');
  });

  it('does not publish Evidence when persistence cannot be read back', async () => {
    const eventStore = new InMemoryEventMessageStore();
    const publisher = new EventPublisherV2(eventStore, new ReplayBufferV2({ maxEvents: 10, maxBytes: 10_000 }), new InMemoryProjectionFailureSink());
    const recorder = new DefaultEvidenceRecorder({
      evidence: { save: () => Promise.resolve(), get: () => Promise.resolve(null) },
      events: { factory: new EventFactoryV2(clock, ids), publisher, store: eventStore, correlationId: (runId) => `run:${runId}` },
    });

    await expect(recorder.capture(request())).rejects.toThrow();
    expect(await eventStore.readRun('run-1', 0, 10)).toEqual([]);
  });
});
