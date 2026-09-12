import type { LoopState } from '../../contracts/index.js';
import { createLoopSignatures } from './signatures.js';
import type { LoopDecision, LoopIntervention, LoopObservation } from './types.js';

const MAX_HISTORY = 100;

export function isCountableLoopResult(result: LoopObservation['result']): boolean {
  if (result.status === 'success' || result.status === 'failed' || result.status === 'timeout') return true;
  if (result.status !== 'skipped') return false;
  return result.response?.blocks.some((block) => (
    block.type === 'json'
      && typeof block.value === 'object'
      && block.value !== null
      && (block.value as Record<string, unknown>).reason === 'already_executed'
  )) === true;
}

export function recordLoopSample(state: LoopState, input: LoopObservation): LoopDecision {
  const signatures = createLoopSignatures(input);
  if (!isCountableLoopResult(input.result)) {
    return { ...signatures, state: cloneState(state), counted: false };
  }

  const repeatCount = state.lastSignature === signatures.signature ? state.consecutiveCount + 1 : 1;
  const level = repeatCount >= 7
    ? 'force_break'
    : repeatCount >= 5
      ? 'hard'
      : repeatCount >= 3
        ? 'warn'
        : 'none';
  const nextState: LoopState = {
    history: [
      ...state.history,
      {
        signature: signatures.signature,
        toolName: input.tool.name,
        stage: input.stage,
        status: loopSampleStatus(input.result.status),
        stepId: input.stepId,
        recordedAt: input.recordedAt,
      },
    ].slice(-MAX_HISTORY),
    lastSignature: signatures.signature,
    consecutiveCount: repeatCount,
    level,
    blockedSignatures: [...state.blockedSignatures],
  };
  if (repeatCount >= 5 && !nextState.blockedSignatures.includes(signatures.callSignature)) {
    nextState.blockedSignatures.push(signatures.callSignature);
  }

  const intervention = interventionAt(repeatCount, input, signatures.signature, signatures.callSignature);
  return { ...signatures, state: nextState, counted: true, ...(intervention === undefined ? {} : { intervention }) };
}

function loopSampleStatus(status: LoopObservation['result']['status']): 'success' | 'failed' | 'timeout' | 'skipped' {
  return status === 'success' || status === 'failed' || status === 'timeout' || status === 'skipped' ? status : 'failed';
}

export function isLoopCallBlocked(state: LoopState, callSignature: string): boolean {
  return state.blockedSignatures.includes(callSignature);
}

function interventionAt(
  repeatCount: number,
  input: LoopObservation,
  signatureDigest: string,
  callSignature: string,
): LoopIntervention | undefined {
  if (repeatCount === 3) return {
    level: 'warn', repeatCount, toolName: input.tool.name, signatureDigest,
    action: 'hint_injected', stage: input.stage, callSignature,
  };
  if (repeatCount === 5) return {
    level: 'hard', repeatCount, toolName: input.tool.name, signatureDigest,
    action: 'signature_blocked', stage: input.stage, callSignature,
  };
  if (repeatCount === 7) return {
    level: 'force_break', repeatCount, toolName: input.tool.name, signatureDigest,
    action: 'run_terminated', stage: input.stage, callSignature,
  };
  return undefined;
}

function cloneState(state: LoopState): LoopState {
  return {
    history: state.history.map((sample) => ({ ...sample })),
    ...(state.lastSignature === undefined ? {} : { lastSignature: state.lastSignature }),
    consecutiveCount: state.consecutiveCount,
    level: state.level,
    blockedSignatures: [...state.blockedSignatures],
  };
}
