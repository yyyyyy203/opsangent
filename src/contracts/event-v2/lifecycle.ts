import { z } from 'zod';
import type { JsonValue } from '../common.js';
import { budgetTypeSchema, eventErrorPayloadV2Schema, eventStageSchema, identifierV2Schema, jsonRecordV2Schema, timestampV2Schema, type BudgetTypeV2, type EventErrorPayloadV2, type EventStageV2 } from './common.js';
import { messageRoleV2Schema, messageStatusV2Schema, type MessageRoleV2, type MessageStatusV2 } from '../message-v2/common.js';
import { messageBlockV2Schema } from '../message-v2/schema.js';
import type { MessageBlockV2 } from '../message-v2/blocks.js';
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const nonnegative = z.number().finite().nonnegative(); const positiveInteger = z.number().int().positive();
const contentBlockTypeV2Schema = z.enum([
  'text', 'reasoning_summary', 'tool_call', 'raw_tool_call', 'tool_result', 'evidence_ref', 'artifact_ref', 'image_ref',
  'context_summary', 'confirmation_request', 'confirmation_result', 'diagnosis', 'action_proposal', 'action_result', 'error',
]);
const usageSchema = strict({ inputTokens: nonnegative.int().optional(), outputTokens: nonnegative.int().optional(), cachedInputTokens: nonnegative.int().optional() });
export interface UsagePayloadV2 { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
export interface RunStartedPayloadV2 { profile: string; trigger: string; deadline: string; versionSnapshot: Record<string, JsonValue> }
export interface RunResumedPayloadV2 { checkpointVersion: string; resumeReason: string; newStreamId: string }
export interface RunPausedPayloadV2 { interruptId: string; reason: string; expiresAt: string; checkpointVersion: string }
export interface RunFinishedPayloadV2 { outcome: 'complete' | 'partial' | 'inconclusive'; finalText?: string; reportId?: string; usage?: UsagePayloadV2; durationMs: number }
export interface RunFailedPayloadV2 { error: EventErrorPayloadV2; stage: EventStageV2; recoverable: boolean }
export interface RunCancelledPayloadV2 { actor: string; reason: string; stage: EventStageV2 }
export interface RunTimedOutPayloadV2 { deadline: string; stage: EventStageV2; partialResultId?: string }
export interface RunBudgetWarningPayloadV2 { budgetType: BudgetTypeV2; used: number; limit: number; remaining: number }
export interface RunBudgetExhaustedPayloadV2 { budgetType: BudgetTypeV2; used: number; limit: number; exitPolicy: string }
export interface StepStartedPayloadV2 { iteration: number; stage: EventStageV2; budgetSnapshot: Record<string, JsonValue> }
export interface StepCompletedPayloadV2 { iteration: number; exitDecision: string; durationMs: number }
export interface StepFailedPayloadV2 { iteration: number; error: EventErrorPayloadV2; retryable: boolean }
export interface StageChangedPayloadV2 { from: EventStageV2; to: EventStageV2; reason: string }
export interface ReasoningStartedPayloadV2 { stage: EventStageV2; objective: string }
export const lifecycleEventPayloadSchemas = {
  RUN_STARTED: strict({ profile: identifierV2Schema, trigger: z.string().min(1), deadline: timestampV2Schema, versionSnapshot: jsonRecordV2Schema }),
  RUN_RESUMED: strict({ checkpointVersion: identifierV2Schema, resumeReason: z.string().min(1), newStreamId: identifierV2Schema }),
  RUN_PAUSED: strict({ interruptId: identifierV2Schema, reason: z.string().min(1), expiresAt: timestampV2Schema, checkpointVersion: identifierV2Schema }),
  RUN_FINISHED: strict({ outcome: z.enum(['complete', 'partial', 'inconclusive']), finalText: z.string().optional(), reportId: identifierV2Schema.optional(), usage: usageSchema.optional(), durationMs: nonnegative }),
  RUN_FAILED: strict({ error: eventErrorPayloadV2Schema, stage: eventStageSchema, recoverable: z.boolean() }),
  RUN_CANCELLED: strict({ actor: identifierV2Schema, reason: z.string().min(1), stage: eventStageSchema }),
  RUN_TIMED_OUT: strict({ deadline: timestampV2Schema, stage: eventStageSchema, partialResultId: identifierV2Schema.optional() }),
  RUN_BUDGET_WARNING: strict({ budgetType: budgetTypeSchema, used: nonnegative, limit: nonnegative, remaining: nonnegative }),
  RUN_BUDGET_EXHAUSTED: strict({ budgetType: budgetTypeSchema, used: nonnegative, limit: nonnegative, exitPolicy: z.string().min(1) }),
  STEP_STARTED: strict({ iteration: positiveInteger, stage: eventStageSchema, budgetSnapshot: jsonRecordV2Schema }),
  STEP_COMPLETED: strict({ iteration: positiveInteger, exitDecision: z.string().min(1), durationMs: nonnegative }),
  STEP_FAILED: strict({ iteration: positiveInteger, error: eventErrorPayloadV2Schema, retryable: z.boolean() }),
  STAGE_CHANGED: strict({ from: eventStageSchema, to: eventStageSchema, reason: z.string().min(1) }),
  REASONING_STARTED: strict({ stage: eventStageSchema, objective: z.string().min(1) }),
} as const;
export interface ModelCallStartedPayloadV2 { provider: string; model: string; purpose: string; attempt: number; inputSummary: string }
export interface ModelRetryScheduledPayloadV2 { attempt: number; reasonCode: string; delayMs: number; correctionChainId?: string }
export interface ModelFallbackActivatedPayloadV2 { fromProvider: string; fromModel: string; toProvider: string; toModel: string; reasonCode: string }
export interface ModelCallCompletedPayloadV2 { provider: string; model: string; attempt: number; usage?: UsagePayloadV2; cacheHit?: boolean; ttftMs?: number; durationMs: number; finishReason?: string }
export interface ModelCallFailedPayloadV2 { error: EventErrorPayloadV2; attempt: number; retryable: boolean; durationMs: number }
export const modelEventPayloadSchemas = {
  MODEL_CALL_STARTED: strict({ provider: identifierV2Schema, model: identifierV2Schema, purpose: z.string().min(1), attempt: positiveInteger, inputSummary: z.string().min(1) }),
  MODEL_RETRY_SCHEDULED: strict({ attempt: positiveInteger, reasonCode: identifierV2Schema, delayMs: nonnegative, correctionChainId: identifierV2Schema.optional() }),
  MODEL_FALLBACK_ACTIVATED: strict({ fromProvider: identifierV2Schema, fromModel: identifierV2Schema, toProvider: identifierV2Schema, toModel: identifierV2Schema, reasonCode: identifierV2Schema }),
  MODEL_CALL_COMPLETED: strict({ provider: identifierV2Schema, model: identifierV2Schema, attempt: positiveInteger, usage: usageSchema.optional(), cacheHit: z.boolean().optional(), ttftMs: nonnegative.optional(), durationMs: nonnegative, finishReason: z.string().min(1).optional() }),
  MODEL_CALL_FAILED: strict({ error: eventErrorPayloadV2Schema, attempt: positiveInteger, retryable: z.boolean(), durationMs: nonnegative }),
} as const;
export interface MessageStartedPayloadV2 { messageId: string; role: MessageRoleV2; status: MessageStatusV2 }
export type ContentBlockTypeV2 = MessageBlockV2['type'];
export interface ContentBlockStartedPayloadV2 { messageId: string; blockId: string; blockType: ContentBlockTypeV2; index: number }
export interface ContentBlockDeltaPayloadV2 { messageId: string; blockId: string; delta: string; index: number; blockType?: ContentBlockTypeV2 }
export interface ContentBlockCompletedPayloadV2 { messageId: string; blockId: string; blockSummary: string; index: number; block?: MessageBlockV2 }
export interface MessageCompletedPayloadV2 { messageId: string; usage?: UsagePayloadV2; completedAt: string; finishReason?: string }
export interface MessageFailedPayloadV2 { messageId: string; error: EventErrorPayloadV2 }
export const messageStreamEventPayloadSchemas = {
  MESSAGE_STARTED: strict({ messageId: identifierV2Schema, role: messageRoleV2Schema, status: messageStatusV2Schema }),
  CONTENT_BLOCK_STARTED: strict({ messageId: identifierV2Schema, blockId: identifierV2Schema, blockType: contentBlockTypeV2Schema, index: z.number().int().nonnegative() }),
  CONTENT_BLOCK_DELTA: strict({ messageId: identifierV2Schema, blockId: identifierV2Schema, delta: z.string(), index: z.number().int().nonnegative(), blockType: contentBlockTypeV2Schema.optional() }),
  CONTENT_BLOCK_COMPLETED: strict({ messageId: identifierV2Schema, blockId: identifierV2Schema, blockSummary: z.string().min(1), index: z.number().int().nonnegative(), block: messageBlockV2Schema.optional() }),
  MESSAGE_COMPLETED: strict({ messageId: identifierV2Schema, usage: usageSchema.optional(), completedAt: timestampV2Schema, finishReason: z.string().min(1).optional() }),
  MESSAGE_FAILED: strict({ messageId: identifierV2Schema, error: eventErrorPayloadV2Schema }),
} as const;
export interface EventV2PayloadMapSlice {
  RUN_STARTED: RunStartedPayloadV2; RUN_RESUMED: RunResumedPayloadV2; RUN_PAUSED: RunPausedPayloadV2; RUN_FINISHED: RunFinishedPayloadV2; RUN_FAILED: RunFailedPayloadV2; RUN_CANCELLED: RunCancelledPayloadV2; RUN_TIMED_OUT: RunTimedOutPayloadV2; RUN_BUDGET_WARNING: RunBudgetWarningPayloadV2; RUN_BUDGET_EXHAUSTED: RunBudgetExhaustedPayloadV2; STEP_STARTED: StepStartedPayloadV2; STEP_COMPLETED: StepCompletedPayloadV2; STEP_FAILED: StepFailedPayloadV2; STAGE_CHANGED: StageChangedPayloadV2; REASONING_STARTED: ReasoningStartedPayloadV2;
  MODEL_CALL_STARTED: ModelCallStartedPayloadV2; MODEL_RETRY_SCHEDULED: ModelRetryScheduledPayloadV2; MODEL_FALLBACK_ACTIVATED: ModelFallbackActivatedPayloadV2; MODEL_CALL_COMPLETED: ModelCallCompletedPayloadV2; MODEL_CALL_FAILED: ModelCallFailedPayloadV2;
  MESSAGE_STARTED: MessageStartedPayloadV2; CONTENT_BLOCK_STARTED: ContentBlockStartedPayloadV2; CONTENT_BLOCK_DELTA: ContentBlockDeltaPayloadV2; CONTENT_BLOCK_COMPLETED: ContentBlockCompletedPayloadV2; MESSAGE_COMPLETED: MessageCompletedPayloadV2; MESSAGE_FAILED: MessageFailedPayloadV2;
}
export const eventV2PayloadSchemas = { ...lifecycleEventPayloadSchemas, ...modelEventPayloadSchemas, ...messageStreamEventPayloadSchemas } as const;
export type EventV2PayloadType = keyof EventV2PayloadMapSlice;
export function parseEventV2Payload<T extends EventV2PayloadType>(
  type: T,
  payload: unknown,
): EventV2PayloadMapSlice[T] {
  const schema = eventV2PayloadSchemas[type] as unknown as z.ZodType<EventV2PayloadMapSlice[T]>;
  return schema.parse(payload);
}
