import type { DiagnosisStage, LoopState, Tool, ToolCall, ToolExecutionResult } from '../../contracts/index.js';

export interface LoopObservation {
  stage: DiagnosisStage;
  tool: Tool;
  call: ToolCall;
  result: ToolExecutionResult;
  stepId: string;
  recordedAt: string;
}

export interface LoopSignatures {
  callSignature: string;
  signature: string;
  signatureDigest: string;
}

export interface LoopIntervention {
  level: 'warn' | 'hard' | 'force_break';
  repeatCount: number;
  toolName: string;
  signatureDigest: string;
  action: 'hint_injected' | 'signature_blocked' | 'run_terminated';
  stage: DiagnosisStage;
  /** Internal call digest used by Admission; never emitted as an event field. */
  callSignature: string;
}

export interface LoopDecision extends LoopSignatures {
  state: LoopState;
  counted: boolean;
  intervention?: LoopIntervention;
}
