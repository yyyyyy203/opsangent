import type {
  AgentContext,
  AgentError,
  Tool,
  ToolCall,
  ToolExecutionJournal,
  ToolExecutionRecord,
  ToolExecutionResult,
  ToolRecoveryPolicy,
} from '../contracts/index.js';
import { checkpointChecksum } from '../contracts/index.js';
import { toolInputDigest, validateToolInput } from '../tool/schema.js';
import type { Toolkit } from '../tool/toolkit.js';

interface CompletedRecoveryResult {
  result: ToolExecutionResult;
  execution?: ToolExecutionRecord;
}

export type PendingBatchRecoveryPlan =
  | { type: 'none' }
  | { type: 'complete'; completed: CompletedRecoveryResult[] }
  | { type: 'execute'; calls: ToolCall[]; completed: CompletedRecoveryResult[] }
  | { type: 'verification_required'; call: ToolCall; execution: ToolExecutionRecord; completed: CompletedRecoveryResult[] }
  | { type: 'uncertain'; call: ToolCall; execution: ToolExecutionRecord; completed: CompletedRecoveryResult[] }
  | { type: 'storage_error'; error: AgentError };

export interface PlanPendingBatchRecoveryOptions {
  context: AgentContext;
  toolkit: Toolkit;
  executions: ToolExecutionJournal;
  now: string;
}

/**
 * Produces a recovery plan without executing a persisted call.  Only the
 * caller may route an explicitly replay-safe, currently registered call back
 * through the normal execution pipeline.
 */
export async function planPendingBatchRecovery(
  options: PlanPendingBatchRecoveryOptions,
): Promise<PendingBatchRecoveryPlan> {
  const batch = options.context.pendingToolBatch;
  if (batch === undefined) return { type: 'none' };

  const completed: CompletedRecoveryResult[] = [];
  const completedByCall = new Map(batch.completedResults.map((result) => [result.toolCallId, result]));
  const callsToExecute: ToolCall[] = [];

  for (const call of batch.calls) {
    const completedResult = completedByCall.get(call.id);
    if (completedResult !== undefined) {
      completed.push({ result: completedResult });
      continue;
    }

    const tool = options.toolkit.get(call.name);
    const execution = await options.executions.get(call.id);
    if (execution !== null) {
      const identityError = validateExecutionIdentity(options.context, batch.stepId, call, execution, tool);
      if (identityError !== undefined) return { type: 'storage_error', error: identityError };
      if (execution.state === 'succeeded' || execution.state === 'failed') {
        if (execution.result === undefined) {
          return { type: 'storage_error', error: storageError(`Terminal execution is missing a result: ${call.id}`) };
        }
        completed.push({ result: execution.result, execution });
        continue;
      }
      if (execution.state === 'uncertain') return { type: 'uncertain', call, execution, completed };

      if (tool === undefined) {
        if (execution.toolKind === 'action') return { type: 'uncertain', call, execution, completed };
        completed.push({ result: unavailableToolResult(call, options.now) });
        continue;
      }
      const validated = validateCurrentToolCall(tool, call, options.now);
      if ('result' in validated) {
        completed.push({ result: validated.result });
        continue;
      }
      switch (recoveryPolicy(tool)) {
        case 'replay_safe':
          callsToExecute.push(validated.call);
          continue;
        case 'verify_before_retry':
          return { type: 'verification_required', call: validated.call, execution, completed };
        case 'never_replay':
          return { type: 'uncertain', call: validated.call, execution, completed };
      }
    }

    const externallyCompleted = resultFromMessages(options.context, call.id);
    if (externallyCompleted !== undefined) {
      completed.push({ result: externallyCompleted });
      continue;
    }
    if (tool === undefined) {
      completed.push({ result: unavailableToolResult(call, options.now) });
      continue;
    }
    const validated = validateCurrentToolCall(tool, call, options.now);
    if ('result' in validated) {
      completed.push({ result: validated.result });
      continue;
    }
    callsToExecute.push(validated.call);
  }

  return callsToExecute.length === 0
    ? { type: 'complete', completed }
    : { type: 'execute', calls: callsToExecute, completed };
}

function validateExecutionIdentity(
  context: AgentContext,
  stepId: string,
  call: ToolCall,
  execution: ToolExecutionRecord,
  tool: Tool | undefined,
): AgentError | undefined {
  const inputDigest = tool === undefined ? checkpointChecksum(call.input) : toolInputDigest(tool, call);
  if (execution.runId !== context.runId
    || execution.stepId !== stepId
    || execution.toolName !== call.name
    || execution.inputDigest !== inputDigest) {
    return storageError(`Execution journal identity does not match pending call: ${call.id}`);
  }
  return undefined;
}

function validateCurrentToolCall(
  tool: Tool,
  call: ToolCall,
  now: string,
): { call: ToolCall } | { result: ToolExecutionResult } {
  const validation = validateToolInput(tool, call.input);
  if (!validation.valid || validation.value === undefined) {
    return { result: failedResult(call, now, validation.error ?? {
      code: 'INVALID_INPUT', message: `Recovered input is invalid for ${call.name}.`, retryable: false,
    }) };
  }
  const semantics = tool.validateSemantics?.(validation.value);
  if (semantics !== undefined && !semantics.valid) return { result: failedResult(call, now, semantics.error) };
  return { call: { ...call, input: semantics?.value ?? validation.value } };
}

function recoveryPolicy(tool: Tool): ToolRecoveryPolicy {
  if (tool.recoveryPolicy !== undefined) return tool.recoveryPolicy;
  return tool.kind === 'action' ? 'never_replay' : 'verify_before_retry';
}

function unavailableToolResult(call: ToolCall, now: string): ToolExecutionResult {
  return failedResult(call, now, {
    code: 'TOOL_NOT_FOUND', message: `Recovered tool is no longer registered: ${call.name}`, retryable: false,
  });
}

function failedResult(call: ToolCall, now: string, error: AgentError): ToolExecutionResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    status: 'failed',
    error,
    startedAt: now,
    finishedAt: now,
  };
}

function resultFromMessages(context: AgentContext, toolCallId: string): ToolExecutionResult | undefined {
  for (const message of context.messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_result' || block.result.toolCallId !== toolCallId) continue;
      if (block.result.status !== 'interrupted' && block.result.status !== 'awaiting_external') return block.result;
    }
  }
  return undefined;
}

function storageError(message: string): AgentError {
  return { code: 'STORAGE_ERROR', message, retryable: false, details: { category: 'checkpoint_conflict' } };
}
