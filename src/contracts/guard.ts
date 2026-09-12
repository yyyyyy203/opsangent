import type { ImpactSurfaceAssessment, ResolvedProfileSnapshot, RiskPolicyInput, RiskDecision } from './governance.js';
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
  stepId?: string;
  tool: Tool;
  toolCall: ToolCall;
  /** Optional for legacy Guardian callers; governance execution always supplies it. */
  profile?: ResolvedProfileSnapshot;
  /** Optional for legacy Guardian callers; governance execution always supplies it. */
  impact?: ImpactSurfaceAssessment;
}

export interface Guardian {
  readonly id: string;
  matches?(input: GuardInput): boolean;
  inspect(input: GuardInput): Promise<Finding[]>;
}

export interface GovernanceGuardInput extends GuardInput {
  stepId: string;
  profile: ResolvedProfileSnapshot;
  impact: ImpactSurfaceAssessment;
  signal: AbortSignal;
  deadline: number;
}

export interface GuardianInspection {
  findings: Finding[];
  unavailableGuardians: string[];
}

export interface GuardianCoordinator {
  inspect(input: GovernanceGuardInput): Promise<GuardianInspection>;
}

export type RiskPolicy = {
  evaluate(input: RiskPolicyInput): RiskDecision;
};

export interface ResolvedRisk {
  severity: RiskSeverity;
  requireConfirmation: boolean;
  findings: Finding[];
  disposition?: RiskDecision['disposition'];
  policyVersion?: string;
}
