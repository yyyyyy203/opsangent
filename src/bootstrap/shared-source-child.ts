import type { ChatModel, CheckpointStore, EvidenceStore, Tool } from '../contracts/index.js';
import type { EvidenceRecorder } from '../application/evidence-recorder.js';
import type { SharedRuntimeEventPorts } from '../application/runtime-ports.js';
import { createInspectionRuntime } from './inspection-runtime.js';
import type { SourceChildAgentFactory } from '../application/source-subagent-runner.js';

export interface SharedSourceChildFactoryOptions {
  model: ChatModel;
  workspaceRoots: readonly string[];
  checkpoints: CheckpointStore;
  evidence: EvidenceStore;
  evidenceRecorder: EvidenceRecorder;
  sharedEvents: SharedRuntimeEventPorts;
}

export function createSharedSourceChildAgentFactory(
  options: SharedSourceChildFactoryOptions,
): SourceChildAgentFactory {
  return {
    create: (input) => {
      const tools = [...input.tools];
      const runtime = createInspectionRuntime({
        model: options.model,
        workspaceRoots: [...options.workspaceRoots],
        tools,
        allowedToolNames: tools.map((tool: Tool) => tool.name),
        checkpoints: options.checkpoints,
        evidence: options.evidence,
        evidenceRecorder: options.evidenceRecorder,
        eventMessageStore: options.sharedEvents.store,
        sharedEvents: options.sharedEvents,
        includeExternalBash: false,
        actionMode: 'dry_run',
      });
      return runtime.agent;
    },
  };
}
