import type { AgentContext, AgentEvent } from '../contracts/index.js';

export interface ReplyOptions {
  message: string;
  profileId: string;
  runId?: string;
  signal?: AbortSignal;
  maxIterations?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
}

export interface DiagnosisRunResult {
  runId: string;
  status: AgentContext['status'];
  finalText: string;
  contextVersion: number;
}

export interface DiagnosisAgent {
  reply(options: ReplyOptions): Promise<DiagnosisRunResult>;
  replyStream(options: ReplyOptions): AsyncGenerator<AgentEvent, DiagnosisRunResult>;
  resumeStream(runId: string, signal?: AbortSignal): AsyncGenerator<AgentEvent, DiagnosisRunResult>;
}
