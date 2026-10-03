import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { createMetricsWebSource } from '../src/bootstrap/metrics-web-source.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import type { RuntimeToolPorts } from '../src/application/create-runtime.js';

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
});
