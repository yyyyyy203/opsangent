import type { AgentContext, AgentError, Clock, RawToolCall, ToolCall, ToolExecutionResult } from '../contracts/index.js';
import type { AdmissionGateRecord, ToolAdmission } from '../tool/admission.js';

export interface AdmittedToolBatch {
  calls: ToolCall[];
  rejected: ToolExecutionResult[];
  repairs: Array<{ toolCallId: string; stage: string; repairs: string[] }>;
  gates: Array<{ toolCallId: string; records: AdmissionGateRecord[] }>;
}

export type LoopCallBlocker = (call: ToolCall) => boolean;

export function admitToolBatch(
  candidates: Array<ToolCall | RawToolCall>, context: AgentContext, admission: ToolAdmission, clock: Clock, signal: AbortSignal,
  loopCallBlocker?: LoopCallBlocker,
): AdmittedToolBatch {
  const calls: ToolCall[] = [];
  const rejected: ToolExecutionResult[] = [];
  const repairs: Array<{ toolCallId: string; stage: string; repairs: string[] }> = [];
  const gates: AdmittedToolBatch['gates'] = [];
  const corrections = context.toolCorrections ??= {};
  const admitted = context.admittedToolCallIds ??= [];
  for (const candidate of candidates) {
    const key = `tool:${candidate.name}`;
    const previous = corrections[key];
    let error: AgentError | undefined;
    if (signal.aborted) error = { code: 'ABORTED', message: 'Run cancelled.', retryable: false };
    else if (context.budget.toolCallsUsed >= context.budget.maxToolCalls) error = { code: 'BUDGET_EXCEEDED', message: 'Tool call budget exhausted.', retryable: false };
    else {
      context.budget.toolCallsUsed += 1;
      if (admitted.includes(candidate.id)) error = { code: 'LOOP_DETECTED', message: 'Tool call ID has already been admitted.', retryable: false };
      else if ((previous?.failures ?? 0) >= 2) error = { code: 'LOOP_DETECTED', message: 'Model correction allowance exhausted.', retryable: false };
      else {
        try {
          const outcome = admission.validate(candidate);
          if (outcome.accepted) {
            if (loopCallBlocker?.(outcome.call) === true) {
              error = {
                code: 'LOOP_DETECTED',
                message: 'The same tool call signature is blocked after repeated execution.',
                retryable: false,
                details: { category: 'loop_detection', reason: 'same_call_signature_blocked' },
              };
              gates.push({
                toolCallId: candidate.id,
                records: [...outcome.gates, { gate: 'semantic_validation', outcome: 'rejected', errorCode: 'LOOP_DETECTED' }],
              });
            } else {
              gates.push({ toolCallId: candidate.id, records: outcome.gates });
              calls.push(outcome.call);
              admitted.push(candidate.id);
              if (outcome.repairs.length > 0) repairs.push({ toolCallId: candidate.id, stage: 'admission', repairs: outcome.repairs });
              continue;
            }
          } else {
            gates.push({ toolCallId: candidate.id, records: outcome.gates });
            error = outcome.error;
          }
        } catch {
          error = { code: 'TOOL_ERROR', message: 'Tool admission policy failed.', retryable: false };
        }
      }
    }
    const correctable = error.details?.retryableByModel === true;
    if (correctable) {
      const entry = corrections[key] ??= { firstCallId: candidate.id, failures: 0 };
      entry.failures += 1;
      error = { ...error, details: { ...error.details, correctionChainId: entry.firstCallId, remainingModelRetries: Math.max(0, 2 - entry.failures), retryableByModel: entry.failures < 2 } };
      if (entry.failures >= 2 && !context.missingEvidence.includes(`${candidate.name}: correction_exhausted`)) {
        context.missingEvidence.push(`${candidate.name}: correction_exhausted`);
      }
    }
    const now = clock.now().toISOString();
    rejected.push({ toolCallId: candidate.id, toolName: candidate.name, status: signal.aborted ? 'aborted' : 'failed', error, startedAt: now, finishedAt: now });
  }
  return { calls, rejected, repairs, gates };
}
