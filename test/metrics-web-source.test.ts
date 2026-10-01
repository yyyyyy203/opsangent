import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { createMetricsWebSource } from '../src/bootstrap/metrics-web-source.js';
import { ScriptedModel } from '../src/model/scripted-model.js';

const runtimes: Array<ReturnType<typeof createInspectionRuntime>> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  vi.restoreAllMocks();
});

describe('Web Metrics source composition', () => {
  it('registers only metrics_subagent and does not connect to MCP during bootstrap', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => (
      Promise.reject(new Error('MCP must not be contacted during bootstrap.'))
    ));
    const runtime = createInspectionRuntime({
      model: new ScriptedModel([]),
      workspaceRoots: [],
      allowedToolNames: ['metrics_subagent'],
      toolFactories: [
        (ports) => createMetricsWebSource(ports, {
          mcpUrl: 'http://127.0.0.1:1/mcp',
          model: new ScriptedModel([]),
        }),
      ],
    });
    runtimes.push(runtime);

    expect(runtime.toolkit.list().map((tool) => tool.name)).toEqual(['metrics_subagent']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
