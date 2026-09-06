import type {
  AgentContext,
  AgentError,
  ResolvedRisk,
  SerializableInterrupt,
  ToolCall,
  Tool,
  ToolExecutionResult,
} from '../contracts/index.js';

export interface HookContext {
  context: AgentContext;
  stepId: string;
  toolCall: ToolCall;
  tool: Tool;
  input: Record<string, unknown>;
  risk: ResolvedRisk;
  result?: ToolExecutionResult;
}

export type HookResult =
  | { type: 'continue'; modifiedInput?: Record<string, unknown> }
  | { type: 'interrupt'; interrupt: SerializableInterrupt }
  | { type: 'abort'; error: AgentError };

export interface ToolHook {
  readonly id: string;
  matches(context: HookContext): boolean;
  beforeExecute?(context: HookContext): Promise<HookResult>;
  afterExecute?(context: HookContext): Promise<HookResult>;
}
