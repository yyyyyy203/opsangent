import {
  createAgentRuntime,
  type AgentRuntimeOptions,
  type RuntimeToolFactory,
  type RuntimeToolPorts,
} from '../application/create-runtime.js';
import type { Tool } from '../contracts/index.js';

export interface InspectionRuntimeOptions extends Omit<AgentRuntimeOptions, 'includeExternalBash' | 'actionMode'> {
  allowedToolNames: readonly string[];
}

/** A local allowlist is an operator decision; remote tool annotations cannot grant access. */
export function createInspectionRuntime(options: InspectionRuntimeOptions) {
  const allowed = new Set(options.allowedToolNames);
  const validateTool = (tool: Tool): Tool => {
    if (!allowed.has(tool.name) || tool.kind === 'action' || tool.call === undefined || /(^|[._-])bash($|[._-])/i.test(tool.name)) {
      throw new Error(`Tool is not permitted by the readonly inspection profile: ${tool.name}`);
    }
    return Object.freeze({ ...tool });
  };
  const tools = (options.tools ?? []).map(validateTool);
  const toolFactories: readonly RuntimeToolFactory[] | undefined = options.toolFactories?.map((factory) => {
    return (ports: RuntimeToolPorts) => factory(ports).map(validateTool);
  });
  const runtime = createAgentRuntime({
    ...options,
    tools,
    ...(toolFactories === undefined ? {} : { toolFactories }),
    includeExternalBash: false,
    actionMode: 'dry_run',
  });
  runtime.toolkit.freeze();
  return runtime;
}
