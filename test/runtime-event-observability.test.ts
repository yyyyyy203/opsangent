import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/application/create-runtime.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { RecordingObservability } from './fixtures/recording-observability.js';

describe('runtime event observability port', () => {
  it('exports V2 spans without enabling direct Harness instrumentation', async () => {
    const exporter = new RecordingObservability();
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'done', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      eventObservability: exporter,
    });
    try {
      const result = await runtime.agent.reply({ runId: 'event-only-run', message: 'inspect', profileId: 'simulation' });

      expect(result.status).toBe('completed');
      expect(exporter.starts.some((span) => span.name === 'agent.run')).toBe(true);
      expect(exporter.starts.some((span) => span.name === 'inspection.run')).toBe(false);
      expect(exporter.starts.some((span) => span.name === 'model.reasoning')).toBe(false);
      expect('flushEventObservability' in runtime).toBe(true);
      if ('flushEventObservability' in runtime && typeof runtime.flushEventObservability === 'function') {
        await runtime.flushEventObservability();
      }
      expect(exporter.flushes).toBe(1);
    } finally {
      await runtime.close();
    }
    expect(exporter.flushes).toBe(2);
  });

  it('lets only the root runtime subscribe and flush for shared child events', async () => {
    const rootExporter = new RecordingObservability();
    const childExporter = new RecordingObservability();
    const root = createAgentRuntime({
      model: new ScriptedModel([{ text: 'root done', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      eventObservability: rootExporter,
    });
    const child = createAgentRuntime({
      model: new ScriptedModel([{ text: 'child done', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      checkpoints: root.checkpoints,
      evidence: root.evidence,
      evidenceRecorder: root.evidenceRecorder,
      sharedEvents: root.sharedEvents,
      eventObservability: childExporter,
    });

    try {
      await child.agent.reply({ runId: 'shared-child-run', message: 'inspect', profileId: 'simulation' });

      expect(rootExporter.starts.filter((span) => span.name === 'agent.run' && span.runId === 'shared-child-run')).toHaveLength(1);
      expect(childExporter.starts).toHaveLength(0);
      expect('flushEventObservability' in child).toBe(true);
      if ('flushEventObservability' in child && typeof child.flushEventObservability === 'function') {
        await child.flushEventObservability();
      }
      expect(childExporter.flushes).toBe(0);
      expect('flushEventObservability' in root).toBe(true);
    } finally {
      await child.close();
      await root.close();
    }
    expect(childExporter.flushes).toBe(0);
    expect(rootExporter.flushes).toBe(1);
  });

  it('keeps the original observability injection compatible with both legacy and V2 spans', async () => {
    const observability = new RecordingObservability();
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'done', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      observability,
    });
    try {
      await runtime.agent.reply({ runId: 'legacy-compatible-run', message: 'inspect', profileId: 'simulation' });
      expect(observability.starts.some((span) => span.name === 'inspection.run')).toBe(true);
      expect(observability.starts.some((span) => span.name === 'agent.run')).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('routes V2 projection to eventObservability when both observer ports are supplied', async () => {
    const legacy = new RecordingObservability();
    const eventExporter = new RecordingObservability();
    const runtime = createAgentRuntime({
      model: new ScriptedModel([{ text: 'done', toolCalls: [] }]),
      workspaceRoots: [],
      includeExternalBash: false,
      observability: legacy,
      eventObservability: eventExporter,
    });
    try {
      await runtime.agent.reply({ runId: 'separate-observer-ports', message: 'inspect', profileId: 'simulation' });
      expect(legacy.starts.some((span) => span.name === 'inspection.run')).toBe(true);
      expect(legacy.starts.some((span) => span.name === 'agent.run')).toBe(false);
      expect(eventExporter.starts.some((span) => span.name === 'agent.run')).toBe(true);
      expect(eventExporter.starts.some((span) => span.name === 'inspection.run')).toBe(false);
    } finally {
      await runtime.close();
    }
  });
});
