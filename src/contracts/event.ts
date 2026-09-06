import type { AgentError } from './errors.js';
import type { SerializableInterrupt } from './hitl.js';
import type { ToolCall, ToolExecutionResult } from './tool.js';

export type AgentEventType =
  | 'RUN_STARTED' | 'STEP_STARTED' | 'REASONING_STARTED' | 'TEXT_DELTA'
  | 'TOOL_CALL_CREATED' | 'TOOL_STARTED' | 'TOOL_RESULT' | 'EVIDENCE_COLLECTED'
  | 'TOOL_PROGRESS' | 'EXTERNAL_TOOL_REQUESTED' | 'REQUIRE_CONFIRM'
  | 'CONTEXT_COMPRESSED' | 'RUN_PAUSED' | 'RUN_FINISHED' | 'RUN_FAILED';

export type AgentEventPayload = Record<string, unknown> | ToolCall | ToolExecutionResult | SerializableInterrupt | AgentError;

export interface AgentEvent {
  schemaVersion: 1;
  type: AgentEventType;
  runId: string;
  stepId?: string;
  timestamp: string;
  payload: AgentEventPayload;
}

export interface EventSink {
  publish(event: AgentEvent): Promise<void> | void;
}
