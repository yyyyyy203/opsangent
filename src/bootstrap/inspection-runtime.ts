import { createAgentRuntime, type AgentRuntimeOptions } from '../application/create-runtime.js';

export interface InspectionRuntimeOptions extends Omit<AgentRuntimeOptions, 'includeExternalBash' | 'actionMode'> {
  allowedToolNames: readonly string[];
}

/** A local allowlist is an operator decision; remote tool annotations cannot grant access. */
export function createInspectionRuntime(options: InspectionRuntimeOptions) {
  const allowed = new Set(options.allowedToolNames);
  const tools = (options.tools ?? []).map((tool) => {
    if (!allowed.has(tool.name) || tool.kind === 'action' || tool.call === undefined || /(^|[._-])bash($|[._-])/i.test(tool.name)) {
      throw new Error(`Tool is not permitted by the readonly inspection profile: ${tool.name}`);
    }
    return Object.freeze({ ...tool });
  });
  const runtime = createAgentRuntime({ ...options, tools, includeExternalBash: false, actionMode: 'dry_run' });
  runtime.toolkit.freeze();
  return runtime;
}
