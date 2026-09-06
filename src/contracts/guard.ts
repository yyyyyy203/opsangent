import type { RiskSeverity, Tool, ToolCall } from './tool.js';

export interface Finding {
  ruleId: string;
  severity: RiskSeverity;
  description: string;
  toolName: string;
  metadata?: Record<string, unknown>;
}

export interface GuardInput {
  runId: string;
  tool: Tool;
  toolCall: ToolCall;
}

export interface Guardian {
  readonly id: string;
  inspect(input: GuardInput): Promise<Finding[]>;
}

export interface ResolvedRisk {
  severity: RiskSeverity;
  requireConfirmation: boolean;
  findings: Finding[];
}
