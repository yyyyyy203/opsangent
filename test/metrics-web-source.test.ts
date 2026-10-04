import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { createMetricsWebSource } from '../src/bootstrap/metrics-web-source.js';
import { stableSourceChildRunId } from '../src/bootstrap/source-subagent-identity.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import type { RuntimeToolPorts } from '../src/application/create-runtime.js';
import type { Tool, ToolResponse } from '../src/contracts/index.js';
import { RecordingObservability } from './fixtures/recording-observability.js';

const runtimes: Array<ReturnType<typeof createInspectionRuntime>> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  vi.restoreAllMocks();
});

describe('Web Metrics source composition', () => {
  it('registers only metrics_subagent, leaves the optional Logs data plane absent, and does not connect during bootstrap', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => (
      Promise.reject(new Error('MCP must not be contacted during bootstrap.'))
    ));
    let capturedPorts: RuntimeToolPorts | undefined;
    const runtime = createInspectionRuntime({
      model: new ScriptedModel([]),
      workspaceRoots: [],
      allowedToolNames: ['metrics_subagent'],
      toolFactories: [
        (ports) => {
          capturedPorts = ports;
          return createMetricsWebSource(ports, {
          mcpUrl: 'http://127.0.0.1:1/mcp',
          model: new ScriptedModel([]),
          });
        },
      ],
    });
    runtimes.push(runtime);
    await runtime.ready;

    expect(runtime.toolkit.list().map((tool) => tool.name)).toEqual(['metrics_subagent']);
    expect(capturedPorts).toBeDefined();
    expect(capturedPorts?.evidenceBlobs).toBeUndefined();
    expect(capturedPorts?.evidenceManifests).toBeUndefined();
    expect(capturedPorts?.streamingEvidenceRecorder).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes an explicit child model identity into the shared Metrics child runtime', async () => {
    const exporter = new RecordingObservability();
    const childRunId = stableSourceChildRunId('metrics', 'metrics-parent-run', 'metrics-tool-call');
    const runtime = createInspectionRuntime({
      model: new ScriptedModel([]),
      workspaceRoots: [],
      allowedToolNames: ['metrics_subagent'],
      eventObservability: exporter,
      clock: { now: () => new Date('2026-10-04T12:00:00.000Z') },
      toolFactories: [(ports) => createMetricsWebSource(ports, {
        mcpUrl: 'http://127.0.0.1:1/mcp',
        model: new ScriptedModel([{ text: '不请求来源数据。', toolCalls: [] }]),
        modelIdentity: { provider: 'metrics-provider', model: 'metrics-child-model' },
      })],
    });
    runtimes.push(runtime);
    const tool = runtime.toolkit.get('metrics_subagent');
    if (tool === undefined) throw new Error('Metrics parent Tool missing');

    await drainTool(tool, {
      profileId: 'simulation', service: 'checkout',
      start: '2026-10-04T11:55:00.000Z', end: '2026-10-04T12:00:00.000Z',
      question: '检查结算指标',
    }, 'metrics-parent-run');

    const modelSpan = exporter.starts.find((span) => span.runId === childRunId && span.kind === 'llm');
    expect(modelSpan).toMatchObject({
      name: 'model.metrics-child-model',
      attributes: { provider: 'metrics-provider', model: 'metrics-child-model' },
    });
  });

  it('does not inherit the parent identity for an independent child model without explicit identity', async () => {
    const exporter = new RecordingObservability();
    const childRunId = stableSourceChildRunId('metrics', 'independent-parent-run', 'metrics-tool-call');
    const runtime = createInspectionRuntime({
      model: new ScriptedModel([]),
      modelProvider: 'parent-provider',
      modelName: 'parent-model',
      workspaceRoots: [],
      allowedToolNames: ['metrics_subagent'],
      eventObservability: exporter,
      clock: { now: () => new Date('2026-10-04T12:00:00.000Z') },
      toolFactories: [(ports) => createMetricsWebSource(ports, {
        mcpUrl: 'http://127.0.0.1:1/mcp',
        model: new ScriptedModel([{ text: '不请求来源数据。', toolCalls: [] }]),
      })],
    });
    runtimes.push(runtime);
    const tool = runtime.toolkit.get('metrics_subagent');
    if (tool === undefined) throw new Error('Metrics parent Tool missing');

    await drainTool(tool, {
      profileId: 'simulation', service: 'checkout',
      start: '2026-10-04T11:55:00.000Z', end: '2026-10-04T12:00:00.000Z',
      question: '检查结算指标',
    }, 'independent-parent-run');

    const modelSpan = exporter.starts.find((span) => span.runId === childRunId && span.kind === 'llm');
    expect(modelSpan).toMatchObject({
      name: 'model.configured',
      attributes: { provider: 'configured', model: 'configured' },
    });
  });
});

async function drainTool(tool: Tool, input: Record<string, unknown>, runId: string): Promise<ToolResponse> {
  const returned = tool.call?.(input, {
    toolCallId: 'metrics-tool-call', runId, stepId: 'step-1', profileId: 'simulation',
    signal: new AbortController().signal, mode: 'dry_run', remainingToolCalls: 8,
  });
  if (returned === undefined || typeof returned !== 'object' || !(Symbol.asyncIterator in returned)) {
    throw new Error('expected Metrics Subagent streaming Tool');
  }
  const stream = returned as AsyncGenerator<unknown, ToolResponse>;
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
